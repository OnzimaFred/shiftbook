// Today: the clock, clocking in and out, handover, the next 7 days, and this month's hours.
import { get, post } from "../api.js";
import { S, loadRoster, cellLookup, myPerson, plantName, DESIGNATION, CODE_LABEL, browserId, canHeadRole, holidayName } from "../state.js";
import { esc, pill, on, dialog, closeDialog, toast, today, addDays, monthOf, fmtDayW, fmtMonth, fmtTime, hrs, weekdayShort, plantNow } from "../ui.js";
import { openCamera, scanForCode, getPosition, fingerprintCheck } from "../devices.js";
import { monthSummary, CODES } from "../../../shared/rules.ts";

const CELL_CLASS = (c) => {
  const t = CODES[c]?.type;
  if (CODES[c]?.leave) return "lv";
  if (CODES[c]?.overtime) return "cov";
  return t === "D" ? "on" : t === "N" ? "night" : t === "G" ? "gen" : "";
};
const SHORT = (c) => (CODES[c]?.leave ? "L" : c === "OFF" || c === "" ? "Off" : c.replace("O.T ", "OT "));

async function myEvents() {
  const rows = await get(`/api/clock-events?from=${addDays(today(), -2)}&to=${addDays(today(), 1)}&staff=${S.me.id}`);
  return rows.filter((e) => e.staff_id === S.me.id);
}

