// Timesheet: clock-ins and clock-outs paired into hours worked, next to what the roster said.
import { get } from "../api.js";
import { S, loadRoster, cellLookup, person, CODE_LABEL } from "../state.js";
import { esc, pill, on, today, addMonths, addDays, monthOf, fmtDayW, fmtMonth, fmtTime, hrs } from "../ui.js";
import { monthDays, paidMinutes } from "../../../shared/rules.ts";

let month = monthOf(today());
let who = null;
const plantDay = (iso) => new Date(Date.parse(iso) + 3 * 3600_000).toISOString().slice(0, 10);
const METHOD = { personal_passkey: "Own phone", kiosk_pin_photo: "Control-room phone", manual_by_manager: "Entered by manager" };

export async function timesheetView(main, app) {
  const me = S.me, lead = me.app_role !== "staff";
  who = who ?? me.id;
  const p = person(who);
  const days = monthDays(month), last = days.at(-1);
  const events = (await get(`/api/clock-events?from=${days[0]}&to=${addDays(last, 2)}&staff=${who}`)).filter((e) => e.staff_id === who).reverse();
  const plants = [...new Set(days.map((d) => p.plantOn(d)).filter(Boolean))];
  const rs = await Promise.all(plants.map((pl) => loadRoster(pl, month).catch(() => null)));
  const code = (d) => { const pl = p.plantOn(d); return cellLookup(pl ? rs[plants.indexOf(pl)] : null)(p.id, d); };

  // Pair each clock-in with the next clock-out
  const shifts = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind !== "in") { shifts.push({ out: e }); continue; }
    const o = events[i + 1]?.kind === "out" && Date.parse(events[i + 1].at) - Date.parse(e.at) < 16 * 3600_000 ? events[++i] : null;
    shifts.push({ in: e, out: o });
  }
  const byDay = new Map();
  for (const s of shifts) { const d = plantDay((s.in ?? s.out).at); if (d >= days[0] && d <= last) (byDay.get(d) ?? byDay.set(d, []).get(d)).push(s); }
  let workedMin = 0, rosterMin = 0;
  const rows = days.map((d) => {
    const c = code(d), list = byDay.get(d) ?? [], planned = paidMinutes(p, d, c, S.rules);
    const worked = list.reduce((n, s) => n + (s.in && s.out ? (Date.parse(s.out.at) - Date.parse(s.in.at)) / 60000 : 0), 0);
    workedMin += worked; if (d <= today()) rosterMin += planned;
    if (!list.length && !planned) return "";
    const flags = list.flatMap((s) => [...(s.in?.flags ?? []), ...(s.out?.flags ?? [])]);
    return `<tr><td>${esc(fmtDayW(d))}</td><td>${esc(CODE_LABEL[c] ?? c)}</td>
      <td>${list.map((s) => `${s.in ? fmtTime(s.in.at) : "–"} to ${s.out ? fmtTime(s.out.at) : "–"}`).join("<br>") || (d < today() && planned ? pill("No clock-in", "p-bad") : "")}</td>
      <td class="num">${worked ? hrs(Math.round(worked)) : ""}</td><td class="num">${planned ? hrs(planned) : ""}</td>
      <td>${[...new Set(list.flatMap((s) => [s.in?.method, s.out?.method]).filter(Boolean).map((m) => METHOD[m]))].join(", ")} ${[...new Set(flags)].map((f) => pill(f.replace(/_/g, " "), "p-warn")).join(" ")}</td></tr>`;
  }).join("");

  const pick = lead ? S.people.filter((x) => me.app_role === "manager" || x.plantOn(today()) === me.plant || x.id === me.id) : [];
  main.innerHTML = `<div class="head"><div><h1>Timesheet</h1><p class="sub">${esc(p.name)}. Clock-ins next to the roster.</p></div>
    <div class="mnav">${lead ? `<select id="who" aria-label="Person" style="width:auto">${pick.map((x) => `<option value="${x.id}" ${x.id === who ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>` : ""}
    <button class="btn sm" data-act="mprev">Previous</button><span class="mlabel">${esc(fmtMonth(month))}</span><button class="btn sm" data-act="mnext">Next</button></div></div>
  <div class="counts panel"><div><b>${hrs(Math.round(workedMin))}</b><span>Clocked</span></div><div><b>${hrs(rosterMin)}</b><span>Rostered to date</span></div><div><b>${shifts.filter((s) => s.in).length}</b><span>Clock-ins</span></div></div>
  <section class="panel"><div class="tablewrap"><table><thead><tr><th>Day</th><th>Roster</th><th>Clocked</th><th class="num">Worked</th><th class="num">Rostered</th><th>How</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="empty">Nothing this month.</td></tr>`}</tbody></table></div></section>`;

  main.querySelector("#who")?.addEventListener("change", (e) => { who = e.target.value; app.refresh(); });
  on("mprev", () => { month = addMonths(month, -1); app.refresh(); });
  on("mnext", () => { month = addMonths(month, 1); app.refresh(); });
}
