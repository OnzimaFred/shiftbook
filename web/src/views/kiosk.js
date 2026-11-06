// Control-room phone: shows the rotating clock-in code, and lets staff without a phone clock in
// with their PIN and a live photo.
import qrcode from "qrcode-generator";
import { api } from "../api.js";
import { esc, on } from "../ui.js";
import { openCamera, capturePhoto, keepAwake } from "../devices.js";
import { qrPayload, qrWindow, QR_WINDOW_SECONDS } from "../../../api/src/clockcore.ts";

const KEY = "shiftbook_kiosk";
export function kioskCredentials() { try { return JSON.parse(localStorage.getItem(KEY) ?? "null"); } catch { return null; } }
export function saveKioskCredentials(r) {
  try { localStorage.setItem(KEY, JSON.stringify({ deviceId: r.deviceId, plantId: r.plantId, plantName: r.plantName, label: r.label, token: r.token, qrSecret: r.qrSecret })); } catch { /* storage blocked */ }
}
const forget = () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } };
const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const CODE_NOTE = { "D/P": "Day shift", "N/P": "Night shift", "N/W": "Night, weir", D: "Day", "O.T D/P": "Cover, day", "O.T N/P": "Cover, night", OFF: "Off", "": "" };

export function kioskView(root, { every, leave }) {
  const creds = kioskCredentials();
  if (!creds) {
    root.innerHTML = `<div class="kiosk"><div class="plant">Shiftbook</div><p>This phone isn't set up as a control-room phone.</p>
      <p class="hint">The Plant Manager sets it up in Settings, signed in on this phone.</p><button class="btn primary" data-act="leave">Sign in</button></div>`;
    on("leave", leave);
    return;
  }
  const secret = b64url(creds.qrSecret);
  const call = (url, body) => api("POST", url, body, { "x-kiosk-token": creds.token });
  let offset = 0;                         // server clock minus this phone's clock
  let mode = "qr", idle = 0, shownWindow = -1;
  let flow = {};                          // { person, kind, pin, photo }
  let stopCam = () => {};
  keepAwake();

  const now = () => Date.now() + offset;
  const removed = (msg) => { forget(); root.innerHTML = `<div class="kiosk"><div class="plant">Shiftbook</div><div class="notice bad">${esc(msg)}</div><button class="btn primary" data-act="leave">Sign in</button></div>`; on("leave", leave); mode = "dead"; };
  const ping = async () => {
    try { const t0 = Date.now(), r = await call("/api/kiosk/ping"); offset = r.serverTime - (t0 + Date.now()) / 2; }
    catch (e) { if (e.status === 401) removed(e.message); }
  };
  ping();
  every(() => { if (mode !== "dead") ping(); }, 5 * 60_000);

  // ---------- The rotating code ----------
  function showQr() {
    stopCam(); mode = "qr"; shownWindow = -1; flow = {};
    root.innerHTML = `<div class="kiosk">
      <div class="plant">${esc(creds.plantName)}</div>
      <div class="digits" id="kd"></div>
      <div class="qr" id="kq" aria-label="Clock-in code"></div>
      <div class="tick" aria-hidden="true"><i id="kt"></i></div>
      <p style="margin:0;max-width:34ch">Open Shiftbook on your phone, press <b>Clock in</b> and scan this code.</p>
      <button class="btn primary" data-act="nophone" style="font-size:18px;padding:14px 22px">No phone? Clock in here</button>
      <button class="linkish" data-act="leave" style="margin-top:12px">${esc(creds.label)} · Sign in instead</button>
    </div>`;
    tick();
  }
  async function tick() {
    if (mode === "qr") {
      const t = now(), w = qrWindow(t);
      const p = new Date(t + 3 * 3600_000).toISOString();
      const kd = root.querySelector("#kd"); if (kd) kd.innerHTML = `${p.slice(11, 16)}<span class="sec">${p.slice(17, 19)}</span>`;
      const left = QR_WINDOW_SECONDS - (Math.floor(t / 1000) % QR_WINDOW_SECONDS);
      const kt = root.querySelector("#kt"); if (kt) kt.style.width = `${(left / QR_WINDOW_SECONDS) * 100}%`;
      if (w !== shownWindow) {
        shownWindow = w;
        const text = await qrPayload(creds.deviceId, secret, w);
        const q = qrcode(0, "M"); q.addData(text); q.make();
        const kq = root.querySelector("#kq"); if (kq) { kq.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); kq.dataset.code = text; }
      }
    } else if (mode !== "dead" && mode !== "done" && ++idle > 75) showQr();   // walked away
  }
  every(tick, 1000);

  // ---------- Clock in without a phone ----------
  async function names() {
    mode = "names"; idle = 0;
    root.innerHTML = `<div class="kiosk"><div class="plant">Who are you?</div><p class="hint">Loading…</p></div>`;
    let people;
    try { ({ people } = await call("/api/kiosk/today")); } catch (e) { if (e.status === 401) return removed(e.message); return fail(e.message); }
    const onDuty = (p) => (CODE_NOTE[p.today] && p.today !== "OFF") || p.last_night;
    people.sort((a, b) => onDuty(b) - onDuty(a) || a.name.localeCompare(b.name));
    root.innerHTML = `<div class="kiosk" style="justify-content:flex-start"><div class="plant">Who are you?</div>
      <div class="namegrid">${people.map((p) => `<button data-act="pick" data-id="${p.id}" class="${onDuty(p) ? "" : "dim"}">${esc(p.name)}<small>${esc(p.last_night ? "Night shift, ending" : CODE_NOTE[p.today] ?? p.today)}${p.has_pin ? "" : " · no PIN set"}</small></button>`).join("")}</div>
      <button class="btn" data-act="back">Back</button></div>`;
    on("pick", (el) => {
      const p = people.find((x) => x.id === el.dataset.id);
      if (!p.has_pin) return fail(`${p.name} hasn't set a control-room PIN. Set one in Shiftbook under Settings, or ask the Plant Manager.`);
      flow = { person: p }; choose();
    });
  }
  function choose() {
    mode = "choose"; idle = 0;
    root.innerHTML = `<div class="kiosk"><div class="plant">${esc(flow.person.name)}</div>
      <div class="bigchoice"><button class="in" data-act="kind" data-kind="in">Clock in</button><button class="out" data-act="kind" data-kind="out">Clock out</button></div>
      <button class="btn" data-act="back">That's not me</button></div>`;
    on("kind", (el) => { flow.kind = el.dataset.kind; pin(); });
  }
  function pin() {
    mode = "pin"; idle = 0; flow.pin = "";
    const draw = () => { root.querySelector(".pindots").innerHTML = Array.from({ length: Math.max(4, flow.pin.length) }, (_, i) => `<i class="${i < flow.pin.length ? "f" : ""}"></i>`).join(""); };
    root.innerHTML = `<div class="kiosk"><div class="plant">Your PIN</div><p class="hint" style="margin:0">${esc(flow.person.name)}, ${flow.kind === "in" ? "clocking in" : "clocking out"}</p>
      <div class="pindots" aria-live="polite"></div>
      <div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-act="key" data-k="${n}">${n}</button>`).join("")}<button data-act="key" data-k="del" aria-label="Delete">⌫</button><button data-act="key" data-k="0">0</button><button data-act="key" data-k="ok" aria-label="Done" style="background:var(--accent);color:var(--accent-ink)">OK</button></div>
      <button class="btn" data-act="back">Cancel</button></div>`;
    draw();
    on("key", (el) => {
      idle = 0;
      const k = el.dataset.k;
      if (k === "del") flow.pin = flow.pin.slice(0, -1);
      else if (k === "ok") { if (flow.pin.length >= 4) return selfie(); }
      else if (flow.pin.length < 6) flow.pin += k;
      draw();
    });
  }
  async function selfie() {
    mode = "photo"; idle = 0;
    root.innerHTML = `<div class="kiosk"><div class="plant">Your photo</div><p class="hint" style="margin:0">Look at the camera. The Plant Manager sees this photo.</p>
      <div class="camera selfie" style="width:min(78vw,380px)"><video></video><div class="cap" id="cd">Get ready</div></div>
      <button class="btn" data-act="back">Cancel</button></div>`;
    const video = root.querySelector("video");
    try { stopCam = await openCamera(video, "user"); } catch (e) { return fail(e.message); }
    for (const n of [3, 2, 1]) { if (mode !== "photo") return; root.querySelector("#cd").textContent = String(n); await new Promise((r) => setTimeout(r, 800)); }
    if (mode !== "photo") return;
    flow.photo = capturePhoto(video);
    stopCam();
    root.querySelector(".camera").innerHTML = `<img src="${flow.photo}" alt="Your photo" style="width:100%;display:block;transform:scaleX(-1)">`;
    root.querySelector(".kiosk").insertAdjacentHTML("beforeend", `<div class="actions"><button class="btn" data-act="retake">Take again</button><button class="btn primary" data-act="send" style="font-size:18px">${flow.kind === "in" ? "Clock in" : "Clock out"}</button></div>`);
    on("retake", selfie);
    on("send", send);
  }
  async function send() {
    mode = "done";
    root.querySelector('[data-act="send"]').disabled = true;
    try {
      const r = await call("/api/kiosk/clock", { staffId: flow.person.id, kind: flow.kind, pin: flow.pin, photo: flow.photo });
      result(r.flags.length ? "warn" : "ok", r.message);
    } catch (e) {
      if (e.status === 401 && e.message.includes("control-room")) return removed(e.message);
      if (e.status === 401) { result("bad", `${e.message} Try again.`); return; }
      result("bad", e.message);
    }
  }
  function result(kind, msg) {
    mode = "done";
    root.innerHTML = `<div class="kiosk"><div class="plant">${kind === "bad" ? "Not done" : flow.kind === "in" ? "Clocked in" : "Clocked out"}</div><div class="notice ${kind}" style="max-width:420px;font-size:18px">${esc(msg)}</div><button class="btn primary" data-act="back">Done</button></div>`;
    setTimeout(() => { if (mode === "done") showQr(); }, kind === "bad" ? 9000 : 6000);
  }
  function fail(msg) { result("bad", msg); }

  on("nophone", names);
  on("back", showQr);
  on("leave", () => { stopCam(); mode = "dead"; leave(); });
  showQr();
}
