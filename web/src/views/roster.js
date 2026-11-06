// Monthly roster: the grid. Plant Technician II builds and submits; the Plant Manager approves.
import { post, put } from "../api.js";
import { S, loadRoster, forgetRoster, cellLookup, peopleAt, person, plantName, DESIGNATION, CODE_LABEL, holidayName } from "../state.js";
import { esc, pill, on, toast, today, addMonths, monthOf, fmtDay, fmtDayW, fmtMonth, hrs, ROSTER_PILL, copyText, dialog, closeDialog } from "../ui.js";
import { CODES, monthDays, rotationCode, monthSummary, rosterProblems, shiftTeam, coverOptions, isShiftTeam, weekday } from "../../../shared/rules.ts";

let month = monthOf(today());
let plantSel = null;
let brush = null;
let armedReset = false;
const pending = new Map();      // "staffId|day" -> { code, source }
let saveTimer = null;

/** Lets other screens open a particular roster (for example from Approvals). */
export function showRoster(plant, m) { plantSel = plant; month = m; }

const PALETTE = ["D/P", "N/P", "O.T D/P", "O.T N/P", "D", "OFF", "N/W", "A/L", "S/L", "C/L", "ML"];
function gridCell(p, d, c) {
  const x = CODES[c] ?? {};
  if (x.leave) return ["L", "lv", CODE_LABEL[c]];
  if (x.type === "D" || x.type === "N") {
    const t = c === "N/W" ? "W" : x.type;
    return (x.overtime || !isShiftTeam(p)) ? [t, "cov", `${CODE_LABEL[c]}, cover (overtime)`] : [t, x.type === "D" ? "on" : "night", CODE_LABEL[c]];
  }
  if (x.type === "G") return ["G", "gen", CODE_LABEL[c]];
  return ["", "", c === "" ? "Not on the schedule" : "Off"];
}

