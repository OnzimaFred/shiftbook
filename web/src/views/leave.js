// Leave: balance, requests and their status. Managers can record leave for anyone.
import { get, post } from "../api.js";
import { S, LEAVE, person } from "../state.js";
import { esc, pill, on, toast, today, fmtDayW, formData, formError, STATUS_PILL } from "../ui.js";

const span = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) + 1;
const workdays = (a, b) => { let n = 0; for (let t = Date.parse(a); t <= Date.parse(b); t += 86_400_000) { const w = new Date(t).getUTCDay(); if (w && w !== 6) n++; } return n; };

export async function leaveView(main, app) {
  const rows = await get("/api/leave");
  const me = S.me, mgr = me.app_role === "manager";
  const year = today().slice(0, 4);
  const mine = rows.filter((l) => l.staff_id === me.id);
  const allow = S.boot.settings?.leave ?? { annual_days: 25, sick_days: 10, casual_days: 5 };
  const used = (t) => mine.filter((l) => l.type === t && l.status === "approved" && l.from_date.startsWith(year)).reduce((n, l) => n + span(l.from_date, l.to_date), 0);
  const others = rows.filter((l) => l.staff_id !== me.id);

  const list = (ls, showName) => ls.length ? `<div class="tablewrap"><table><thead><tr>${showName ? "<th>Who</th>" : ""}<th>Type</th><th>From</th><th>To</th><th>Days</th><th>Status</th><th></th></tr></thead><tbody>
    ${ls.map((l) => `<tr>${showName ? `<td><b>${esc(l.full_name)}</b></td>` : ""}<td>${esc(LEAVE[l.type]?.name ?? l.type)}${l.reason ? `<div class="hint">${esc(l.reason)}</div>` : ""}</td>
      <td>${esc(fmtDayW(l.from_date))}</td><td>${esc(fmtDayW(l.to_date))}</td><td class="num">${span(l.from_date, l.to_date)}</td>
      <td>${pill(...STATUS_PILL[l.status])}${l.decision_note ? `<div class="hint">${esc(l.decision_note)}</div>` : ""}</td>
      <td>${l.status === "pending" && l.staff_id === me.id ? `<button class="btn sm" data-act="cancel" data-id="${l.id}">Cancel</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty">No leave yet.</p>`;

  const canRecordFor = mgr ? S.people : me.app_role === "pt2" ? S.people.filter((p) => p.plantOn(today()) === me.plant) : [];

  main.innerHTML = `<div class="head"><div><h1>Leave</h1><p class="sub">Ask for leave here. The Plant Manager approves it and the roster updates by itself.</p></div></div>
  <div class="grid3">
    <section class="panel bal"><span class="lbl">Annual leave</span><span class="hint">${year}, ${allow.annual_days} days a year</span><span class="big">${Math.max(0, allow.annual_days - used("annual"))}<small>days left</small></span></section>
    <section class="panel bal"><span class="lbl">Sick leave</span><span class="hint">Taken in ${year}</span><span class="big">${used("sick")}<small>days</small></span></section>
    <section class="panel bal"><span class="lbl">Casual leave</span><span class="hint">${allow.casual_days} days a year</span><span class="big">${Math.max(0, allow.casual_days - used("casual"))}<small>days left</small></span></section>
  </div>
  <section class="panel"><h2>${canRecordFor.length ? "Request or record leave" : "Request leave"}</h2>
    <form id="lf" class="settings" novalidate>
      ${canRecordFor.length ? `<div class="field"><label for="ls">For</label><select id="ls" name="staffId"><option value="">Me</option>${canRecordFor.filter((p) => p.id !== me.id).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select></div>` : ""}
      <div class="field"><label for="lt">Type</label><select id="lt" name="type">${Object.entries(LEAVE).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join("")}</select></div>
      <div class="field"><label for="lfr">From</label><input id="lfr" name="from" type="date" value="${today()}"></div>
      <div class="field"><label for="lto">To</label><input id="lto" name="to" type="date" value="${today()}"></div>
      <div class="field" style="max-width:none;flex:1 1 260px"><label for="lr">Reason <span class="hint">(optional)</span></label><input id="lr" name="reason"></div>
      ${mgr ? `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="approve" style="width:auto" checked> Approve now</label>` : ""}
      <button class="btn primary" type="submit">${mgr ? "Save leave" : "Send request"}</button>
      <div class="err" hidden style="flex-basis:100%"></div>
    </form>
    <p class="hint" id="lcount" style="margin:8px 0 0"></p>
  </section>
  <section class="panel"><h2>Your leave</h2>${list(mine, false)}</section>
  ${others.length ? `<section class="panel"><h2>${mgr ? "Everyone's leave" : "Your plant's leave"}</h2>${list(others, true)}</section>` : ""}`;

  const f = main.querySelector("#lf");
  const count = () => {
    const d = formData(f);
    main.querySelector("#lcount").textContent = d.from && d.to && d.to >= d.from ? `${span(d.from, d.to)} calendar days, ${workdays(d.from, d.to)} weekdays.` : "";
  };
  f.addEventListener("input", count); count();
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(f);
    if (!d.from || !d.to || d.to < d.from) return formError(f, "The end date must be on or after the start date.");
    const forSomeone = d.staffId && d.staffId !== me.id;
    const status = mgr && d.approve ? "approved" : me.app_role === "pt2" && forSomeone && d.type === "sick" ? "approved" : "pending";
    try {
      await post("/api/leave", { staffId: d.staffId || undefined, type: d.type, from: d.from, to: d.to, reason: d.reason, status });
      S.rosters.clear();
      toast(status === "approved" ? `Leave saved for ${forSomeone ? person(d.staffId).name : "you"} and put on the roster.` : "Request sent to the Plant Manager.");
      app.refresh();
    } catch (err) { formError(f, err.message); }
  });
  on("cancel", async (el) => { await post(`/api/leave/${el.dataset.id}/decide`, { status: "cancelled" }); toast("Request cancelled."); app.refresh(); });
}
