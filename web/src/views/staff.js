// Staff (Plant Manager): records, sign-ins, password resets, PINs and plant moves.
import { post, patch } from "../api.js";
import { S, loadBoot, plantName, DESIGNATION } from "../state.js";
import { esc, pill, on, toast, today, fmtDay, dialog, closeDialog, formData, formError, copyText } from "../ui.js";

const LETTERS = { A: "Crew A", B: "Crew B", C: "Crew C", R: "Relief", F: "F, Plant Technician II day", E: "E, sanitation 07:00–16:00", G: "G, general 08:00–17:00" };
const ROLES = { staff: "Staff", pt2: "Plant Technician II (builds roster)", manager: "Plant Manager" };
const suggestUser = (name) => name.toLowerCase().replace(/[^a-z ]/g, "").trim().split(/\s+/).slice(0, 2).join(".");

export async function staffView(main, app) {
  const all = S.boot.staff;
  const plantNow = (id) => S.people.find((p) => p.id === id)?.plantOn(today()) ?? null;
  const moves = (id) => S.boot.assignments.filter((a) => a.staff_id === id && a.from_date > today());
  const groups = [[null, "Shared staff"], ...S.boot.plants.map((p) => [p.id, p.name])];
  const row = (s) => {
    const next = moves(s.id)[0];
    return `<tr ${s.active ? "" : 'style="opacity:.5"'}><td><b>${esc(s.full_name)}</b>${s.emp_no ? `<div class="hint">${esc(s.emp_no)}</div>` : ""}</td>
      <td>${esc(DESIGNATION[s.designation])}${s.app_role !== "staff" ? `<div class="hint">${esc(ROLES[s.app_role])}</div>` : ""}</td>
      <td><span class="tag">${esc(s.shift_letter)}</span>${next ? `<div class="hint">To ${esc(plantName(next.plant_id))} ${esc(fmtDay(next.from_date))}</div>` : ""}</td>
      <td>${s.has_sign_in ? pill("Has sign-in", "p-ok") : pill("No sign-in", "p-mute")}</td>
      <td><div class="actions" style="justify-content:flex-end">
        ${s.has_sign_in ? `<button class="btn sm" data-act="reset" data-id="${s.id}">Reset password</button>` : `<button class="btn sm primary" data-act="signin" data-id="${s.id}">Create sign-in</button>`}
        <button class="btn sm" data-act="clearPin" data-id="${s.id}">Clear PIN</button>
        <button class="btn sm" data-act="edit" data-id="${s.id}">Edit</button>
        <button class="btn sm" data-act="move" data-id="${s.id}">Move</button></div></td></tr>`;
  };

  main.innerHTML = `<div class="head"><div><h1>Staff</h1><p class="sub">${all.filter((s) => s.active).length} people. Create sign-ins here and hand each person their temporary password in person.</p></div>
    <button class="btn primary" data-act="add">Add staff</button></div>
  ${[...groups, ["left", "No longer working here"]].map(([id, name]) => { const list = all.filter((s) => id === "left" ? !s.active : s.active && plantNow(s.id) === id); return list.length ? `<section class="panel"><h2>${esc(name)} <span class="hint">(${list.length})</span></h2>
    <div class="tablewrap"><table><thead><tr><th>Name</th><th>Designation</th><th>Shift</th><th>Sign-in</th><th></th></tr></thead><tbody>${list.map(row).join("")}</tbody></table></div></section>` : ""; }).join("")}`;

  const reload = async () => { await loadBoot(); app.refresh(); };
  const showPassword = (title, r) => dialog(`<h2>${esc(title)}</h2>${r.username ? `<p style="margin:0">Username: <b class="num">${esc(r.username)}</b></p>` : ""}
    <p style="margin:0">Temporary password:</p><div class="notice ok" style="font-family:var(--mono,monospace);font-size:20px;text-align:center">${esc(r.temporaryPassword)}</div>
    <p class="hint" style="margin:0">${esc(r.message)} This password isn't shown again.</p>
    <div class="actions"><button class="btn" data-act="copyPw">Copy</button><button class="btn primary" data-act="close">Done</button></div>`,
    { copyPw: () => copyText(`${r.username ? `Username: ${r.username}\n` : ""}Password: ${r.temporaryPassword}`) });
  const byId = (id) => all.find((s) => s.id === id);

  on("signin", (el) => {
    const s = byId(el.dataset.id);
    const d = dialog(`<h2>Create a sign-in for ${esc(s.full_name)}</h2><form id="sf" novalidate class="stack">
      <div class="field full"><label for="su">Username</label><input id="su" name="username" value="${esc(suggestUser(s.full_name))}" autocapitalize="none" spellcheck="false"></div>
      <p class="hint" style="margin:0">Shiftbook makes a temporary password. They choose their own the first time they sign in.</p><div class="err" hidden></div>
      <div class="actions"><button class="btn" type="button" data-act="close">Cancel</button><button class="btn primary" type="submit">Create sign-in</button></div></form>`);
    d.el.querySelector("#sf").addEventListener("submit", async (e) => {
      e.preventDefault();
      try { const r = await post(`/api/staff/${s.id}/sign-in`, { username: formData(e.target).username }); await loadBoot(); showPassword(`Sign-in for ${s.full_name}`, r); app.refresh(); }
      catch (err) { formError(e.target, err.message); }
    });
  });
  on("reset", (el) => {
    const s = byId(el.dataset.id);
    dialog(`<h2>Reset ${esc(s.full_name)}'s password?</h2><p class="hint" style="margin:0">They're signed out everywhere and get a new temporary password from you.</p>
      <div class="actions"><button class="btn" data-act="close">Cancel</button><button class="btn danger" data-act="doReset">Reset password</button></div>`, {
      doReset: async () => { const r = await post(`/api/staff/${s.id}/reset-password`); showPassword(`New password for ${s.full_name}`, r); },
    });
  });
  on("clearPin", async (el) => { await post(`/api/staff/${el.dataset.id}/clear-pin`); toast(`${byId(el.dataset.id).full_name}'s control-room PIN is cleared. They set a new one in Settings.`); });
  on("edit", (el) => staffForm(byId(el.dataset.id), reload));
  on("add", () => staffForm(null, reload));
  on("move", (el) => {
    const s = byId(el.dataset.id);
    const d = dialog(`<h2>Move ${esc(s.full_name)}</h2><form id="mf" novalidate class="stack">
      <div class="field full"><label for="mp">To</label><select id="mp" name="plantId">${S.boot.plants.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}<option value="">Shared staff (both plants)</option></select></div>
      <div class="field full"><label for="md">From</label><input id="md" name="fromDate" type="date" value="${today()}"></div>
      <p class="hint" style="margin:0">Rosters from that date put them at the new plant. Earlier rosters don't change.</p><div class="err" hidden></div>
      <div class="actions"><button class="btn" type="button" data-act="close">Cancel</button><button class="btn primary" type="submit">Move</button></div></form>`);
    d.el.querySelector("#mf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      try { await post(`/api/staff/${s.id}/assignments`, f); closeDialog(); toast(`${s.full_name} moves to ${plantName(f.plantId || null)} from ${fmtDay(f.fromDate)}.`); reload(); }
      catch (err) { formError(e.target, err.message); }
    });
  });
}