export async function rosterView(main, app) {
  const me = S.me, role = me.app_role;
  const plant = role === "manager" ? (plantSel ?? "n1") : (me.plant ?? "n1");
  plantSel = plant;
  const r = await loadRoster(plant, month);
  const status = r.roster?.status ?? "none";
  const days = monthDays(month);
  const ps = peopleAt(plant, month);
  const cell = (id, d) => pending.get(`${id}|${d}`)?.code ?? cellLookup(r)(id, d);
  const canEdit = !!r.roster && ((role === "manager" && ["draft", "returned", "submitted"].includes(status)) || (role === "pt2" && plant === me.plant && ["draft", "returned"].includes(status)));
  const canStart = !r.roster && (role === "manager" || (role === "pt2" && plant === me.plant));
  if (!canEdit) brush = null;

  const nav = `<div class="monthbar">
    <div class="mnav"><button class="btn sm" data-act="prev" aria-label="Previous month">Previous</button><span class="mlabel">${esc(fmtMonth(month))}</span><button class="btn sm" data-act="next" aria-label="Next month">Next</button>${month !== monthOf(today()) ? `<button class="btn sm" data-act="now">This month</button>` : ""}</div>
    ${role === "manager" ? `<div class="seg plants" role="group" aria-label="Plant">${S.boot.plants.map((p) => `<button data-act="plant" data-plant="${p.id}" aria-pressed="${p.id === plant}">${esc(p.name)}</button>`).join("")}</div>` : ""}
  </div>`;
  const head = `<div class="head"><div><h1>Monthly roster</h1><p class="sub">${role === "pt2" ? `You build the ${esc(plantName(plant))} roster each month and submit it to the Plant Manager.` : role === "manager" ? "Each plant's Plant Technician II builds its roster. Review, approve and publish it here." : "Your plant's approved roster."}</p></div>${pill(...ROSTER_PILL[status])}</div>`;

  if (role === "staff" && status !== "approved") {
    main.innerHTML = head + nav + `<section class="panel"><h2>The ${esc(fmtMonth(month))} roster isn't published yet</h2><p class="hint" style="margin:0">It appears here once the Plant Manager approves it.</p></section>`;
    bindNav(app); return;
  }

  // Checks and cover gaps (the database enforces the same blocking rules on submit and approve)
  const problems = rosterProblems(plant, month, ps, cell);
  const blocking = problems.filter((p) => p.blocking), notes = problems.filter((p) => !p.blocking);
  const gaps = [];
  if (r.roster) for (const d of days.filter((x) => x >= today())) for (const t of ["D", "N"]) {
    const s = shiftTeam(plant, d, t, ps, cell);
    if (!s.head) gaps.push({ d, t, slot: "head" });
    if (t === "N" && !s.assistant) gaps.push({ d, t, slot: "asst" });
  }

  // The grid
  const tdy = today();
  const hd = (d) => `${d === tdy ? "today" : ""} ${[0, 6].includes(weekday(d)) ? "we" : ""} ${holidayName(d) ? "ph" : ""}`;
  const groups = [
    ["General shift", ps.filter((p) => !isShiftTeam(p))],
    ["Plant Technicians", ps.filter((p) => isShiftTeam(p) && p.designation === "plant_technician").sort(byCrew)],
    ["Plant Assistants", ps.filter((p) => isShiftTeam(p) && p.designation === "plant_assistant").sort(byCrew)],
  ];
  const row = (p) => {
    const sm = monthSummary(p, month, (d) => cell(p.id, d), S.rules, plant);
    return `<tr><td class="nm">${esc(p.name)} <small>${isShiftTeam(p) ? (p.letter === "R" ? "relief" : "crew " + p.letter) : esc(DESIGNATION[p.designation] ?? "")}</small></td>${days.map((d) => {
      if (p.plantOn(d) !== plant) return `<td><div class="cell" title="At ${esc(plantName(p.plantOn(d)))}" style="opacity:.35">–</div></td>`;
      const c = cell(p.id, d), [tx, cl, ti] = gridCell(p, d, c), src = r.sources?.get(`${p.id}|${d}`);
      const edited = pending.has(`${p.id}|${d}`) || src === "manual";
      return `<td><div class="cell ${cl}${d === tdy ? " today" : ""}" data-p="${p.id}" data-d="${d}" ${edited ? 'style="outline:2px solid var(--ink);outline-offset:-2px"' : ""} title="${esc(p.name)}, ${esc(fmtDayW(d))}: ${esc(ti)}">${tx}</div></td>`;
    }).join("")}<td class="tot">${sm.workDays}</td><td class="tot">${Math.round(sm.paidMinutes / 60)}</td><td class="tot" style="color:var(--ot)">${sm.overtimeMinutes ? Math.round(sm.overtimeMinutes / 6) / 10 : ""}</td></tr>`;
  };
  const covRow = (t) => `<tr class="cov"><td class="nm">${t === "D" ? "Day shift" : "Night shift"}</td>${days.map((d) => {
    const s = shiftTeam(plant, d, t, ps, cell), n = s.onShift.length;
    const bad = !s.head || (t === "N" && (!s.assistant || n !== 2)), warn = !bad && (n !== 2 || !s.assistant);
    return `<td><div class="cell ${bad ? "c0" : warn ? "c1" : "c2"}" title="${!s.head ? "No shift head" : !s.assistant ? "No assistant" : n + " on shift"}">${!s.head ? "!" : n}</div></td>`;
  }).join("")}<td></td><td></td><td></td></tr>`;

  const meta = r.roster ? `Prepared by ${esc(r.roster.prepared_by_name ?? "–")}${r.roster.submitted_at ? `, submitted ${esc(fmtDay(r.roster.submitted_at.slice(0, 10)))}` : ""}${status === "approved" && r.roster.approved_by_name ? `. Approved by ${esc(r.roster.approved_by_name)}` : ""}${r.roster.imported_from ? `. Imported from the ${esc(r.roster.imported_from)}` : ""}.${r.roster.return_note && status === "returned" ? ` <b>Plant Manager's note:</b> ${esc(r.roster.return_note)}` : ""}`
    : `No ${esc(fmtMonth(month))} roster yet. This preview comes from the rotation.`;

  let actions = "";
  if (canStart) actions = `<button class="btn primary" data-act="start">Start the ${esc(fmtMonth(month).split(" ")[0])} roster</button>`;
  else if (role === "pt2" && canEdit) actions = `<button class="btn" data-act="reset">${armedReset ? "Click again to replace all edits" : "Reset to rotation"}</button><button class="btn primary" data-act="submit" ${blocking.length ? "disabled" : ""}>Submit to Plant Manager</button>`;
  else if (role === "manager" && status === "submitted") actions = `<button class="btn danger" data-act="return">Return for changes</button><button class="btn primary" data-act="approve" ${blocking.length ? "disabled" : ""}>Approve and publish</button>`;
  else if (role === "manager" && status === "approved") actions = `<button class="btn" data-act="reopen">Reopen as draft</button>`;
  else if (role === "manager" && ["draft", "returned"].includes(status)) actions = `<span class="hint">With the Plant Technician II</span>`;

  main.innerHTML = `${head}${nav}
  <div class="statusbar"><p class="hint" style="margin:0;max-width:70ch">${meta}</p><div class="actions">${actions}<button class="btn sm" data-act="copy">Copy for Excel</button></div></div>
  ${canEdit ? `<div class="palette" role="group" aria-label="Duty codes">${PALETTE.map((c) => { const [tx, cl] = gridCell({ letter: "A", designation: "plant_technician" }, "", c); return `<button data-act="brush" data-code="${esc(c)}" aria-pressed="${brush === c}" title="${esc(CODE_LABEL[c])}"><span class="cell ${cl}" style="width:26px;display:inline-grid">${tx || "–"}</span> ${esc(c)}</button>`; }).join("")}<button data-act="brush" data-code="AUTO" aria-pressed="${brush === "AUTO"}" title="Back to the rotation"><span class="cell" style="width:26px;display:inline-grid;border:1px dashed var(--muted)">↺</span> Rotation</button>
    <span class="hint">${brush ? `Painting ${brush === "AUTO" ? "back to the rotation" : esc(brush)}. Tap or drag across cells. Changes save as you go.` : "Pick a code, then tap or drag across cells."}</span></div>` : ""}
  <section class="panel ${canEdit && brush ? "editing" : ""}"><h2>${esc(plantName(plant))}</h2>
    <p class="sub" style="margin:-8px 0 12px">Shift team: 2 days (07:00–19:00), 2 nights (19:00–07:00), 2 off. Each shift: 1 shift head and 1 assistant.</p>
    <div class="tablewrap" id="gridWrap"><table class="roster" id="grid"><thead><tr><th></th>${days.map((d) => `<th class="${hd(d)}" ${holidayName(d) ? `title="${esc(holidayName(d))}"` : ""}>${esc(fmtDayW(d).slice(0, 2))}<br>${+d.slice(8)}${holidayName(d) ? "<br>PH" : ""}</th>`).join("")}<th>Shifts</th><th>Hours</th><th>OT</th></tr></thead><tbody>
      ${groups.map(([t, list]) => list.length ? `<tr class="rolehd"><td colspan="${days.length + 4}">${t} (${list.length})</td></tr>${list.map(row).join("")}` : "").join("")}
      <tr class="rolehd"><td colspan="${days.length + 4}">On shift each day</td></tr>${covRow("D")}${covRow("N")}
    </tbody></table></div>
    <div class="legend"><span><i style="background:var(--accent)"></i>D Day shift</span><span><i style="background:var(--ink)"></i>N Night shift</span><span><i style="background:var(--ot)"></i>Cover, overtime</span><span><i style="background:var(--accent-soft);border:1px solid var(--accent)"></i>G Day general</span><span><i style="background:var(--info)"></i>L Leave</span><span><i style="background:var(--bad-soft)"></i>Must cover</span><span><i style="background:var(--warn-soft)"></i>Day shift one short, allowed</span></div>
  </section>
  ${role !== "staff" ? `<section class="panel" style="border-color:${blocking.length ? "var(--bad)" : "var(--ok)"}"><h2>${blocking.length ? `${blocking.length} problem${blocking.length > 1 ? "s" : ""} to fix before ${role === "manager" ? "approving" : "submitting"}` : "Roster checks passed"}</h2>
    <p class="hint" style="margin:0 0 6px">Every night has exactly 2 people: a shift head (Plant Technician or Plant Technician II) and a Plant Assistant. Every day shift has a shift head. Nobody works a day straight after a night.</p>
    ${blocking.length ? `<ul class="checks" style="margin:0;padding-left:18px;color:var(--bad)">${blocking.slice(0, 12).map((p) => `<li>${esc(fmtDayW(p.day))} ${p.shift === "N" ? "night" : "day"}: ${esc(p.message)}</li>`).join("")}${blocking.length > 12 ? `<li>and ${blocking.length - 12} more</li>` : ""}</ul>` : ""}
    ${notes.length ? `<details style="margin-top:6px"><summary class="hint">${notes.length} note${notes.length > 1 ? "s" : ""} that don't block it</summary><ul class="checks" style="margin:6px 0 0;padding-left:18px">${notes.map((p) => `<li class="hint">${esc(fmtDayW(p.day))}: ${esc(p.message)}</li>`).join("")}</ul></details>` : ""}
    ${gaps.length && (role === "manager" || plant === me.plant) ? `<div style="margin-top:10px"><div class="groupttl" style="margin-bottom:4px">Cover, cheapest first</div>${gaps.slice(0, 10).map((g, i) => gapRow(g, i, plant, ps, cell)).join("")}</div>` : ""}
  </section>` : ""}
  <textarea id="copyBox" hidden readonly style="min-height:120px;font-size:12px"></textarea>`;

  bindNav(app);
  on("plant", (el) => { plantSel = el.dataset.plant; pending.clear(); app.refresh(); });
  on("brush", (el) => { brush = brush === el.dataset.code ? null : el.dataset.code; app.refresh(); });
  on("copy", () => copyText(excelText(plant, days, ps, cell), main.querySelector("#copyBox")));
  on("start", async () => {
    const cells = [];
    for (const p of ps) for (const d of days) if (p.plantOn(d) === plant) cells.push({ staffId: p.id, day: d, code: rotationCode(p, d, S.rules), source: "rotation" });
    await post("/api/rosters", { plantId: plant, month, cells });
    forgetRoster(plant, month); toast(`${fmtMonth(month)} roster started from the rotation.`); app.refresh();
  });
  on("reset", async () => {
    if (!armedReset) { armedReset = true; return app.refresh(); }
    armedReset = false;
    const cells = [];
    for (const p of ps) for (const d of days) if (p.plantOn(d) === plant) cells.push({ staffId: p.id, day: d, code: rotationCode(p, d, S.rules), source: "rotation" });
    await put(`/api/rosters/${r.roster.id}/cells`, { cells });
    forgetRoster(plant, month); toast("Roster reset to the rotation."); app.refresh();
  });
  const setStatus = async (status, note) => {
    await flush(r);
    await post(`/api/rosters/${r.roster.id}/status`, { status, note });
    forgetRoster(plant, month); app.refresh();
  };
  on("submit", async () => { await setStatus("submitted"); toast("Submitted to the Plant Manager."); });
  on("approve", async () => { await setStatus("approved"); toast(`${plantName(plant)} ${fmtMonth(month)} roster approved and published.`); });
  on("reopen", async () => { await setStatus("draft"); toast("Roster reopened as a draft."); });
  on("return", () => {
    const d = dialog(`<h2>Return the roster</h2><div class="field full"><label for="rn">What needs changing?</label><textarea id="rn"></textarea></div>
      <div class="actions"><button class="btn" data-act="close">Cancel</button><button class="btn danger" data-act="doReturn">Return for changes</button></div>`, {
      doReturn: async () => {
        const note = d.el.querySelector("#rn").value.trim();
        if (!note) return toast("Add a note saying what needs changing.");
        closeDialog(); await setStatus("returned", note); toast("Returned to the Plant Technician II.");
      },
    });
  });
  on("assign", async (el) => {
    const g = gaps[+el.dataset.i], sel = main.querySelector(`#gap${el.dataset.i}`);
    const opt = JSON.parse(sel.value);
    await post("/api/cover", { plantId: plant, day: g.d, shift: g.t, slot: g.slot, coverStaffId: opt.id, mode: opt.mode, otMinutes: opt.overtimeMinutes });
    forgetRoster(plant, month);
    toast(`${person(opt.id).name} covers ${fmtDayW(g.d)} ${g.t === "D" ? "day" : "night"}${opt.overtimeMinutes ? `, +${hrs(opt.overtimeMinutes)} overtime` : ", no overtime"}.`);
    app.refresh();
  });

  // Painting cells
  if (canEdit && brush) {
    let painting = false;
    const paint = (el) => {
      const p = person(el.dataset.p), d = el.dataset.d;
      if (CODES[cellLookup(r)(p.id, d)]?.leave && brush !== "AUTO") return;       // approved leave stays
      const code = brush === "AUTO" ? rotationCode(p, d, S.rules) : brush;
      pending.set(`${p.id}|${d}`, { code, source: brush === "AUTO" ? "rotation" : "manual" });
      const [tx, cl] = gridCell(p, d, code);
      el.className = `cell ${cl}`; el.textContent = tx; el.style.outline = "2px solid var(--ink)"; el.style.outlineOffset = "-2px";
      clearTimeout(saveTimer); saveTimer = setTimeout(() => flush(r).then(() => app.refresh()), 900);
    };
    const grid = main.querySelector("#grid");
    grid.addEventListener("pointerdown", (e) => { const el = e.target.closest(".cell[data-p]"); if (!el) return; e.preventDefault(); painting = e.pointerType === "mouse"; paint(el); });
    grid.addEventListener("pointerover", (e) => { if (!painting) return; const el = e.target.closest(".cell[data-p]"); if (el) paint(el); });
    window.addEventListener("pointerup", () => { painting = false; }, { once: true });
  }
}

