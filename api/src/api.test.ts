// End-to-end API tests against a real Postgres.
// Needs TEST_PG_HOST (and optionally TEST_PG_PORT) pointing at a server where user "postgres" can connect.
// Run: TEST_PG_HOST=/var/run/postgresql npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { qrPayload, qrWindow } from "./clockcore.ts";

const HOST = process.env.TEST_PG_HOST;
const PORT = process.env.TEST_PG_PORT ?? "5432";
const DB = "shiftbook_apitest";
const ORIGIN = "https://shiftbook.test";
const skip = !HOST && "set TEST_PG_HOST to run the API tests";

let app: any, admin: pg.Client, photoDir: string;
const jar: Record<string, string> = {};

async function call(who: string | null, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method, url, payload: body as any,
    headers: { origin: ORIGIN, ...(who && jar[who] ? { cookie: `shiftbook_session=${jar[who]}` } : {}), ...headers },
  });
  const set = res.headers["set-cookie"];
  const c = Array.isArray(set) ? set[0] : set;
  if (who && c?.startsWith("shiftbook_session=")) jar[who] = c.split(";")[0].split("=")[1];
  let json: any = null; try { json = res.json(); } catch {}
  return { status: res.statusCode, json, res };
}
const sid = async (name: string) => (await admin.query("select id from staff where full_name = $1", [name])).rows[0].id as string;

async function signIn(who: string, username: string, password: string, newPassword: string) {
  const r = await call(who, "POST", "/api/auth/login", { username, password });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  if (r.json.mustChangePassword) {
    const p = await call(who, "POST", "/api/auth/password", { current: password, new: newPassword });
    assert.equal(p.status, 200, JSON.stringify(p.json));
  }
}

before(async () => {
  if (skip) return;
  const base = `postgres://postgres@localhost:${PORT}/postgres?host=${encodeURIComponent(HOST!)}`;
  const root = new pg.Client({ connectionString: base });
  await root.connect();
  await root.query(`drop database if exists ${DB}`);
  await root.query(`create database ${DB}`);
  await root.end();
  photoDir = await mkdtemp(join(tmpdir(), "shiftbook-photos-"));
  Object.assign(process.env, {
    DATABASE_ADMIN_URL: base.replace("/postgres?", `/${DB}?`),
    DATABASE_URL: `postgres://shiftbook_api@localhost:${PORT}/${DB}?host=${encodeURIComponent(HOST!)}`,
    APP_ORIGIN: ORIGIN, PHOTO_DIR: photoDir, PUBLIC_DIR: "/nonexistent/",
  });
  const { migrate } = await import("./migrate.ts");
  await migrate(() => {});
  admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await admin.connect();
  // Bootstrap the first Plant Manager the way the deploy guide does
  await admin.query(`update staff set user_id = auth.create_user('plant.manager', 'first-temp-pass'), full_name = 'Test Manager'
                     where designation = 'plant_manager'`);
  const { buildApp } = await import("./app.ts");
  app = await buildApp();
});

after(async () => {
  if (skip) return;
  await app?.close();
  const { pool } = await import("./db.ts");
  await pool.end();
  await admin?.end();
  await rm(photoDir, { recursive: true, force: true });
});

test("health check", { skip }, async () => {
  assert.equal((await call(null, "GET", "/api/health")).status, 200);
});

test("sign-in: wrong password, temporary password, choose your own", { skip }, async () => {
  assert.equal((await call("mgr", "POST", "/api/auth/login", { username: "plant.manager", password: "nope" })).status, 401);
  const r = await call("mgr", "POST", "/api/auth/login", { username: "Plant.Manager", password: "first-temp-pass" });
  assert.equal(r.status, 200);
  assert.equal(r.json.mustChangePassword, true);
  assert.match(String(r.res.headers["set-cookie"]), /HttpOnly; Secure; SameSite=Lax/);
  const blocked = await call("mgr", "GET", "/api/bootstrap");
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.code, "must_change_password");
  assert.equal((await call("mgr", "POST", "/api/auth/password", { current: "first-temp-pass", new: "short" })).status, 400);
  assert.equal((await call("mgr", "POST", "/api/auth/password", { current: "first-temp-pass", new: "Nyamwamba-2026" })).status, 200);
  const boot = await call("mgr", "GET", "/api/bootstrap");
  assert.equal(boot.status, 200);
  assert.equal(boot.json.me.app_role, "manager");
  assert.equal(boot.json.plants.length, 2);
});