export async function todayView(main, app) {
  const me = myPerson();
  const plant = S.me.plant;
  const d0 = today(), m0 = monthOf(d0);
  const [events, rNow, rNext] = await Promise.all([
    myEvents(),
    plant ? loadRoster(plant, m0).catch(() => null) : null,
    plant && monthOf(addDays(d0, 7)) !== m0 ? loadRoster(plant, monthOf(addDays(d0, 7))).catch(() => null) : null,
  ]);
  const code = (d) => {
    if (!plant) return me.letter === "G" || me.letter === "F" ? cellLookup(null)(me.id, d) : "";
    const r = monthOf(d) === m0 ? rNow : rNext;
    return cellLookup(r?.roster ? r : null)(me.id, d);
  };
  const published = !plant || rNow?.roster?.status === "approved";
  const last = events[0];
  const onShift = last?.kind === "in" && Date.now() - Date.parse(last.at) < 16 * 3600_000;
  const codeToday = code(d0);
  const summary = monthSummary(me, m0, (d) => code(d), S.rules, plant ?? undefined);
  const hour = plantNow().getUTCHours();

  // Handover: a shift head finishing a D/P or N/P shift confirms who arrived for the next one.
  const yCode = code(addDays(d0, -1));
  let handover = null;
  if (canHeadRole(me) && plant) {
    const mins = plantNow().getUTCHours() * 60 + plantNow().getUTCMinutes();
    if (CODES[codeToday]?.type === "D" && mins >= 18 * 60 + 30 && mins <= 21 * 60) handover = { day: d0, shift: "N", label: "tonight's night shift" };
    if (CODES[yCode]?.type === "N" && mins >= 6 * 60 + 30 && mins <= 9 * 60) handover = { day: d0, shift: "D", label: "today's day shift" };
  }

  main.innerHTML = `
  <div class="head"><div><h1>Good ${hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"}, ${esc(me.name.split(" ")[0])}</h1>
    <p class="sub">${esc(fmtDayW(d0))}. ${esc(plantName(plant))}, ${esc(DESIGNATION[me.designation] ?? "")}.</p></div>
    ${codeToday ? pill(CODE_LABEL[codeToday] ?? codeToday, CODES[codeToday]?.type ? "p-ok" : "p-mute") : ""}</div>
  <section class="clock" aria-label="Time clock">
    <div><div class="digits" id="digits"></div>
      <div class="clockmeta">${onShift ? `<span>Clocked in at <strong>${fmtTime(last.at)}</strong></span>${(last.flags ?? []).map((f) => pill(f.replace(/_/g, " "), "p-warn")).join("")}`
        : last ? `<span>Last clocked ${last.kind} at <strong>${fmtTime(last.at)}</strong>, ${esc(fmtDayW(new Date(Date.parse(last.at) + 3 * 3600_000).toISOString().slice(0, 10)))}</span>` : `<span>Not clocked in yet</span>`}</div></div>
    <button class="punch ${onShift ? "out" : ""}" data-act="clock" data-kind="${onShift ? "out" : "in"}">${onShift ? "Clock out" : "Clock in"}<span>Scan the control-room code</span></button>
  </section>
  ${handover ? `<section class="panel" style="border-color:var(--accent)"><h2>Hand over to ${esc(handover.label)}</h2>
    <p class="hint" style="margin:0 0 10px">As shift head, confirm who has arrived before you leave. Anything that doesn't match the clock-ins goes to the Plant Manager.</p>
    <button class="btn primary" data-act="handover" data-day="${handover.day}" data-shift="${handover.shift}">Confirm who arrived</button></section>` : ""}
  <div class="grid2">
    <section class="panel"><h2>Your next 7 days</h2><div class="stack">
      <div class="strip">${[0, 1, 2, 3, 4, 5, 6].map((i) => { const d = addDays(d0, i), c = code(d);
        return `<div title="${esc(CODE_LABEL[c] ?? c)}${holidayName(d) ? ", " + esc(holidayName(d)) : ""}">${weekdayShort(d)}<span class="cell ${CELL_CLASS(c)}">${esc(SHORT(c))}</span>${d.slice(8)}</div>`; }).join("")}</div>
      ${published ? "" : `<p class="hint" style="margin:0">This month's roster isn't published yet, so these come from the rotation and may change.</p>`}
      <p class="hint" style="margin:0">Day shift 07:00–19:00. Night shift 19:00–07:00 the next morning.</p>
    </div></section>
    <section class="panel"><h2>${esc(fmtMonth(m0))}</h2><div class="stack">
      <div class="meter"><div class="row"><span>Rostered hours</span><b>${hrs(summary.paidMinutes)} of ${hrs(summary.contractMinutes)}</b></div>
        <div class="bar"><i style="width:${Math.min(100, (Math.min(summary.paidMinutes, summary.contractMinutes) / Math.max(1, summary.contractMinutes)) * 100)}%"></i><i class="ot" style="width:${Math.min(100, (summary.overtimeMinutes / Math.max(1, summary.contractMinutes)) * 100)}%"></i></div></div>
      <div class="meter"><div class="row"><span>Expected overtime</span><b class="num ot">${hrs(summary.overtimeMinutes)}</b></div>
        ${summary.holidayMinutes ? `<div class="row"><span>Public-holiday hours</span><b>${hrs(summary.holidayMinutes)}</b></div>` : ""}</div>
      <p class="hint" style="margin:0">Your contract is ${S.rules.shiftWeeklyMinutes / 60} hours a week, settled monthly. Hours above it pay ${S.rules.overtimeRate}×, and public-holiday hours pay ${S.rules.holidayRate}×.</p>
      <div class="actions"><a class="btn" href="#roster" style="text-decoration:none">See the roster</a><a class="btn" href="#overtime" style="text-decoration:none">Overtime</a></div>
    </div></section>
  </div>`;

  const digits = main.querySelector("#digits");
  app.every(() => { const n = plantNow(); digits.innerHTML = `${n.toISOString().slice(11, 16)}<span class="sec">${n.toISOString().slice(17, 19)}</span>`; }, 1000);

  on("clock", (el) => clockFlow(el.dataset.kind, app));
  on("handover", (el) => handoverFlow(el.dataset.day, el.dataset.shift, app));
}

