// The control-room phone (kiosk). It authenticates with its own token (header x-kiosk-token),
// not a staff sign-in. It shows the rotating QR code, and lets staff without a smartphone
// clock in with their PIN and a live photo.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";
import { asService, one, many, type Db } from "../db.ts";
import { HttpError, str, isUuid, requireRole, plantTimeText } from "../http.ts";
import { assess, plantClock } from "../clockcore.ts";
import { FLAG_TEXT, shiftFacts, refuseDoubleClockIn } from "./clock.ts";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const MAX_PHOTO_BYTES = 300_000;

async function kioskDevice(c: Db, req: FastifyRequest) {
  const token = String(req.headers["x-kiosk-token"] ?? "");
  if (token.length < 20) throw new HttpError(401, "This phone isn't registered as a control-room phone.");
  const d = await one(c,
    `select d.id, d.plant_id, d.label, d.active from device_secrets s join devices d on d.id = s.device_id where s.token_hash = $1`, [sha256(token)]);
  if (!d?.active) throw new HttpError(401, "This control-room phone has been removed. Ask the Plant Manager to register it again.");
  await c.query("update devices set last_seen_at = now() where id = $1", [d.id]);
  return d as { id: string; plant_id: string; label: string };
}

export async function kioskRoutes(app: FastifyInstance) {
  // The Plant Manager registers a phone. Returns the token and QR secret once; the kiosk screen keeps them.
  app.post("/api/kiosk/register", async (req) => {
    requireRole(req, "manager");
    const plantId = str(req.body, "plantId", { required: true, max: 10 });
    const label = str(req.body, "label", { max: 60 }) || "Control room phone";
    return asService(async (c) => {
      const plant = await one(c, "select id, name from plants where id = $1", [plantId]);
      if (!plant) throw new HttpError(400, "Choose Nyamwamba 1 or Nyamwamba 2.");
      const secret = randomBytes(32), token = randomBytes(32).toString("base64url");
      const d = await one(c, "insert into devices (plant_id, label, registered_by) values ($1, $2, $3) returning id", [plant.id, label, req.staff.id]);
      await c.query("insert into device_secrets (device_id, qr_secret, token_hash) values ($1, $2, $3)", [d!.id, secret, sha256(token)]);
      await c.query("insert into audit_log (actor, action, entity, entity_id, details) values ($1, 'register_kiosk', 'devices', $2, $3)",
        [req.staff.id, d!.id, { plant: plant.id, label }]);
      return { deviceId: d!.id, plantId: plant.id, plantName: plant.name, label, token, qrSecret: secret.toString("base64url") };
    });
  });

  app.post("/api/kiosk/ping", { config: { public: true } }, async (req) => asService(async (c) => {
    const d = await kioskDevice(c, req);
    return { serverTime: Date.now(), plantId: d.plant_id, label: d.label };
  }));

  app.post("/api/kiosk/today", { config: { public: true } }, async (req) => asService(async (c) => {
    const d = await kioskDevice(c, req);
    const { date } = plantClock(Date.now());
    return { people: await many(c, "select * from kiosk_people($1, $2::date)", [d.plant_id, date]) };
  }));

  app.post("/api/kiosk/clock", { config: { public: true, rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = body.kind === "out" ? "out" : "in";
    const staffId = str(body, "staffId", { required: true, max: 40 });
    const pin = str(body, "pin", { required: true, max: 6 });
    if (!isUuid(staffId)) throw new HttpError(400, "Choose your name from the list.");
    if (!/^\d{4,6}$/.test(pin)) throw new HttpError(400, "Enter your 4 to 6 digit PIN.");
    const m = /^data:(image\/(?:jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.photo ?? ""));
    if (!m) throw new HttpError(400, "Take your photo first.");
    const photo = Buffer.from(m[2], "base64");
    if (photo.length > MAX_PHOTO_BYTES) throw new HttpError(413, "The photo is too large. Take it again.");
    if (photo.length < 2000) throw new HttpError(400, "The photo didn't come through. Take it again.");
    const now = Date.now();

    // Check the PIN in its own transaction, so wrong tries still count when the clock-in is refused.
    const { device, staff, pinResult } = await asService(async (c) => {
      const device = await kioskDevice(c, req);
      const staff = await one(c, "select id, full_name, shift_letter, active from staff where id = $1", [staffId]);
      if (!staff?.active) throw new HttpError(404, "Choose your name from the list.");
      const r = await one<{ r: string }>(c, "select verify_kiosk_pin($1, $2) as r", [staff.id, pin]);
      if (r!.r === "wrong") {
        await c.query("insert into audit_log (action, entity, entity_id, details) values ('kiosk_wrong_pin', 'staff', $1, $2)", [staff.id, { device: device.id }]);
      }
      return { device, staff, pinResult: r!.r };
    });
    if (pinResult === "no_pin") throw new HttpError(409, "You haven't set a PIN yet. Set one in Shiftbook on your phone, or ask the Plant Manager.");
    if (pinResult === "locked") throw new HttpError(423, "Too many wrong PINs. Try again in 15 minutes, or ask the Plant Manager.");
    if (pinResult !== "ok") throw new HttpError(401, "That PIN isn't right.");

    return asService(async (c) => {
      const { today, expected, last } = await shiftFacts(c, staff.id, staff.shift_letter, kind, now);
      const plant = (await one<{ p: string | null }>(c, "select plant_of($1, $2::date) as p", [staff.id, today]))?.p;
      if (plant && plant !== device.plant_id) throw new HttpError(403, "You're not at this plant today. Use your own plant's control-room phone.");
      refuseDoubleClockIn(kind, last, now, `${staff.full_name} is`);

      const id = randomUUID();
      const rel = join(device.plant_id, today, `${id}.${m[1] === "image/webp" ? "webp" : "jpg"}`);
      await mkdir(join(config.photoDir, device.plant_id, today), { recursive: true });
      await writeFile(join(config.photoDir, rel), photo, { flag: "wx" });

      const verdict = assess({ kind, nowMs: now, method: "kiosk_pin_photo", plant: null, expected, otherStaffOnThisBrowser: 0 });
      if (kind === "out" && last?.kind !== "in") verdict.flags.push("out_without_in");
      await c.query(
        `insert into clock_events (id, staff_id, plant_id, kind, method, kiosk_id, photo_path, flags)
         values ($1, $2, $3, $4, 'kiosk_pin_photo', $5, $6, $7)`,
        [id, staff.id, device.plant_id, kind, device.id, rel, verdict.flags]);
      const notes = verdict.flags.map((f) => FLAG_TEXT[f]).filter(Boolean);
      return {
        ok: true, flags: verdict.flags,
        message: `${staff.full_name} ${kind === "in" ? "clocked in" : "clocked out"} at ${plantTimeText(now)}.` +
          (verdict.lateByMin ? ` ${verdict.lateByMin} minutes late.` : "") + (notes.length ? " " + notes.join(" ") : ""),
      };
    });
  });
}