test("security: requests from another site are refused; no cookie means signed out", { skip }, async () => {
  const forged = await app.inject({ method: "POST", url: "/api/me/pin", payload: { pin: "4829" },
    headers: { origin: "https://evil.example", cookie: `shiftbook_session=${jar.mgr}` } });
  assert.equal(forged.statusCode, 403);
  assert.equal((await call(null, "GET", "/api/bootstrap")).status, 401);
  assert.equal((await call(null, "GET", "/api/bootstrap", undefined, { cookie: "shiftbook_session=" + "a".repeat(64) })).status, 401);
  const h = (await call(null, "GET", "/api/health")).res.headers;
  assert.equal(h["x-frame-options"], "DENY");
  assert.match(String(h["content-security-policy"]), /frame-ancestors 'none'/);
});

test("manager creates sign-ins; staff and PT II choose their passwords", { skip }, async () => {
  const moses = await call("mgr", "POST", `/api/staff/${await sid("Moses Masereka")}/sign-in`, { username: "moses.masereka" });
  assert.equal(moses.status, 200, JSON.stringify(moses.json));
  assert.match(moses.json.temporaryPassword, /^[a-z]+-[a-z]+-\d{4}$/);
  await signIn("moses", "moses.masereka", moses.json.temporaryPassword, "moses-own-pass");
  const fred = await call("mgr", "POST", `/api/staff/${await sid("Fred Onzima")}/sign-in`, { username: "ug016" });
  await signIn("fred", "ug016", fred.json.temporaryPassword, "fred-own-pass");
  const joseph = await call("mgr", "POST", `/api/staff/${await sid("Joseph Maate")}/sign-in`, { username: "joseph.maate" });
  await signIn("joseph", "joseph.maate", joseph.json.temporaryPassword, "joseph-own-pass");
  assert.equal((await call("mgr", "POST", `/api/staff/${await sid("Moses Masereka")}/sign-in`, { username: "x.y.z" })).status, 409);
  assert.equal((await call("moses", "POST", `/api/staff/${await sid("Joseph Maate")}/reset-password`)).status, 403);
});

test("rosters: staff read the approved roster but can't edit it", { skip }, async () => {
  const r = await call("moses", "GET", "/api/rosters/n1/2026-11");
  assert.equal(r.status, 200);
  assert.equal(r.json.roster.status, "approved");
  assert.ok(r.json.cells.length > 300);
  assert.deepEqual(r.json.problems.map((p: any) => p.day), ["2026-11-01", "2026-11-02"]);
  const edit = await call("moses", "PUT", `/api/rosters/${r.json.roster.id}/cells`, { cells: [{ staffId: await sid("Moses Masereka"), day: "2026-11-20", code: "OFF" }] });
  assert.equal(edit.status, 403);
});

