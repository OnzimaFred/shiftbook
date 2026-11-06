// Team today: who is on the day and night shift at each plant, who has clocked in, and sick cover.
import { get, post } from "../api.js";
import { S, loadRoster, forgetRoster, cellLookup, peopleAt, person, plantName, DESIGNATION, CODE_LABEL, canHeadRole } from "../state.js";
import { esc, pill, on, toast, today, addDays, monthOf, fmtDayW, fmtTime, hrs, dialog, closeDialog } from "../ui.js";
import { CODES, shiftTeam, coverOptions, isShiftTeam } from "../../../shared/rules.ts";

let dayOffset = 0;
const initials = (n) => n.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

export async function teamView(main, app) {
  const me = S.me;
  const plants = me.app_role === "manager" ? S.boot.plants.map((p) => p.id) : [me.plant];
  const day = addDays(today(), dayOffset);
  const [events, ...rosters] = await Promise.all([
    get(`/api/clock-events?from=${addDays(day, -1)}&to=${addDays(day, 2)}`),
    ...plants.map((p) => loadRoster(p, monthOf(day))),
  ]);
  const clockIn = (id, shift) => {
    // A day shift's clock-in is on the day; a night shift's from 17:00 that evening.
    const from = Date.parse(day + "T00:00:00Z") - 3 * 3600_000 + (shift === "N" ? 17 : 4) * 3600_000;
    const to = from + (shift === "N" ? 10 : 12) * 3600_000;
    return events.filter((e) => e.staff_id === id && e.kind === "in" && Date.parse(e.at) >= from && Date.parse(e.at) < to).at(-1);
  };

  const sections = plants.map((plant, i) => {
    const r = rosters[i], cell = cellLookup(r), ps = peopleAt(plant, monthOf(day));
    const published = r.roster?.status === "approved";
    const box = (t) => {
      const s = shiftTeam(plant, day, t, ps, cell);
      const bad = !s.head || (t === "N" && (!s.assistant || s.onShift.length !== 2));
      const cards = s.onShift.map((id) => {
        const p = person(id), c = cell(id, day), ev = clockIn(id, t);
        const isCover = CODES[c]?.overtime || !isShiftTeam(p);
        return `<div class="person"><div class="avatar">${esc(initials(p.name))}</div><div class="meta"><b>${esc(p.name)}</b>
          <span class="t">${esc(DESIGNATION[p.designation])}</span>
          <div class="tags">${id === s.head ? `<span class="tag head">Shift head</span>` : ""}${isCover ? `<span class="tag covr">Cover, overtime</span>` : ""}
          ${ev ? pill(`In ${fmtTime(ev.at)}`, ev.flags?.length ? "p-warn" : "p-ok") : pill("Not clocked in", "p-mute")}</div></div>
          ${dayOffset >= 0 && dayOffset <= 1 ? `<button class="btn sm sick" data-act="sick" data-plant="${plant}" data-id="${id}" data-shift="${t}">Off sick</button>` : ""}</div>`;
      });
      if (!s.head) cards.push(`<div class="person gap"><div class="meta"><b>No shift head</b><span class="t">A Plant Technician or Plant Technician II must lead every shift</span></div>
        <button class="btn sm sick" data-act="cover" data-plant="${plant}" data-shift="${t}" data-slot="head">Find cover</button></div>`);
      if (!s.assistant) cards.push(`<div class="person gap" ${t === "D" ? 'style="border-color:var(--warn);color:var(--ink)"' : ""}><div class="meta"><b>No assistant</b><span class="t">${t === "N" ? "Nights must have 2 people" : "Allowed on a day shift, but cover if you can"}</span></div>
        <button class="btn sm sick" data-act="cover" data-plant="${plant}" data-shift="${t}" data-slot="asst">Find cover</button></div>`);
      return `<div class="crewbox ${bad ? "bad" : ""}"><h3><span>${t === "D" ? "Day shift, 07:00–19:00" : "Night shift, 19:00–07:00"}</span>${bad ? pill("Must cover", "p-bad") : pill(`${s.onShift.length} on shift`, "p-ok")}</h3><div class="stack">${cards.join("")}</div></div>`;
    };
    const general = ps.filter((p) => !isShiftTeam(p) && p.plantOn(day) === plant && CODES[cell(p.id, day)]?.type === "G");
    const away = ps.filter((p) => p.plantOn(day) === plant && CODES[cell(p.id, day)]?.leave);
    return `<section class="panel plantsec"><h2>${esc(plantName(plant))} ${published ? "" : pill("Roster not approved, showing the rotation", "p-warn")}</h2>
      <div class="crewpair">${box("D")}${box("N")}</div>
      ${general.length ? `<p class="hint" style="margin:12px 0 0"><b>General shift:</b> ${general.map((p) => `${esc(p.name)}${clockIn(p.id, "D") ? ` (in ${fmtTime(clockIn(p.id, "D").at)})` : ""}`).join(", ")}</p>` : ""}
      ${away.length ? `<p class="hint" style="margin:6px 0 0"><b>Away:</b> ${away.map((p) => `${esc(p.name)} (${esc(CODE_LABEL[cell(p.id, day)])})`).join(", ")}</p>` : ""}
    </section>`;
  });

  main.innerHTML = `<div class="head"><div><h1>Team ${dayOffset === 0 ? "today" : dayOffset === 1 ? "tomorrow" : dayOffset === -1 ? "yesterday" : ""}</h1><p class="sub">${esc(fmtDayW(day))}. Each shift needs a shift head and an assistant; nights must have both.</p></div>
    <div class="mnav"><button class="btn sm" data-act="dprev">Previous day</button>${dayOffset ? `<button class="btn sm" data-act="dnow">Today</button>` : ""}<button class="btn sm" data-act="dnext">Next day</button></div></div>
    ${sections.join("")}`;

  on("dprev", () => { dayOffset--; app.refresh(); });
  on("dnext", () => { dayOffset++; app.refresh(); });
  on("dnow", () => { dayOffset = 0; app.refresh(); });
  on("sick", (el) => sickFlow(el.dataset.plant, el.dataset.id, el.dataset.shift, day, app));
  on("cover", (el) => coverFlow(el.dataset.plant, day, el.dataset.shift, el.dataset.slot, null, app));
}