const byCrew = (a, b) => (a.letter === "R") - (b.letter === "R") || a.letter.localeCompare(b.letter);

function bindNav(app) {
  const mv = async (n) => { month = addMonths(month, n); pending.clear(); armedReset = false; app.refresh(); };
  on("prev", () => mv(-1)); on("next", () => mv(1));
  on("now", () => { month = monthOf(today()); pending.clear(); app.refresh(); });
}

/** Saves painted cells. */
async function flush(r) {
  if (!pending.size || !r?.roster) return;
  const cells = [...pending].map(([k, v]) => { const [staffId, day] = k.split("|"); return { staffId, day, code: v.code, source: v.source }; });
  pending.clear();
  try {
    await put(`/api/rosters/${r.roster.id}/cells`, { cells });
  } catch (e) { toast(e.message); }
  forgetRoster(r.roster.plant_id, r.roster.month);
}

function gapRow(g, i, plant, ps, cell) {
  let opts = coverOptions(plant, g.d, g.t, g.slot, ps, cell, S.rules);
  let relaxed = false;
  if (!opts.length) { opts = coverOptions(plant, g.d, g.t, g.slot, ps, cell, S.rules, true); relaxed = true; }
  const label = (o) => `${person(o.id).name}, ${o.mode === "extend" ? "stays on to 19:00" : person(o.id).letter === "R" ? "relief" : isShiftTeam(person(o.id)) ? "on a day off" : DESIGNATION[person(o.id).designation]}: ${o.overtimeMinutes ? "+" + hrs(o.overtimeMinutes) + " overtime" : "no overtime"}${o.holiday ? ", public-holiday rate" : ""}${relaxed ? ", no rest before next shift" : ""}`;
  return `<div class="gaprow"><div><b>${esc(fmtDayW(g.d))} ${g.t === "D" ? "day" : "night"}</b><div class="note">${g.slot === "head" ? "No shift head" : "No assistant"}</div></div>
    ${opts.length ? `<div class="actions">${relaxed ? pill("Nobody rested is free", "p-warn") : ""}<select id="gap${i}" aria-label="Cover for ${esc(fmtDayW(g.d))}">${opts.map((o) => `<option value='${esc(JSON.stringify({ id: o.id, mode: o.mode, overtimeMinutes: o.overtimeMinutes }))}'>${esc(label(o))}</option>`).join("")}</select><button class="btn sm primary" data-act="assign" data-i="${i}">Assign cover</button></div>` : pill("Nobody free", "p-bad")}</div>`;
}

