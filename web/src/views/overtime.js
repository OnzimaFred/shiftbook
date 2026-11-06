// Overtime: worked out from the roster each month (hours over 48 a week, public-holiday hours), then claimed.
import { get, post } from "../api.js";
import { S, loadRoster, cellLookup, myPerson } from "../state.js";
import { esc, pill, on, toast, today, addMonths, monthOf, fmtMonth, hrs, STATUS_PILL, formData, formError } from "../ui.js";
import { monthSummary, isShiftTeam } from "../../../shared/rules.ts";

let month = addMonths(monthOf(today()), -1);   // usually you claim the month just finished

async function summaryFor(p, m) {
  const plants = [...new Set(Array.from({ length: 31 }, (_, i) => p.plantOn(`${m.slice(0, 8)}${String(i + 1).padStart(2, "0")}`)).filter(Boolean))];
  const rs = await Promise.all(plants.map((pl) => loadRoster(pl, m).catch(() => null)));
  const look = (d) => { const pl = p.plantOn(d), r = rs[plants.indexOf(pl)]; return pl ? cellLookup(r)(p.id, d) : cellLookup(null)(p.id, d); };
  return { s: monthSummary(p, m, look, S.rules), approved: rs.every((r) => r?.roster?.status === "approved") };
}

export async function overtimeView(main, app) {
  const me = myPerson(), mgr = S.me.app_role === "manager";
  const [claims, { s, approved }] = await Promise.all([get("/api/overtime"), summaryFor(me, month)]);
  const mine = claims.filter((c) => c.staff_id === me.id), others = claims.filter((c) => c.staff_id !== me.id);
  const existing = mine.find((c) => c.month === month && c.status !== "cancelled");
  const otH = Math.round(s.overtimeMinutes / 6) / 10, phH = Math.round(s.holidayMinutes / 6) / 10;

  // The month's overtime across the shift team (managers)
  let team = "";
  if (mgr) {
    const shift = S.people.filter(isShiftTeam).concat(S.people.filter((p) => p.letter === "F"));
    const rows = await Promise.all(shift.map(async (p) => ({ p, ...(await summaryFor(p, month)) })));
    const claimOf = (id) => claims.find((c) => c.staff_id === id && c.month === month && c.status !== "cancelled");
    const tot = rows.reduce((n, r) => n + r.s.overtimeMinutes, 0);
    team = `<section class="panel"><h2>Overtime by person, ${esc(fmtMonth(month))}</h2><p class="hint" style="margin:-6px 0 10px">From the roster. ${hrs(tot)} overtime in total.</p>
      <div class="tablewrap"><table><thead><tr><th>Who</th><th class="num">Rostered</th><th class="num">Contract</th><th class="num">Overtime</th><th class="num">Public holiday</th><th>Claim</th></tr></thead><tbody>
      ${rows.filter((r) => r.s.paidMinutes).map((r) => { const c = claimOf(r.p.id); return `<tr><td><b>${esc(r.p.name)}</b></td><td class="num">${hrs(r.s.paidMinutes)}</td><td class="num">${hrs(r.s.contractMinutes)}</td>
        <td class="num" style="color:var(--ot);font-weight:700">${r.s.overtimeMinutes ? hrs(r.s.overtimeMinutes) : "–"}</td><td class="num">${r.s.holidayMinutes ? hrs(r.s.holidayMinutes) : "–"}</td>
        <td>${c ? pill(`${+c.ot_hours + +c.ph_hours}h ${STATUS_PILL[c.status][0].toLowerCase()}`, STATUS_PILL[c.status][1]) : `<span class="hint">Not claimed</span>`}</td></tr>`; }).join("")}</tbody></table></div></section>`;
  }

  main.innerHTML = `<div class="head"><div><h1>Overtime</h1><p class="sub">Shift staff are contracted for ${S.rules.shiftWeeklyMinutes / 60} hours a week, settled monthly. Hours above that pay ${S.rules.overtimeRate}×. Public-holiday hours pay ${S.rules.holidayRate}×.</p></div>
    <div class="mnav"><button class="btn sm" data-act="mprev">Previous</button><span class="mlabel">${esc(fmtMonth(month))}</span><button class="btn sm" data-act="mnext">Next</button></div></div>
  <div class="grid3">
    <section class="panel bal"><span class="lbl">Rostered hours</span><span class="hint">Contract ${hrs(s.contractMinutes)}</span><span class="big">${Math.round(s.paidMinutes / 60)}<small>hours</small></span></section>
    <section class="panel bal"><span class="lbl">Overtime</span><span class="hint">At ${S.rules.overtimeRate}×</span><span class="big" style="color:var(--ot)">${otH}<small>hours</small></span></section>
    <section class="panel bal"><span class="lbl">Public holiday</span><span class="hint">At ${S.rules.holidayRate}×</span><span class="big">${phH}<small>hours</small></span></section>
  </div>
  <section class="panel"><h2>Claim ${esc(fmtMonth(month))}</h2>
    ${!approved ? `<div class="notice warn">This month's roster isn't approved yet, so these figures may change.</div>` : ""}
    ${existing ? `<p style="margin:0">You've claimed ${+existing.ot_hours}h overtime and ${+existing.ph_hours}h public holiday. ${pill(...STATUS_PILL[existing.status])}</p>
      ${existing.status === "pending" ? `<div class="actions" style="margin-top:10px"><button class="btn" data-act="cancel" data-id="${existing.id}">Cancel the claim</button></div>` : ""}`
    : month >= monthOf(today()) ? `<p class="hint" style="margin:0">Claim once the month has finished.</p>`
    : otH + phH === 0 ? `<p class="hint" style="margin:0">No overtime on the roster this month. If you worked extra that isn't on it, claim it with a reason.</p>${form(0, 0)}`
    : form(otH, phH)}
  </section>
  ${team}
  <section class="panel"><h2>Your claims</h2>${table(mine, false)}</section>
  ${others.length && !mgr ? `<section class="panel"><h2>Your plant's claims</h2>${table(others, true)}</section>` : ""}`;

  on("mprev", () => { month = addMonths(month, -1); app.refresh(); });
  on("mnext", () => { month = addMonths(month, 1); app.refresh(); });
  on("cancel", async (el) => { await post(`/api/overtime/${el.dataset.id}/decide`, { status: "cancelled" }); toast("Claim cancelled."); app.refresh(); });
  const f = main.querySelector("#otf");
  f?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(f);
    if (!d.reason) return formError(f, "Say what the overtime was for, for example the shifts you covered.");
    try { await post("/api/overtime", { month: month.slice(0, 7), otHours: +d.ot || 0, phHours: +d.ph || 0, reason: d.reason }); toast("Claim sent to the Plant Manager."); app.refresh(); }
    catch (err) { formError(f, err.message); }
  });
}

function form(ot, ph) {
  return `<form id="otf" class="settings" novalidate style="margin-top:10px">
    <div class="field"><label for="oo">Overtime hours</label><input id="oo" name="ot" type="number" min="0" step="0.5" value="${ot}"></div>
    <div class="field"><label for="op">Public-holiday hours</label><input id="op" name="ph" type="number" min="0" step="0.5" value="${ph}"></div>
    <div class="field" style="max-width:none;flex:1 1 280px"><label for="or">What it was for</label><input id="or" name="reason" value="${ot || ph ? "Hours above contract on the approved roster" : ""}"></div>
    <button class="btn primary" type="submit">Send claim</button><div class="err" hidden style="flex-basis:100%"></div></form>`;
}

function table(rows, names) {
  return rows.length ? `<div class="tablewrap"><table><thead><tr>${names ? "<th>Who</th>" : ""}<th>Month</th><th class="num">Overtime</th><th class="num">Public holiday</th><th>Reason</th><th>Status</th></tr></thead><tbody>
    ${rows.map((c) => `<tr>${names ? `<td><b>${esc(c.full_name)}</b></td>` : ""}<td>${esc(fmtMonth(c.month))}</td><td class="num">${+c.ot_hours}h</td><td class="num">${+c.ph_hours}h</td><td>${esc(c.reason)}</td><td>${pill(...STATUS_PILL[c.status])}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty">No claims yet.</p>`;
}
