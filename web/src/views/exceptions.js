// Exceptions (Plant Manager): flagged clock-ins, missed clock-ins and handover mismatches, with photos.
import { get, post } from "../api.js";
import { plantName } from "../state.js";
import { esc, pill, on, toast, fmtDayW, fmtTime, dialog, closeDialog } from "../ui.js";

const FLAG = {
  late: "Late", outside_boundary: "Outside the plant boundary", no_location: "No location", shared_phone: "Same phone as a colleague",
  not_rostered: "Not on the roster", out_without_in: "Clocked out without clocking in", left_early: "Left early", low_gps_accuracy: "Location not precise",
  kiosk_photo_review: "Kiosk photo to check", boundary_not_set: "Plant boundary not set",
};
const flagText = (s) => s.split(", ").map((f) => FLAG[f] ?? f.replace(/_/g, " ")).join(", ");
const plantDay = (iso) => new Date(Date.parse(iso) + 3 * 3600_000).toISOString().slice(0, 10);

export async function exceptionsView(main, app) {
  const x = await get("/api/exceptions");
  const flagged = x.attendance.filter((a) => a.kind === "flagged"), missing = x.attendance.filter((a) => a.kind === "no_clock_in");
  // Which flagged clock-ins have photos (kiosk clock-ins do)
  const events = flagged.length ? await get(`/api/clock-events?from=${plantDay(flagged.at(-1).at)}&to=${plantDay(new Date(Date.now() + 86_400_000).toISOString())}`) : [];
  const photo = new Set(events.filter((e) => e.has_photo).map((e) => e.id));

  main.innerHTML = `<div class="head"><div><h1>Exceptions</h1><p class="sub">Clock-ins to check. Kiosk clock-ins carry a photo so you can see who was really there.</p></div></div>
  <div class="counts panel"><div><b>${flagged.length}</b><span>Flagged clock-ins</span></div><div><b>${missing.length}</b><span>Missed clock-ins, last 31 days</span></div><div><b>${x.handovers.length}</b><span>Handover mismatches</span></div><div><b>${x.phones.length}</b><span>Phones to approve</span></div></div>
  <section class="panel"><h2>Flagged clock-ins</h2>
    ${flagged.length ? `<div class="tablewrap"><table><thead><tr><th>When</th><th>Who</th><th>Plant</th><th>Why</th><th></th></tr></thead><tbody>${flagged.map((a) => `<tr>
      <td>${esc(fmtDayW(plantDay(a.at)))} ${fmtTime(a.at)}</td><td><b>${esc(a.full_name)}</b></td><td>${esc(plantName(a.plant_id))}</td><td>${esc(flagText(a.detail))}</td>
      <td><div class="actions" style="justify-content:flex-end">${photo.has(a.clock_event_id) ? `<img class="photo-thumb" alt="Clock-in photo of ${esc(a.full_name)}" src="/api/photos/${a.clock_event_id}" data-act="photo" data-id="${a.clock_event_id}" data-name="${esc(a.full_name)}">` : ""}
        <button class="btn sm" data-act="review" data-id="${a.clock_event_id}" data-name="${esc(a.full_name)}">Mark checked</button></div></td></tr>`).join("")}</tbody></table></div>` : `<p class="empty">No flagged clock-ins.</p>`}
  </section>
  <section class="panel"><h2>Missed clock-ins</h2><p class="hint" style="margin:-6px 0 10px">Rostered on an approved roster but no clock-in within 30 minutes of the start.</p>
    ${missing.length ? `<div class="tablewrap"><table><thead><tr><th>Shift</th><th>Who</th><th>Plant</th><th>Duty</th></tr></thead><tbody>${missing.slice(0, 100).map((a) => `<tr>
      <td>${esc(fmtDayW(plantDay(a.at)))} ${fmtTime(a.at)}</td><td><b>${esc(a.full_name)}</b></td><td>${esc(plantName(a.plant_id))}</td><td>${esc(a.detail)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty">Nobody missed a clock-in.</p>`}
  </section>
  <section class="panel"><h2>Handover mismatches</h2><p class="hint" style="margin:-6px 0 10px">Where the outgoing shift head's list of who arrived doesn't match the clock-ins. A clock-in nobody saw can mean someone else clocked in for them.</p>
    ${x.handovers.length ? `<div class="tablewrap"><table><thead><tr><th>Shift</th><th>Plant</th><th>Who</th><th>Problem</th></tr></thead><tbody>${x.handovers.map((h) => `<tr>
      <td>${esc(fmtDayW(h.shift_date))} ${h.shift === "D" ? "day" : "night"}</td><td>${esc(plantName(h.plant_id))}</td><td><b>${esc(h.full_name)}</b></td>
      <td>${h.problem === "clocked_in_but_not_seen" ? pill("Clocked in, but the shift head didn't see them", "p-bad") : pill("Seen, but didn't clock in", "p-warn")}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty">No mismatches.</p>`}
  </section>
  ${x.phones.length ? `<section class="panel"><h2>Phones to approve</h2><p class="hint" style="margin:0">${x.phones.length} waiting. <a href="#approvals">Go to Approvals</a>.</p></section>` : ""}`;

  on("photo", (el) => dialog(`<h2>${esc(el.dataset.name)}</h2><img class="photo-big" alt="Clock-in photo" src="/api/photos/${el.dataset.id}"><div class="actions"><button class="btn" data-act="close">Close</button></div>`));
  on("review", (el) => {
    const d = dialog(`<h2>Mark ${esc(el.dataset.name)}'s clock-in checked</h2><div class="field full"><label for="rv">What did you find?</label><input id="rv" placeholder="For example: confirmed with shift head, was at the weir"></div>
      <div class="actions"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="saveReview">Mark checked</button></div>`, {
      saveReview: async () => {
        const note = d.el.querySelector("#rv").value.trim();
        if (!note) return toast("Add a short note.");
        await post(`/api/clock-events/${el.dataset.id}/review`, { note });
        closeDialog(); toast("Marked checked."); app.refresh();
      },
    });
  });
}