/** The roster in the duty-schedule layout, as tab-separated text for Excel. */
function excelText(plant, days, ps, cell) {
  const p = S.boot.plants.find((x) => x.id === plant);
  const lines = [`${p.doc_name}\tPOWER HOUSE DUTY SCHEDULE FOR STAFF - ${fmtMonth(month).toUpperCase()}`,
    ["#", "Emp. No.", "Shift", "Designation", "Name of Employee", ...days.map((d) => `${fmtDayW(d).slice(0, 3)} ${d.slice(8)}`), "Work Days", "Off Days", "Hours", "O.T Hrs"].join("\t")];
  const sections = [["Daily Plant Maintenance", ps.filter((x) => x.letter === "F" || (x.letter === "G" && x.designation === "plant_assistant"))],
    ["Daily Plant Operations", ps.filter(isShiftTeam).sort(byCrew)], ["Sanitation & Environment", ps.filter((x) => x.letter === "E")],
    ["Machine operator", ps.filter((x) => x.designation === "machine_operator")]];
  let n = 0;
  for (const [title, list] of sections) {
    if (!list.length) continue;
    lines.push(title);
    for (const x of list) {
      const sm = monthSummary(x, month, (d) => cell(x.id, d), S.rules, plant);
      lines.push([++n, x.empNo ?? "", x.letter, DESIGNATION[x.designation], x.name, ...days.map((d) => (x.plantOn(d) === plant ? cell(x.id, d) : "")),
        sm.workDays, sm.offDays, Math.round(sm.paidMinutes / 60), Math.round(sm.overtimeMinutes / 6) / 10 || ""].join("\t"));
    }
  }
  lines.push("", ["", "", "", "", "Site location", ...days.map((d) => d.slice(8))].join("\t"));
  for (const [name, loc] of [["Day Power House", "DP"], ["Night Power House", "NP"], ["Day General", "DG"], ["Off", "OFF"], ["Annual Leave", "AL"], ["Sick Leave", "SL"]]) {
    lines.push(["", "", "", "", name, ...days.map((d) => ps.filter((x) => x.plantOn(d) === plant && CODES[cell(x.id, d)]?.loc === loc).length)].join("\t"));
  }
  return lines.join("\n");
}