// ---------- Clock in or out: scan the code, then the fingerprint ----------
async function clockFlow(kind, app) {
  const position = getPosition();               // starts now; ready by the time the scan is done
  let options;
  try {
    options = await post("/api/clock/options");
  } catch (e) {
    if (e.code === "no_passkey" || e.code === "passkey_pending") {
      dialog(`<h2>${e.code === "no_passkey" ? "Set up your fingerprint first" : "Waiting for approval"}</h2><p>${esc(e.message)}</p>
        <div class="actions"><button class="btn" data-act="close">OK</button>${e.code === "no_passkey" ? `<button class="btn primary" data-act="goSettings">Set up this phone</button>` : ""}</div>`,
        { goSettings: () => { closeDialog(); location.hash = "settings"; } });
      return;
    }
    throw e;
  }
  let stop = () => {}, cancelled = false, done = false;
  const d = dialog(`
    <h2>${kind === "in" ? "Clock in" : "Clock out"}</h2>
    <div class="steps"><span class="on" id="s1">1. Scan the code</span><span id="s2">2. Fingerprint</span><span id="s3">3. Done</span></div>
    <div class="camera"><video></video><div class="frame"></div><div class="cap">Point at the code on the control-room phone</div></div>
    <p class="hint" id="msg" style="margin:0">The code changes every 30 seconds, so scan it now.</p>
    <div class="actions"><button class="btn" data-act="close">Cancel</button></div>`, {}, () => { cancelled = true; stop(); if (done) app.refresh(); });
  const step = (n, text) => {
    ["s1", "s2", "s3"].forEach((id, i) => { const el = d.el.querySelector("#" + id); el.className = i + 1 < n ? "done" : i + 1 === n ? "on" : ""; });
    if (text) d.el.querySelector("#msg").textContent = text;
  };
  try {
    const video = d.el.querySelector("video");
    stop = await openCamera(video, "environment");
    const qr = await scanForCode(video, () => cancelled);
    stop();
    d.el.querySelector(".camera").hidden = true;
    step(2, "Touch the fingerprint sensor when your phone asks.");
    const assertion = await fingerprintCheck(options);
    step(3, "Sending…");
    const res = await post("/api/clock", { kind, qr, assertion, position: await position, browserId: browserId() });
    d.el.innerHTML = `<h2>${kind === "in" ? "Clocked in" : "Clocked out"}</h2><div class="notice ${res.flags.length ? "warn" : "ok"}">${esc(res.message)}</div>
      <div class="actions"><button class="btn primary" data-act="close">Done</button></div>`;
    done = true;
  } catch (e) {
    if (cancelled || e.message === "cancelled") return;
    stop();
    d.el.innerHTML = `<h2>That didn't work</h2><div class="notice bad">${esc(e.message)}</div>
      <p class="hint" style="margin:0">If it keeps failing, clock in on the control-room phone with your PIN.</p>
      <div class="actions"><button class="btn" data-act="close">Close</button></div>`;
  }
}

// ---------- Handover ----------
async function handoverFlow(day, shift, app) {
  const rows = await get(`/api/handovers/expected?plant=${S.me.plant}&day=${day}&shift=${shift}`);
  const d = dialog(`
    <h2>Who arrived for the ${shift === "D" ? "day" : "night"} shift?</h2>
    <p class="hint" style="margin:0">Tick everyone you've seen arrive. People already clocked in are ticked for you.</p>
    <div class="stack">${rows.length ? rows.map((r) => `<label style="display:flex;gap:10px;align-items:center">
      <input type="checkbox" value="${r.staff_id}" ${r.clocked_in_at ? "checked" : ""} style="width:auto">
      <span><b>${esc(r.full_name)}</b> <span class="hint">${esc(r.code)}${r.clocked_in_at ? ", clocked in " + fmtTime(r.clocked_in_at) : ", not clocked in"}</span></span></label>`).join("")
      : `<p class="hint">Nobody is rostered on that shift.</p>`}</div>
    <div class="field full"><label for="hnote">Note <span class="hint">(optional)</span></label><input id="hnote" placeholder="For example: Unit 2 on standby, intake screens cleaned"></div>
    <div class="actions"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="saveHandover">Confirm handover</button></div>`, {
    saveHandover: async () => {
      const arrived = [...d.el.querySelectorAll("input[type=checkbox]:checked")].map((x) => x.value);
      await post("/api/handovers", { shiftDate: day, shift, arrived, note: d.el.querySelector("#hnote").value });
      closeDialog(); toast("Handover confirmed."); app.refresh();
    },
  });
}
