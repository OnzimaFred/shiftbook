// Approvals (Plant Manager): rosters, new phones, leave and overtime claims.
import { get, post } from "../api.js";
import { S, loadRoster, cellLookup, person, plantName, LEAVE, CODE_LABEL } from "../state.js";
import { esc, pill, on, toast, addDays, monthOf, fmtDay, fmtDayW, fmtMonth, dialog, closeDialog } from "../ui.js";
import { CODES } from "../../../shared/rules.ts";
import { showRoster } from "./roster.js";

const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) + 1;

/** The rostered shifts a leave request takes someone off: these need cover. */
async function shiftsMissed(l) {
  const p = person(l.staff_id);
  if (!p) return [];
  const out = [];
  for (let d = l.from_date; d <= l.to_date; d = addDays(d, 1)) {
    const plant = p.plantOn(d);
    if (!plant) continue;
    const r = await loadRoster(plant, monthOf(d)).catch(() => null);
    const c = cellLookup(r)(p.id, d);
    if (CODES[c]?.loc === "DP" || CODES[c]?.loc === "NP") out.push({ d, c });
  }
  return out;
}

export async function approvalsView(main, app) {
  const [rosters, phones, leave, ot] = await Promise.all([get("/api/rosters"), get("/api/passkeys/pending"), get("/api/leave"), get("/api/overtime")]);
  const waiting = rosters.filter((r) => r.status === "submitted");
  const pl = leave.filter((l) => l.status === "pending"), po = ot.filter((o) => o.status === "pending");
  const missed = await Promise.all(pl.map(shiftsMissed));
  const total = waiting.length + phones.length + pl.length + po.length;

  main.innerHTML = `<div class="head"><div><h1>Approvals</h1><p class="sub">${total ? `${total} waiting for you.` : "Nothing waiting. You're up to date."}</p></div></div>
  <section class="panel"><h2>Rosters ${waiting.length ? `<span class="badge">${waiting.length}</span>` : ""}</h2>
    ${waiting.length ? `<div class="stack">${waiting.map((r) => `<div class="gaprow"><div><b>${esc(plantName(r.plant_id))}, ${esc(fmtMonth(r.month))}</b><div class="note">Submitted by ${esc(r.prepared_by_name ?? "–")}${r.submitted_at ? " on " + esc(fmtDay(r.submitted_at.slice(0, 10))) : ""}</div></div>
      <button class="btn primary sm" data-act="openRoster" data-plant="${r.plant_id}" data-month="${r.month}">Review</button></div>`).join("")}</div>` : `<p class="empty">No rosters waiting.</p>`}
  </section>
  <section class="panel"><h2>New phones ${phones.length ? `<span class="badge">${phones.length}</span>` : ""}</h2>
    <p class="hint" style="margin:-6px 0 10px">Approve a phone only with its owner in front of you, holding it. This stops someone setting up their fingerprint on a colleague's account.</p>
    ${phones.length ? `<div class="stack">${phones.map((k) => `<div class="gaprow"><div><b>${esc(k.full_name)}</b><div class="note">${esc(k.label)}, set up ${esc(fmtDay(k.created_at.slice(0, 10)))}</div></div>
      <div class="actions"><button class="btn sm danger" data-act="rejectPhone" data-id="${k.id}">Remove</button><button class="btn sm primary" data-act="approvePhone" data-id="${k.id}">Approve</button></div></div>`).join("")}</div>` : `<p class="empty">No phones waiting.</p>`}
  </section>
  <section class="panel"><h2>Leave ${pl.length ? `<span class="badge">${pl.length}</span>` : ""}</h2>
    ${pl.length ? `<div class="stack">${pl.map((l, i) => `<div class="gaprow" style="align-items:flex-start"><div><b>${esc(l.full_name)}</b>, ${esc(LEAVE[l.type]?.name ?? l.type)}
      <div class="note">${esc(fmtDayW(l.from_date))} to ${esc(fmtDayW(l.to_date))} (${days(l.from_date, l.to_date)} day${days(l.from_date, l.to_date) > 1 ? "s" : ""})${l.reason ? `: ${esc(l.reason)}` : ""}</div>
      <div class="note" style="color:${missed[i].length ? "var(--ot)" : "var(--muted)"}">${missed[i].length ? `Misses ${missed[i].length} shift${missed[i].length > 1 ? "s" : ""} that will need cover: ${missed[i].map((m) => `${esc(fmtDay(m.d))} ${esc(CODE_LABEL[m.c])}`).join(", ")}` : "No shifts to cover."}</div></div>
      <div class="actions"><button class="btn sm danger" data-act="decideLeave" data-id="${l.id}" data-s="declined">Decline</button><button class="btn sm primary" data-act="decideLeave" data-id="${l.id}" data-s="approved">Approve</button></div></div>`).join("")}</div>`
      : `<p class="empty">No leave waiting.</p>`}
    ${pl.some((_, i) => missed[i].length) ? `<p class="hint" style="margin:8px 0 0">After you approve, the roster shows the gaps. Book cover there, cheapest first.</p>` : ""}
  </section>
  <section class="panel"><h2>Overtime claims ${po.length ? `<span class="badge">${po.length}</span>` : ""}</h2>
    ${po.length ? `<div class="stack">${po.map((o) => `<div class="gaprow"><div><b>${esc(o.full_name)}</b>, ${esc(fmtMonth(o.month))}
      <div class="note">${+o.ot_hours ? `${+o.ot_hours}h overtime at ${S.rules.overtimeRate}×` : ""}${+o.ot_hours && +o.ph_hours ? ", " : ""}${+o.ph_hours ? `${+o.ph_hours}h public holiday at ${S.rules.holidayRate}×` : ""}. ${esc(o.reason)}</div></div>
      <div class="actions"><button class="btn sm danger" data-act="decideOt" data-id="${o.id}" data-s="declined">Decline</button><button class="btn sm primary" data-act="decideOt" data-id="${o.id}" data-s="approved">Approve</button></div></div>`).join("")}</div>` : `<p class="empty">No claims waiting.</p>`}
  </section>`;

  on("openRoster", (el) => { showRoster(el.dataset.plant, el.dataset.month); app.go("roster"); });
  on("approvePhone", async (el) => { const r = await post(`/api/passkeys/${el.dataset.id}/approve`); toast(r.message); app.refresh(); });
  on("rejectPhone", async (el) => { await post(`/api/passkeys/${el.dataset.id}/remove`); toast("Phone removed."); app.refresh(); });
  on("decideOt", async (el) => { await post(`/api/overtime/${el.dataset.id}/decide`, { status: el.dataset.s }); toast(`Claim ${el.dataset.s}.`); app.refresh(); });
  on("decideLeave", async (el) => {
    if (el.dataset.s === "approved") {
      await post(`/api/leave/${el.dataset.id}/decide`, { status: "approved" });
      S.rosters.clear(); toast("Leave approved. It's on the roster now."); return app.refresh();
    }
    const d = dialog(`<h2>Decline leave</h2><div class="field full"><label for="dn">Reason <span class="hint">(they'll see this)</span></label><textarea id="dn"></textarea></div>
      <div class="actions"><button class="btn" data-act="close">Cancel</button><button class="btn danger" data-act="doDecline">Decline</button></div>`, {
      doDecline: async () => {
        await post(`/api/leave/${el.dataset.id}/decide`, { status: "declined", note: d.el.querySelector("#dn").value.trim() || undefined });
        closeDialog(); toast("Leave declined."); app.refresh();
      },
    });
  });
}