function staffForm(s, reload) {
  const opt = (map, v) => Object.entries(map).map(([k, n]) => `<option value="${k}" ${k === v ? "selected" : ""}>${esc(n)}</option>`).join("");
  const d = dialog(`<h2>${s ? `Edit ${esc(s.full_name)}` : "Add staff"}</h2><form id="ef" novalidate class="stack">
    <div class="field full"><label for="en">Full name</label><input id="en" name="fullName" value="${esc(s?.full_name === "(set name)" ? "" : s?.full_name ?? "")}"></div>
    <div class="field full"><label for="eno">Employee number</label><input id="eno" name="empNo" value="${esc(s?.emp_no ?? "")}" placeholder="For example UG016"></div>
    <div class="field full"><label for="ed">Designation</label><select id="ed" name="designation">${opt(DESIGNATION, s?.designation ?? "plant_assistant")}</select></div>
    <div class="field full"><label for="el">Shift</label><select id="el" name="shiftLetter">${opt(LETTERS, s?.shift_letter ?? "A")}</select></div>
    <div class="field full"><label for="er">Access</label><select id="er" name="appRole">${opt(ROLES, s?.app_role ?? "staff")}</select></div>
    ${s ? `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" ${s.active ? "checked" : ""} style="width:auto"> Still works here</label>`
      : `<div class="field full"><label for="ep">Plant</label><select id="ep" name="plantId">${S.boot.plants.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}<option value="">Shared staff (both plants)</option></select></div>
         <div class="field full"><label for="ef2">Starts</label><input id="ef2" name="fromDate" type="date" value="${today()}"></div>`}
    <div class="err" hidden></div>
    <div class="actions"><button class="btn" type="button" data-act="close">Cancel</button><button class="btn primary" type="submit">${s ? "Save" : "Add"}</button></div></form>`);
  d.el.querySelector("#ef").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    if (!f.fullName) return formError(e.target, "Enter their name.");
    try {
      if (s) await patch(`/api/staff/${s.id}`, f); else await post("/api/staff", f);
      closeDialog(); toast(s ? "Saved." : `${f.fullName} added. Create their sign-in next.`); reload();
    } catch (err) { formError(e.target, err.message); }
  });
}
