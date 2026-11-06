// Shiftbook web app: sign-in, navigation by role, and screen routing.
import { get, post, onAuthProblem } from "./api.js";
import { S, loadBoot, DESIGNATION, plantName } from "./state.js";
import { esc, toast, resetHandlers, closeDialog, on, formData, formError } from "./ui.js";
import { todayView } from "./views/today.js";
import { rosterView } from "./views/roster.js";
import { teamView } from "./views/team.js";
import { approvalsView } from "./views/approvals.js";
import { exceptionsView } from "./views/exceptions.js";
import { leaveView } from "./views/leave.js";
import { overtimeView } from "./views/overtime.js";
import { timesheetView } from "./views/timesheet.js";
import { staffView } from "./views/staff.js";
import { settingsView } from "./views/settings.js";
import { kioskView, kioskCredentials } from "./views/kiosk.js";

const root = document.getElementById("root");
const ALL = ["staff", "pt2", "manager"];
const NAV = [
  { key: "today", label: "Today", roles: ALL, view: todayView },
  { key: "team", label: "Team today", roles: ["pt2", "manager"], view: teamView },
  { key: "roster", label: "Monthly roster", roles: ALL, view: rosterView },
  { key: "approvals", label: "Approvals", roles: ["manager"], view: approvalsView },
  { key: "exceptions", label: "Exceptions", roles: ["manager"], view: exceptionsView },
  { key: "leave", label: "Leave", roles: ALL, view: leaveView },
  { key: "overtime", label: "Overtime", roles: ALL, view: overtimeView },
  { key: "timesheet", label: "Timesheet", roles: ALL, view: timesheetView },
  { key: "staff", label: "Staff", roles: ["manager"], view: staffView },
  { key: "settings", label: "Settings", roles: ALL, view: settingsView },
];
const HOME = { staff: "today", pt2: "roster", manager: "team" };

// Timers that belong to the current screen (cleared when the screen changes)
let timers = [];
const every = (fn, ms) => { fn(); timers.push(setInterval(fn, ms)); };
const clearTimers = () => { timers.forEach(clearInterval); timers = []; };

const app = {
  refresh: () => route(),
  go: (key) => { if (location.hash === "#" + key) route(); else location.hash = key; },
  every,
};

// ---------- Sign-in ----------
function loginScreen(message) {
  clearTimers(); resetHandlers(); closeDialog();
  root.innerHTML = `
  <div class="center-screen"><div class="signin">
    <div class="brand">Shiftbook<small>Nyamwamba 1 &amp; 2 HPP</small></div>
    ${message ? `<div class="notice">${esc(message)}</div>` : ""}
    <form id="loginForm" novalidate>
      <div class="field full"><label for="u">Username</label><input id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
      <div class="field full"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required></div>
      <div class="err" hidden></div>
      <button class="btn primary" type="submit">Sign in</button>
    </form>
    <p class="hint" style="margin:0">Forgot your password? Ask the Plant Manager to reset it.</p>
    ${kioskCredentials() ? `<a class="btn block" href="#kiosk">Open control-room screen</a>` : ""}
  </div></div>`;
  const f = root.querySelector("#loginForm");
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(f);
    if (!d.username || !d.password) return formError(f, "Enter your username and password.");
    f.querySelector("button").disabled = true;
    try {
      const r = await post("/api/auth/login", d);
      r.mustChangePassword ? passwordScreen(d.password) : await start();
    } catch (err) { formError(f, err.message); f.querySelector("button").disabled = false; }
  });
  f.querySelector("#u").focus();
}

