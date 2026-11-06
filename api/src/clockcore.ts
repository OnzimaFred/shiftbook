// Clock-in checks: rotating QR code, plant boundary, shift timing and flags. No imports, so it runs in
// the API server and in the Node test runner alike.

export const QR_WINDOW_SECONDS = 30;
export const PLANT_UTC_OFFSET_MIN = 180;          // Africa/Kampala, UTC+3, no daylight saving

// ---------- Rotating QR code ----------
const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export const qrWindow = (nowMs: number) => Math.floor(nowMs / 1000 / QR_WINDOW_SECONDS);

async function hmac(secret: Uint8Array, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

/** The text the kiosk shows as a QR code for one 30-second window. */
export async function qrPayload(deviceId: string, secret: Uint8Array, window: number): Promise<string> {
  const code = (await hmac(secret, `${deviceId}.${window}`)).slice(0, 12);
  return `SB1.${deviceId}.${window}.${code}`;
}

export function parseQr(text: string): { deviceId: string; window: number; code: string } | null {
  const m = /^SB1\.([0-9a-f-]{36})\.(\d{1,12})\.([0-9a-f]{12})$/.exec(text.trim());
  return m ? { deviceId: m[1], window: Number(m[2]), code: m[3] } : null;
}

/** Valid for the current window and the one before (up to ~60 s), plus one ahead for clock drift. */
export async function verifyQr(text: string, secret: Uint8Array, nowMs: number): Promise<{ ok: boolean; window?: number; reason?: string }> {
  const q = parseQr(text);
  if (!q) return { ok: false, reason: "That isn't a Shiftbook clock-in code." };
  const w = qrWindow(nowMs);
  if (q.window < w - 1 || q.window > w + 1) return { ok: false, reason: "That code has expired. Scan the code on the control-room phone again." };
  const expected = (await qrPayload(q.deviceId, secret, q.window)).split(".")[3];
  if (!timingSafeEqual(expected, q.code)) return { ok: false, reason: "That code isn't valid. Scan the code on the control-room phone again." };
  return { ok: true, window: q.window };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- Location ----------
export function distanceMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- Plant time ----------
export function plantClock(nowMs: number): { date: string; minutes: number } {
  const local = new Date(nowMs + PLANT_UTC_OFFSET_MIN * 60_000);
  return { date: local.toISOString().slice(0, 10), minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}
const prevDay = (d: string) => new Date(Date.parse(d + "T00:00:00Z") - 86_400_000).toISOString().slice(0, 10);

const START: Record<string, number> = { "D/P": 420, "O.T D/P": 420, "N/P": 1140, "O.T N/P": 1140, "N/W": 1140, "D": 480 };
const END: Record<string, number> = { "D/P": 1140, "O.T D/P": 1140, "N/P": 420 + 1440, "O.T N/P": 420 + 1440, "N/W": 420 + 1440, "D": 1020 };

export interface ExpectedShift { day: string; code: string; startMin: number; endMin: number }

/** Which rostered shift a clock-in or clock-out belongs to. Times are minutes from the
 *  start of `day`; night shifts end the next morning (> 1440). */
export function expectedShift(
  kind: "in" | "out", nowMs: number, codeFor: (day: string) => string | undefined,
  letterStartMin?: number, letterEndMin?: number,
): ExpectedShift | null {
  const { date, minutes } = plantClock(nowMs);
  const yesterday = prevDay(date);
  const y = codeFor(yesterday);
  // Before ~10:00 a clock-out (or a very late clock-in) belongs to last night's shift.
  if (y && END[y] && END[y] > 1440 && minutes < 600 && kind === "out") {
    return { day: yesterday, code: y, startMin: START[y], endMin: END[y] };
  }
  const t = codeFor(date);
  if (t && START[t] !== undefined) {
    const start = t === "D" && letterStartMin !== undefined ? letterStartMin : START[t];
    const end = t === "D" && letterEndMin !== undefined ? letterEndMin : END[t];
    return { day: date, code: t, startMin: start, endMin: end };
  }
  if (y && END[y] > 1440 && minutes < 600) return { day: yesterday, code: y, startMin: START[y], endMin: END[y] };
  return null;
}

// ---------- Flags ----------
export interface ClockFacts {
  kind: "in" | "out";
  nowMs: number;
  method: "personal_passkey" | "kiosk_pin_photo";
  plant: { centreLat: number | null; centreLng: number | null; radiusM: number } | null;
  position?: { lat: number; lng: number; accuracyM: number } | null;
  expected: ExpectedShift | null;
  /** Other staff who clocked in or out from this browser in the last 12 hours. */
  otherStaffOnThisBrowser: number;
  graceMin?: number;
}

export interface ClockVerdict { flags: string[]; distanceM: number | null; lateByMin: number }

export function assess(f: ClockFacts): ClockVerdict {
  const flags: string[] = [];
  let distanceM: number | null = null;
  if (f.method === "kiosk_pin_photo") flags.push("kiosk_photo_review");
  if (f.method === "personal_passkey") {
    if (!f.position) flags.push("no_location");
    else if (!f.plant || f.plant.centreLat == null || f.plant.centreLng == null) flags.push("boundary_not_set");
    else {
      distanceM = Math.round(distanceMetres(f.position.lat, f.position.lng, f.plant.centreLat, f.plant.centreLng));
      if (f.position.accuracyM > 250) flags.push("low_gps_accuracy");
      if (distanceM > f.plant.radiusM + Math.min(f.position.accuracyM, 250)) flags.push("outside_boundary");
    }
    if (f.otherStaffOnThisBrowser > 0) flags.push("shared_phone");
  }
  let lateByMin = 0;
  if (!f.expected) flags.push("not_rostered");
  else {
    const { minutes, date } = plantClock(f.nowMs);
    const now = minutes + (date === f.expected.day ? 0 : 1440);
    const grace = f.graceMin ?? 5;
    if (f.kind === "in" && now > f.expected.startMin + grace) { lateByMin = now - f.expected.startMin; flags.push("late"); }
    if (f.kind === "out" && now < f.expected.endMin - 15) flags.push("left_early");
  }
  return { flags, distanceM, lateByMin };
}

// ---------- Kiosk PIN ----------
export const validPin = (pin: string) => /^\d{4,6}$/.test(pin) && !/^(\d)\1+$/.test(pin) && !"0123456789".includes(pin) && !"9876543210".includes(pin);