async function sickFlow(plant, id, shift, day, app) {
  const p = person(id);
  const d = dialog(`<h2>${esc(p.name)} is off sick</h2>
    <p class="hint" style="margin:0">This records approved sick leave and takes them off the roster. You then choose who covers.</p>
    <div class="field full"><label for="sto">Off sick until</label><input id="sto" type="date" value="${day}" min="${day}"></div>
    <div class="field full"><label for="sr">Note <span class="hint">(optional)</span></label><input id="sr" placeholder="For example: called in at 06:10 with fever"></div>
    <div class="actions"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="saveSick">Record and find cover</button></div>`, {
    saveSick: async () => {
      const to = d.el.querySelector("#sto").value || day;
      await post("/api/leave", { staffId: id, type: "sick", from: day, to, reason: d.el.querySelector("#sr").value, status: "approved" });
      forgetRoster(plant, monthOf(day));
      closeDialog();
      toast(`${p.name} recorded as off sick.`);
      await coverFlow(plant, day, shift, canHeadRole(p) ? "head" : "asst", id, app);
    },
  });
}

async function coverFlow(plant, day, shift, slot, forId, app) {
  const r = await loadRoster(plant, monthOf(day), true);
  const cell = cellLookup(r), ps = peopleAt(plant, monthOf(day));
  const s = shiftTeam(plant, day, shift, ps, cell);
  if ((slot === "head" && s.head) || (slot === "asst" && s.assistant)) { toast("That shift is already covered."); return app.refresh(); }
  let opts = coverOptions(plant, day, shift, slot, ps, cell, S.rules), relaxed = false;
  if (!opts.length) { opts = coverOptions(plant, day, shift, slot, ps, cell, S.rules, true); relaxed = true; }
  const optional = shift === "D" && slot === "asst";
  const label = (o) => {
    const p = person(o.id);
    const how = o.mode === "extend" ? "already on site, stays on 17:00–19:00" : p.letter === "R" ? "relief" : isShiftTeam(p) ? "called in on a day off" : DESIGNATION[p.designation];
    return `<b>${esc(p.name)}</b> <span class="hint">${esc(how)}</span>`;
  };
  const d = dialog(`<h2>Cover the ${shift === "D" ? "day" : "night"} shift ${slot === "head" ? "head" : "assistant"}</h2>
    <p class="hint" style="margin:0">${esc(fmtDayW(day))}, ${esc(plantName(plant))}. Cheapest first: a Plant Technician II staying on costs 2 hours of overtime, a call-in costs a full 12-hour shift.${optional ? " A day shift may run one assistant short." : ""}</p>
    ${relaxed && opts.length ? `<div class="notice warn">Nobody with proper rest is free. These people would work without a rest day before their next shift.</div>` : ""}
    ${opts.length ? `<div class="stack">${opts.slice(0, 6).map((o, i) => `<label style="display:flex;gap:10px;align-items:center;justify-content:space-between;border:1px solid var(--line);border-radius:10px;padding:10px">
      <span style="display:flex;gap:10px;align-items:center"><input type="radio" name="co" value="${i}" ${i === 0 ? "checked" : ""} style="width:auto"><span>${label(o)}</span></span>
      <span class="num" style="color:var(--ot);font-weight:700">${o.overtimeMinutes ? "+" + hrs(o.overtimeMinutes) : "No OT"}${o.holiday ? " PH" : ""}</span></label>`).join("")}</div>`
      : `<div class="notice bad">Nobody at ${esc(plantName(plant))} is free to cover. Call the Plant Manager.</div>`}
    <div class="actions"><button class="btn" data-act="close">${optional ? "Run one short" : "Not now"}</button>${opts.length ? `<button class="btn primary" data-act="book">Book cover</button>` : ""}</div>`, {
    book: async () => {
      const o = opts[+d.el.querySelector("input[name=co]:checked").value];
      await post("/api/cover", { plantId: plant, day, shift, slot, forStaffId: forId, coverStaffId: o.id, mode: o.mode, otMinutes: o.overtimeMinutes });
      forgetRoster(plant, monthOf(day));
      closeDialog();
      toast(`${person(o.id).name} covers${o.overtimeMinutes ? `, +${hrs(o.overtimeMinutes)} overtime` : ""}.`);
      app.refresh();
    },
  }, () => app.refresh());
}