test("rosters: PT II builds Nyamwamba 2, can't submit a short night, then submits; manager approves", { skip }, async () => {
  const { rotationCode, DEFAULT_RULES, monthDays } = await import("../../shared/rules.ts");
  const boot = (await call("fred", "GET", "/api/bootstrap")).json;
  const rules = { ...DEFAULT_RULES, holidays: new Set<string>(boot.holidays.map((h: any) => h.day)) };
  const plantOn = (id: string) => (d: string) => boot.assignments.filter((a: any) => a.staff_id === id && a.from_date <= d).at(-1)?.plant_id ?? null;
  const cells: any[] = [];
  for (const s of boot.staff) {
    const person = { id: s.id, name: s.full_name, designation: s.designation, letter: s.shift_letter, plantOn: plantOn(s.id) };
    for (const d of monthDays("2026-11-01")) if (person.plantOn(d) === "n2") cells.push({ staffId: s.id, day: d, code: rotationCode(person, d, rules), source: "rotation" });
  }
  const created = await call("fred", "POST", "/api/rosters", { plantId: "n2", month: "2026-11", cells });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.equal((await call("fred", "POST", "/api/rosters", { plantId: "n1", month: "2026-12" })).status, 403);

  const night = cells.find((x) => x.day === "2026-11-13" && x.code === "N/P" && boot.staff.find((s: any) => s.id === x.staffId).designation === "plant_assistant");
  const broken = await call("fred", "PUT", `/api/rosters/${created.json.id}/cells`, { cells: [{ ...night, code: "OFF" }] });
  assert.equal(broken.status, 200);
  assert.ok(broken.json.problems.length > 0);
  const refused = await call("fred", "POST", `/api/rosters/${created.json.id}/status`, { status: "submitted" });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /exactly 2 people/);
  await call("fred", "PUT", `/api/rosters/${created.json.id}/cells`, { cells: [night] });
  assert.equal((await call("fred", "POST", `/api/rosters/${created.json.id}/status`, { status: "submitted" })).status, 200);
  assert.equal((await call("fred", "POST", `/api/rosters/${created.json.id}/status`, { status: "approved" })).status, 403);
  assert.equal((await call("moses", "GET", "/api/rosters/n2/2026-11")).json.roster, null);
  assert.equal((await call("mgr", "POST", `/api/rosters/${created.json.id}/status`, { status: "returned" })).status, 400);
  assert.equal((await call("mgr", "POST", `/api/rosters/${created.json.id}/status`, { status: "approved" })).status, 200);
});

let kioskToken = "", kioskSecret = "", kioskId = "";
const photo = "data:image/jpeg;base64," + Buffer.alloc(4000, 7).toString("base64");

test("kiosk: manager registers the control-room phone; staff set a PIN; clock in with PIN and photo", { skip }, async () => {
  assert.equal((await call("moses", "POST", "/api/kiosk/register", { plantId: "n1" })).status, 403);
  const k = await call("mgr", "POST", "/api/kiosk/register", { plantId: "n1", label: "Nyamwamba 1 control room" });
  assert.equal(k.status, 200);
  kioskToken = k.json.token; kioskSecret = k.json.qrSecret; kioskId = k.json.deviceId;
  const kh = { "x-kiosk-token": kioskToken };

  assert.equal((await call("moses", "POST", "/api/me/pin", { pin: "1234" })).status, 400);
  assert.equal((await call("moses", "POST", "/api/me/pin", { pin: "4829" })).status, 200);

  const today = await call(null, "POST", "/api/kiosk/today", {}, kh);
  assert.equal(today.status, 200);
  const me = today.json.people.find((p: any) => p.name === "Moses Masereka");
  assert.equal(me.has_pin, true);
  assert.ok(!today.json.people.some((p: any) => p.name === "Fred Onzima"), "only this plant's staff and shared staff");

  assert.equal((await call(null, "POST", "/api/kiosk/today", {}, { "x-kiosk-token": "x".repeat(40) })).status, 401);
  const moses = await sid("Moses Masereka");
  assert.equal((await call(null, "POST", "/api/kiosk/clock", { staffId: moses, pin: "4829", kind: "in" }, kh)).status, 400);   // no photo
  assert.equal((await call(null, "POST", "/api/kiosk/clock", { staffId: moses, pin: "0000", kind: "in", photo }, kh)).status, 401);
  const ok = await call(null, "POST", "/api/kiosk/clock", { staffId: moses, pin: "4829", kind: "in", photo }, kh);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.ok(ok.json.flags.includes("kiosk_photo_review"));
  assert.equal((await call(null, "POST", "/api/kiosk/clock", { staffId: moses, pin: "4829", kind: "in", photo }, kh)).status, 409);
  const fred = await sid("Fred Onzima");
  await admin.query("insert into staff_secrets (staff_id, kiosk_pin_hash) values ($1, crypt('5931', gen_salt('bf')))", [fred]);
  const wrongPlant = await call(null, "POST", "/api/kiosk/clock", { staffId: fred, pin: "5931", kind: "in", photo }, kh);
  assert.equal(wrongPlant.status, 403);
});