function passwordScreen(current = "") {
  clearTimers(); resetHandlers(); closeDialog();
  root.innerHTML = `
  <div class="center-screen"><div class="signin">
    <div class="brand">Shiftbook</div>
    <div><h1 style="font-size:26px">Choose your password</h1><p class="sub">You signed in with a temporary password. Choose one only you know. Use at least 8 characters.</p></div>
    <form id="pwForm" novalidate>
      <div class="field full" ${current ? "hidden" : ""}><label for="cur">Temporary password</label><input id="cur" name="current" type="password" autocomplete="current-password" value="${esc(current)}"></div>
      <div class="field full"><label for="n1">New password</label><input id="n1" name="next" type="password" autocomplete="new-password" minlength="8"></div>
      <div class="field full"><label for="n2">New password again</label><input id="n2" name="again" type="password" autocomplete="new-password"></div>
      <div class="err" hidden></div>
      <button class="btn primary" type="submit">Save password</button>
    </form>
    <button class="linkish" data-act="signout" style="align-self:flex-start">Sign out</button>
  </div></div>`;
  on("signout", signOut);
  const f = root.querySelector("#pwForm");
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(f);
    if (d.next.length < 8) return formError(f, "Use at least 8 characters.");
    if (d.next !== d.again) return formError(f, "The two new passwords don't match.");
    try {
      await post("/api/auth/password", { current: d.current, new: d.next });
      toast("Password saved.");
      await start();
    } catch (err) { formError(f, err.message); }
  });
  f.querySelector(current ? "#n1" : "#cur").focus();
}

async function signOut() {
  await post("/api/auth/logout").catch(() => {});
  S.me = null; S.boot = null;
  loginScreen("You've signed out.");
}

// ---------- Shell ----------
function shell() {
  const r = S.me.app_role;
  const nav = NAV.filter((n) => n.roles.includes(r));
  root.innerHTML = `
  <div class="shell">
    <aside class="rail">
      <div class="brand">Shiftbook<small>Nyamwamba 1 &amp; 2 HPP</small></div>
      <nav class="nav" id="nav" aria-label="Screens">${nav.map((n) => `<a href="#${n.key}" data-key="${n.key}">${n.label}</a>`).join("")}</nav>
      <div class="who"><b>${esc(S.me.full_name)}</b>${esc(DESIGNATION[S.me.designation] ?? "")}<br>${esc(plantName(S.me.plant))}</div>
    </aside>
    <main id="view"></main>
  </div>`;
}

// Screens render one at a time: a screen still loading finishes before the next one starts,
// so a slow screen can't draw over the one the person moved to.
let routing = Promise.resolve(), queued = 0, shownKey = null;
function route() {
  queued++;
  routing = routing.then(() => (--queued ? undefined : renderRoute())).catch(() => {});
  return routing;
}

async function renderRoute() {
  if (!S.me) return;
  if (location.hash === "#kiosk") return startKiosk();
  const r = S.me.app_role;
  const allowed = NAV.filter((n) => n.roles.includes(r));
  let key = location.hash.slice(1);
  if (!allowed.some((n) => n.key === key)) key = HOME[r];
  if (!document.getElementById("view")) shell();
  document.querySelectorAll("#nav a").forEach((a) => { if (a.dataset.key === key) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  clearTimers(); resetHandlers(); if (key !== shownKey) closeDialog();   // a refresh keeps an open result dialog
  shownKey = key;
  const main = document.getElementById("view");
  main.innerHTML = `<div class="loading">Loading…</div>`;
  on("signout", signOut);
  try {
    await NAV.find((n) => n.key === key).view(main, app);
  } catch (err) {
    if (err.code === "signed_out" || err.code === "must_change_password") return;
    main.innerHTML = `<section class="panel"><h2>That didn't load</h2><p class="hint">${esc(err.message)}</p><button class="btn" data-act="retry">Try again</button></section>`;
    on("retry", () => route());
  }
}

function startKiosk() {
  clearTimers(); resetHandlers(); closeDialog();
  kioskView(root, { every, leave: () => { location.hash = ""; start(); } });
}

async function start() {
  if (location.hash === "#kiosk") return startKiosk();
  try {
    const me = await get("/api/me");
    if (me.mustChangePassword) return passwordScreen();
    await loadBoot();
    document.getElementById("view") || shell();
    await route();
  } catch (err) {
    if (err.status === 401) return loginScreen();
    if (err.code === "must_change_password") return passwordScreen();
    root.innerHTML = `<div class="center-screen"><div class="signin"><div class="brand">Shiftbook</div><div class="notice bad">${esc(err.message)}</div><button class="btn primary" data-act="retry">Try again</button></div></div>`;
    on("retry", start);
  }
}

onAuthProblem("signedOut", () => loginScreen("Your sign-in has expired. Sign in again."));
onAuthProblem("mustChange", () => passwordScreen());
window.addEventListener("hashchange", () => { if (location.hash === "#kiosk") startKiosk(); else if (S.me) route(); else start(); });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
start();
