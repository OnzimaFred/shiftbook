// Run: cd api && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { qrPayload, verifyQr, qrWindow, distanceMetres, expectedShift, assess, plantClock, validPin } from "./clockcore.ts";

const secret = new TextEncoder().encode("test-secret-32-bytes-long-enough!");
const device = "3f1c2b9a-0d4e-4c55-9a71-2b8e6f0c1d23";
const at = (iso: string) => Date.parse(iso);            // ISO with offset

test("QR: a fresh code is accepted", async () => {
  const now = at("2026-11-06T07:01:10+03:00");
  const text = await qrPayload(device, secret, qrWindow(now));
  assert.deepEqual(await verifyQr(text, secret, now), { ok: true, window: qrWindow(now) });
});

test("QR: last window's code still works (slow scan), older ones don't", async () => {
  const now = at("2026-11-06T07:01:10+03:00");
  const prev = await qrPayload(device, secret, qrWindow(now) - 1);
  const old = await qrPayload(device, secret, qrWindow(now) - 3);
  assert.equal((await verifyQr(prev, secret, now)).ok, true);
  assert.equal((await verifyQr(old, secret, now)).ok, false);
  assert.match((await verifyQr(old, secret, now)).reason!, /expired/);
});

test("QR: a code made with a different kiosk's secret is refused", async () => {
  const now = Date.now();
  const forged = await qrPayload(device, new TextEncoder().encode("another-kiosk-secret-xxxxxxxxxxxx"), qrWindow(now));
  assert.equal((await verifyQr(forged, secret, now)).ok, false);
});

test("QR: tampered or junk text is refused", async () => {
  const now = Date.now();
  const good = await qrPayload(device, secret, qrWindow(now));
  const tampered = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
  assert.equal((await verifyQr(tampered, secret, now)).ok, false);
  assert.equal((await verifyQr("https://example.com", secret, now)).ok, false);
});

test("distance: 1 km north is about 1000 m", () => {
  const d = distanceMetres(0.2, 30.0, 0.2 + 1 / 111.2, 30.0);
  assert.ok(Math.abs(d - 1000) < 5, String(d));
});

test("plant time is UTC+3", () => {
  assert.deepEqual(plantClock(Date.parse("2026-11-05T22:30:00Z")), { date: "2026-11-06", minutes: 90 });
});

const codes = (m: Record<string, string>) => (d: string) => m[d];

test("shift: a 07:12 clock-in on a D/P day is 12 minutes late", () => {
  const now = at("2026-11-06T07:12:00+03:00");
  const exp = expectedShift("in", now, codes({ "2026-11-06": "D/P" }));
  const v = assess({ kind: "in", nowMs: now, method: "personal_passkey", plant: { centreLat: 0.3, centreLng: 30.0, radiusM: 300 },
    position: { lat: 0.3, lng: 30.0, accuracyM: 20 }, expected: exp, otherStaffOnThisBrowser: 0 });
  assert.deepEqual(v.flags, ["late"]);
  assert.equal(v.lateByMin, 12);
});

test("shift: a 06:58 clock-out the next morning belongs to last night's N/P", () => {
  const now = at("2026-11-07T06:58:00+03:00");
  const exp = expectedShift("out", now, codes({ "2026-11-06": "N/P", "2026-11-07": "OFF" }));
  assert.equal(exp?.day, "2026-11-06");
  const v = assess({ kind: "out", nowMs: now, method: "personal_passkey", plant: { centreLat: 0.3, centreLng: 30.0, radiusM: 300 },
    position: { lat: 0.3, lng: 30.0, accuracyM: 20 }, expected: exp, otherStaffOnThisBrowser: 0 });
  assert.deepEqual(v.flags, []);
});

test("shift: leaving a night shift at 05:00 is flagged as early", () => {
  const now = at("2026-11-07T05:00:00+03:00");
  const exp = expectedShift("out", now, codes({ "2026-11-06": "N/P" }));
  const v = assess({ kind: "out", nowMs: now, method: "personal_passkey", plant: null, position: null, expected: exp, otherStaffOnThisBrowser: 0 });
  assert.ok(v.flags.includes("left_early"));
});

test("flags: outside the boundary, shared phone, not rostered", () => {
  const now = at("2026-11-06T07:00:00+03:00");
  const v = assess({ kind: "in", nowMs: now, method: "personal_passkey",
    plant: { centreLat: 0.3, centreLng: 30.0, radiusM: 300 },
    position: { lat: 0.31, lng: 30.0, accuracyM: 30 },                 // ~1.1 km away
    expected: null, otherStaffOnThisBrowser: 1 });
  assert.deepEqual(v.flags, ["outside_boundary", "shared_phone", "not_rostered"]);
  assert.ok(v.distanceM! > 1000);
});

test("flags: a kiosk clock-in always goes for photo review", () => {
  const now = at("2026-11-06T08:00:00+03:00");
  const exp = expectedShift("in", now, codes({ "2026-11-06": "D" }), 480, 1020);
  const v = assess({ kind: "in", nowMs: now, method: "kiosk_pin_photo", plant: null, expected: exp, otherStaffOnThisBrowser: 0 });
  assert.deepEqual(v.flags, ["kiosk_photo_review"]);
});

test("PIN: 4-6 digits, not all the same, not a straight run", () => {
  assert.equal(validPin("4829"), true);
  assert.equal(validPin("1111"), false);
  assert.equal(validPin("1234"), false);
  assert.equal(validPin("987654"), false);
  assert.equal(validPin("12a4"), false);
});