test("photos: the manager and the person see a clock-in photo; a colleague doesn't", { skip }, async () => {
  const ev = (await admin.query("select id from clock_events where method = 'kiosk_pin_photo' limit 1")).rows[0].id;
  const m = await call("mgr", "GET", `/api/photos/${ev}`);
  assert.equal(m.status, 200);
  assert.equal(m.res.headers["content-type"], "image/jpeg");
  assert.equal((await call("moses", "GET", `/api/photos/${ev}`)).status, 200);
  assert.equal((await call("joseph", "GET", `/api/photos/${ev}`)).status, 404);
});

test("personal clock-in: refused until a fingerprint is set up and approved", { skip }, async () => {
  const r = await call("moses", "POST", "/api/clock/options");
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "no_passkey");
  const opts = await call("moses", "POST", "/api/passkeys/register-options");
  assert.equal(opts.status, 200);
  assert.equal(opts.json.rp.id, "shiftbook.test");
  assert.equal(opts.json.authenticatorSelection.userVerification, "required");
  // A clock-in without a fingerprint check is refused, even with a valid QR code
  const qr = await qrPayload(kioskId, Buffer.from(kioskSecret, "base64url"), qrWindow(Date.now()));
  const noKey = await call("moses", "POST", "/api/clock", { kind: "out", qr, assertion: { id: "fake" } });
  assert.equal(noKey.status, 400);   // no challenge was issued
});

test("leave: staff request, manager approves, roster shows it", { skip }, async () => {
  const r = await call("moses", "POST", "/api/leave", { type: "annual", from: "2026-11-21", to: "2026-11-22", reason: "Family visit" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.status, "pending");
  assert.equal((await call("moses", "POST", `/api/leave/${r.json.id}/decide`, { status: "approved" })).status, 400);
  assert.equal((await call("mgr", "POST", `/api/leave/${r.json.id}/decide`, { status: "approved" })).status, 200);
  const moses = await sid("Moses Masereka");
  const cells = (await call("moses", "GET", "/api/rosters/n1/2026-11")).json.cells;
  const day = (d: string) => cells.find((c: any) => c.staff_id === moses && c.day === d)?.code;
  assert.equal(day("2026-11-21"), "A/L", "a rostered night becomes A/L");
  assert.equal(day("2026-11-22"), "A/L");
});

test("overtime: one claim per month; staff can't approve their own", { skip }, async () => {
  const r = await call("moses", "POST", "/api/overtime", { month: "2026-10", otHours: 22.3, phHours: 0, reason: "Rostered shifts above contract" });
  assert.equal(r.status, 200);
  assert.equal((await call("moses", "POST", "/api/overtime", { month: "2026-10", otHours: 1, reason: "again" })).status, 409);
  assert.equal((await call("moses", "POST", `/api/overtime/${r.json.id}/decide`, { status: "approved" })).status, 400);
  assert.equal((await call("mgr", "POST", `/api/overtime/${r.json.id}/decide`, { status: "approved" })).status, 200);
});

test("exceptions and audit: the manager sees flagged clock-ins and who did what", { skip }, async () => {
  const x = await call("mgr", "GET", "/api/exceptions");
  assert.equal(x.status, 200);
  assert.ok(x.json.attendance.some((a: any) => a.kind === "flagged"));
  assert.equal((await call("moses", "GET", "/api/audit")).status, 403);
  const audit = await call("mgr", "GET", "/api/audit");
  assert.ok(audit.json.some((a: any) => a.action === "register_kiosk"));
});

test("sign out ends the session", { skip }, async () => {
  assert.equal((await call("moses", "POST", "/api/auth/logout")).status, 200);
  assert.equal((await call("moses", "GET", "/api/bootstrap")).status, 401);
});
