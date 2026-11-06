// Settings: your phone's fingerprint, control-room PIN and password. For the Plant Manager also plant
// boundaries, control-room phones, public holidays and the rotation start date.
import { get, post, put, del } from "../api.js";
import { S, loadBoot, plantName } from "../state.js";
import { esc, pill, on, toast, today, fmtDay, fmtDayW, formData, formError, dialog, closeDialog } from "../ui.js";
import { supportsPasskeys, fingerprintRegister, getPosition } from "../devices.js";
import { validPin } from "../../../api/src/clockcore.ts";
import { saveKioskCredentials } from "./kiosk.js";

const guessLabel = () => {
  const ua = navigator.userAgent;
  const m = /Android [\d.]+; ([^;)]+)/.exec(ua);
  return m ? m[1].replace(/ Build.*/, "").trim().slice(0, 40) : /iPhone/.test(ua) ? "iPhone" : "Phone";
};

export async function settingsView(main, app) {
  const mgr = S.me.app_role === "manager";
  const [phones, devices] = await Promise.all([get("/api/passkeys/mine"), mgr ? get("/api/kiosk/devices") : []]);
  const rot = S.boot.settings?.rotation ?? {};

  main.innerHTML = `<div class="head"><div><h1>Settings</h1><p class="sub">${esc(S.me.full_name)}</p></div><button class="btn" data-act="signout">Sign out</button></div>
  <section class="panel"><h2>Clock in with this phone</h2>
    <p class="hint" style="margin:-6px 0 10px">Your fingerprint stays on your phone. Shiftbook only gets proof it was you, so nobody else can clock in for you, even with your password. Up to 2 phones. The Plant Manager approves each new phone with you present.</p>
    ${phones.length ? `<div class="stack">${phones.map((k) => `<div class="gaprow"><div><b>${esc(k.label)}</b><div class="note">Set up ${esc(fmtDay(k.created_at.slice(0, 10)))}${k.last_used_at ? `, last used ${esc(fmtDay(k.last_used_at.slice(0, 10)))}` : ""}</div></div>
      <div class="actions">${k.approved_at ? pill("Approved", "p-ok") : pill("Waiting for approval", "p-warn")}<button class="btn sm" data-act="removePhone" data-id="${k.id}">Remove</button></div></div>`).join("")}</div>` : ""}
    ${supportsPasskeys() ? (phones.length < 2 ? `<div class="settings" style="margin-top:12px"><div class="field"><label for="pl">This phone's name</label><input id="pl" value="${esc(guessLabel())}"></div><button class="btn primary" data-act="setupPhone">Set up fingerprint on this phone</button></div>` : "")
      : `<div class="notice warn">This browser can't use a fingerprint. Open Shiftbook in Chrome on your phone, or use the control-room phone with your PIN.</div>`}
  </section>
  <div class="grid2">
    <section class="panel"><h2>Control-room PIN</h2>
      <p class="hint" style="margin:-6px 0 10px">For the control-room phone when you don't have yours. It takes your photo each time.</p>
      <form id="pinf" class="settings" novalidate><div class="field"><label for="pin1">New PIN, 4 to 6 digits</label><input id="pin1" name="pin" inputmode="numeric" type="password" autocomplete="off" maxlength="6"></div>
        <div class="field"><label for="pin2">Again</label><input id="pin2" name="again" inputmode="numeric" type="password" autocomplete="off" maxlength="6"></div>
        <button class="btn primary" type="submit">Save PIN</button><div class="err" hidden style="flex-basis:100%"></div></form>
    </section>
    <section class="panel"><h2>Password</h2>
      <form id="pwf" class="settings" novalidate><div class="field"><label for="pc">Current</label><input id="pc" name="current" type="password" autocomplete="current-password"></div>
        <div class="field"><label for="pn">New, at least 8 characters</label><input id="pn" name="next" type="password" autocomplete="new-password"></div>
        <div class="field"><label for="pa">New again</label><input id="pa" name="again" type="password" autocomplete="new-password"></div>
        <button class="btn primary" type="submit">Change password</button><div class="err" hidden style="flex-basis:100%"></div></form>
      <p class="hint" style="margin:8px 0 0">Changing it signs you out on your other devices.</p>
    </section>
  </div>
  ${mgr ? managerPanels(devices, rot) : ""}`;

  on("setupPhone", async () => {
    const label = main.querySelector("#pl").value.trim() || "Phone";
    const options = await post("/api/passkeys/register-options");
    const response = await fingerprintRegister(options);
    const r = await post("/api/passkeys/register-verify", { response, label });
    toast(r.message); app.refresh();
  });
  on("removePhone", async (el) => { const r = await post(`/api/passkeys/${el.dataset.id}/remove`); toast(r.message); app.refresh(); });

  const pinf = main.querySelector("#pinf");
  pinf.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(pinf);
    if (!validPin(d.pin)) return formError(pinf, "Use 4 to 6 digits, not all the same and not in a row like 1234.");
    if (d.pin !== d.again) return formError(pinf, "The two PINs don't match.");
    try { const r = await post("/api/me/pin", { pin: d.pin }); pinf.reset(); formError(pinf, ""); toast(r.message); } catch (err) { formError(pinf, err.message); }
  });
  const pwf = main.querySelector("#pwf");
  pwf.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(pwf);
    if (d.next.length < 8) return formError(pwf, "Use at least 8 characters.");
    if (d.next !== d.again) return formError(pwf, "The two new passwords don't match.");
    try { await post("/api/auth/password", { current: d.current, new: d.next }); pwf.reset(); formError(pwf, ""); toast("Password changed."); } catch (err) { formError(pwf, err.message); }
  });

  if (mgr) bindManager(main, app);
}

function managerPanels(devices, rot) {
  const year = today().slice(0, 4);
  const hols = S.boot.holidays.filter((h) => h.day >= `${year}-01-01`);
  return `<section class="panel"><h2>Plant boundaries</h2>
    <p class="hint" style="margin:-6px 0 10px">Phone clock-ins outside the circle are flagged. Stand in the power house and press "Use my location", or type the position.</p>
    <div class="stack">${S.boot.plants.map((p) => `<form class="settings" data-plant="${p.id}" novalidate><div class="field" style="max-width:150px"><label>${esc(p.name)}</label><span class="hint">${p.centre_lat != null ? "Set" : pill("Not set", "p-warn")}</span></div>
      <div class="field"><label for="la-${p.id}">Latitude</label><input id="la-${p.id}" name="lat" inputmode="decimal" value="${p.centre_lat ?? ""}"></div>
      <div class="field"><label for="ln-${p.id}">Longitude</label><input id="ln-${p.id}" name="lng" inputmode="decimal" value="${p.centre_lng ?? ""}"></div>
      <div class="field" style="max-width:120px"><label for="ra-${p.id}">Radius, metres</label><input id="ra-${p.id}" name="radiusM" type="number" min="50" max="3000" value="${p.radius_m ?? 300}"></div>
      <button class="btn" type="button" data-act="here" data-plant="${p.id}">Use my location</button><button class="btn primary" type="submit">Save</button><div class="err" hidden style="flex-basis:100%"></div></form>`).join("")}</div>
  </section>
  <section class="panel"><h2>Control-room phones</h2>
    <p class="hint" style="margin:-6px 0 10px">The control-room phone shows a code that changes every 30 seconds. Staff scan it with their own phone to clock in, or clock in on it with their PIN and a photo. To set one up, sign in on that phone and register it here.</p>
    ${devices.length ? `<div class="stack">${devices.map((d) => `<div class="gaprow"><div><b>${esc(d.label)}</b>, ${esc(plantName(d.plant_id))}<div class="note">${d.active ? (d.last_seen_at ? `Last seen ${esc(fmtDay(d.last_seen_at.slice(0, 10)))} ${new Date(Date.parse(d.last_seen_at) + 3 * 3600_000).toISOString().slice(11, 16)}` : "Not used yet") : "Removed"}</div></div>
      ${d.active ? `<button class="btn sm danger" data-act="removeKiosk" data-id="${d.id}">Remove</button>` : pill("Removed", "p-mute")}</div>`).join("")}</div>` : `<p class="empty">No control-room phones yet.</p>`}
    <div class="settings" style="margin-top:12px"><div class="field"><label for="kp">Plant</label><select id="kp">${S.boot.plants.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select></div>
      <div class="field"><label for="kl">Name</label><input id="kl" value="Control room phone"></div><button class="btn primary" data-act="registerKiosk">Make this phone the control-room phone</button></div>
  </section>
  <div class="grid2">
    <section class="panel"><h2>Public holidays</h2><p class="hint" style="margin:-6px 0 10px">Hours worked on these days pay ${S.rules.holidayRate}×. A night shift starting the evening before gets the holiday rate after midnight.</p>
      <div class="stack">${hols.map((h) => `<div class="gaprow"><div><b>${esc(fmtDayW(h.day))}</b> ${esc(h.day.slice(0, 4))}<div class="note">${esc(h.name)}</div></div><button class="btn sm" data-act="delHoliday" data-day="${h.day}">Remove</button></div>`).join("")}</div>
      <form id="hf" class="settings" novalidate style="margin-top:12px"><div class="field"><label for="hd">Date</label><input id="hd" name="day" type="date"></div><div class="field"><label for="hn">Name</label><input id="hn" name="name"></div>
        <button class="btn primary" type="submit">Add</button><div class="err" hidden style="flex-basis:100%"></div></form>
    </section>
    <section class="panel"><h2>Rotation</h2><p class="hint" style="margin:-6px 0 10px">2 days, 2 nights, 2 off. On the start date crew A starts its first day shift, crew B its first day off, and crew C its first night. New rosters start from this.</p>
      <form id="rf" class="settings" novalidate><div class="field"><label for="ra">Crew A's first day shift</label><input id="ra" name="anchor" type="date" value="${esc(rot.anchor ?? "")}"></div>
        <button class="btn primary" type="submit">Save</button><div class="err" hidden style="flex-basis:100%"></div></form>
    </section>
  </div>`;
}

function bindManager(main, app) {
  const reload = async () => { await loadBoot(); app.refresh(); };
  main.querySelectorAll("form[data-plant]").forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(f);
    try { await put(`/api/plants/${f.dataset.plant}/boundary`, { lat: +d.lat, lng: +d.lng, radiusM: +d.radiusM }); toast(`${plantName(f.dataset.plant)} boundary saved.`); reload(); }
    catch (err) { formError(f, err.message); }
  }));
  on("here", async (el) => {
    toast("Finding your location…");
    const p = await getPosition();
    if (!p) return toast("Your location isn't available. Allow location access, or type it.");
    const f = main.querySelector(`form[data-plant="${el.dataset.plant}"]`);
    f.querySelector("[name=lat]").value = p.lat.toFixed(6); f.querySelector("[name=lng]").value = p.lng.toFixed(6);
    toast(`Location found, accurate to about ${Math.round(p.accuracy)} m. Press Save.`);
  });
  on("removeKiosk", (el) => dialog(`<h2>Remove this control-room phone?</h2><p class="hint" style="margin:0">Its codes stop working straight away.</p>
    <div class="actions"><button class="btn" data-act="close">Cancel</button><button class="btn danger" data-act="doRemove">Remove</button></div>`, {
    doRemove: async () => { const r = await post(`/api/kiosk/devices/${el.dataset.id}/remove`); closeDialog(); toast(r.message); app.refresh(); },
  }));
  on("registerKiosk", async () => {
    const r = await post("/api/kiosk/register", { plantId: main.querySelector("#kp").value, label: main.querySelector("#kl").value.trim() });
    saveKioskCredentials(r);
    await post("/api/auth/logout").catch(() => {});      // a control-room phone shouldn't stay signed in as you
    toast("This phone is now the control-room phone.");
    location.hash = "kiosk";
  });
  const hf = main.querySelector("#hf");
  hf.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(hf);
    if (!d.day || !d.name) return formError(hf, "Enter the date and the holiday's name.");
    try { await put(`/api/holidays/${d.day}`, { name: d.name }); toast("Holiday added."); reload(); } catch (err) { formError(hf, err.message); }
  });
  on("delHoliday", async (el) => { await del(`/api/holidays/${el.dataset.day}`); toast("Holiday removed."); reload(); });
  const rf = main.querySelector("#rf");
  rf.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(rf), rot = S.boot.settings?.rotation ?? {};
    if (!d.anchor) return formError(rf, "Choose a date.");
    try {
      await put("/api/settings/rotation", { value: { cycle: rot.cycle ?? ["D/P", "D/P", "N/P", "N/P", "OFF", "OFF"], offsets: rot.offsets ?? { A: 0, B: 2, C: 4 }, anchor: d.anchor } });
      toast("Rotation saved. It applies to rosters you start from now on."); reload();
    } catch (err) { formError(rf, err.message); }
  });
}
