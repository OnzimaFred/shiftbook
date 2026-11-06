// Fingerprint passkeys and clocking in from a personal phone.
// WHO: the phone's fingerprint passkey.  WHERE: the rotating QR code on the control-room phone, plus GPS.
// Hard failures are refused; borderline cases are recorded with flags for the Plant Manager.
import type { FastifyInstance } from "fastify";
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { config } from "../config.ts";
import { asService, one, many, type Db } from "../db.ts";
import { HttpError, str, plantTimeText } from "../http.ts";
import { verifyQr, parseQr, expectedShift, assess, plantClock } from "../clockcore.ts";

const CHALLENGE_MS = 5 * 60_000;

export const FLAG_TEXT: Record<string, string> = {
  late: "Recorded as late.",
  left_early: "Recorded as leaving before the end of your shift.",
  outside_boundary: "Your phone's location was outside the plant boundary, so the Plant Manager will review this.",
  no_location: "Your phone didn't share its location, so the Plant Manager will review this.",
  low_gps_accuracy: "Your phone's location was imprecise, so the Plant Manager will review this.",
  shared_phone: "This phone was used by someone else recently, so the Plant Manager will review this.",
  not_rostered: "You're not on the roster for this time, so the Plant Manager will review this.",
  kiosk_photo_review: "Your photo will be checked by the Plant Manager.",
  out_without_in: "There was no clock-in for this shift, so the Plant Manager will review this.",
  boundary_not_set: "",
};

const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
export const prevDay = (d: string) => new Date(Date.parse(d + "T00:00:00Z") - 86_400_000).toISOString().slice(0, 10);

async function saveChallenge(c: Db, staffId: string, purpose: "register" | "clock", challenge: string) {
  await c.query("delete from webauthn_challenges where staff_id = $1 and purpose = $2 and used_at is null", [staffId, purpose]);
  await c.query("insert into webauthn_challenges (staff_id, purpose, challenge, expires_at) values ($1, $2, $3, $4)",
    [staffId, purpose, challenge, new Date(Date.now() + CHALLENGE_MS)]);
}

/** Takes the latest unused challenge and marks it used, so it can't be replayed. */
async function takeChallenge(c: Db, staffId: string, purpose: "register" | "clock"): Promise<string> {
  const ch = await one<{ challenge: string }>(c,
    `update webauthn_challenges set used_at = now()
     where id = (select id from webauthn_challenges where staff_id = $1 and purpose = $2 and used_at is null
                 and expires_at > now() order by expires_at desc limit 1)
     returning challenge`, [staffId, purpose]);
  if (!ch) throw new HttpError(400, "That took too long. Start again.");
  return ch.challenge;
}

/** Facts about the shift, shared by personal and kiosk clock-ins. */
export async function shiftFacts(c: Db, staffId: string, letter: string, kind: "in" | "out", now: number) {
  const { date: today } = plantClock(now);
  const codes = await one<{ t: string | null; y: string | null }>(c,
    "select duty_code($1, $2::date) as t, duty_code($1, $3::date) as y", [staffId, today, prevDay(today)]);
  const def = await one<{ starts: string; ends: string }>(c, "select starts::text, ends::text from shift_definitions where letter = $1", [letter]);
  const expected = expectedShift(kind, now, (d) => (d === today ? codes?.t ?? undefined : codes?.y ?? undefined),
    def ? toMin(def.starts) : undefined, def ? toMin(def.ends) : undefined);
  const last = await one<{ kind: string; at: Date; qr_window: string | null }>(c,
    "select kind, at, qr_window from clock_events where staff_id = $1 order by at desc limit 1", [staffId]);
  return { today, expected, last };
}

export function refuseDoubleClockIn(kind: string, last: { kind: string; at: Date } | null, now: number, who = "You're") {
  if (kind === "in" && last?.kind === "in" && now - last.at.getTime() < 16 * 3600_000) {
    throw new HttpError(409, `${who} already clocked in since ${plantTimeText(last.at.getTime())}.`);
  }
}

export async function clockRoutes(app: FastifyInstance) {
  // ---------- Set up this phone's fingerprint ----------
  app.post("/api/passkeys/register-options", async (req) => asService(async (c) => {
    const active = await many(c, "select credential_id, transports from passkeys where staff_id = $1 and revoked_at is null", [req.staff.id]);
    if (active.length >= 2) throw new HttpError(409, "You already have 2 phones set up. Remove one before adding another.");
    const options = await generateRegistrationOptions({
      rpName: "Shiftbook", rpID: config.rpId, userName: req.staff.full_name,
      userID: new TextEncoder().encode(req.staff.id), attestationType: "none",
      excludeCredentials: active.map((k) => ({ id: k.credential_id, transports: k.transports })),
      authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
    });
    await saveChallenge(c, req.staff.id, "register", options.challenge);
    return options;
  }));

  app.post("/api/passkeys/register-verify", async (req) => {
    // Use up the challenge in its own transaction, so it stays used even if the check below fails.
    const challenge = await asService((c) => takeChallenge(c, req.staff.id, "register"));
    return asService(async (c) => {
    const body = req.body as { response?: any; label?: string };
    const v = await verifyRegistrationResponse({
      response: body.response, expectedChallenge: challenge,
      expectedOrigin: config.appOrigin, expectedRPID: config.rpId, requireUserVerification: true,
    }).catch(() => ({ verified: false as const, registrationInfo: undefined }));
    if (!v.verified || !v.registrationInfo) throw new HttpError(400, "The fingerprint set-up didn't complete. Try again.");
    const { credentialID, credentialPublicKey, counter } = v.registrationInfo;
    const label = str(body, "label", { max: 40 }) || "Phone";
    await c.query(
      "insert into passkeys (staff_id, credential_id, public_key, sign_count, transports, label) values ($1, $2, $3, $4, $5, $6)",
      [req.staff.id, credentialID, Buffer.from(credentialPublicKey), counter, body.response?.response?.transports ?? [], label]);
    await c.query("insert into audit_log (actor, action, entity, details) values ($1, 'register_passkey', 'passkeys', $2)",
      [req.staff.id, { label }]);
    return { ok: true, message: "Phone set up. Show it to the Plant Manager to approve it before you can clock in with it." };
    });
  });

  // ---------- Clock in or out ----------
  app.post("/api/clock/options", async (req) => asService(async (c) => {
    const keys = await many(c, "select credential_id, transports, approved_at from passkeys where staff_id = $1 and revoked_at is null", [req.staff.id]);
    const usable = keys.filter((k) => k.approved_at);
    if (!usable.length) {
      throw new HttpError(409, keys.length
        ? "This phone is waiting for the Plant Manager's approval. Until then, clock in on the control-room phone."
        : "Set up your fingerprint on this phone first, or clock in on the control-room phone.", keys.length ? "passkey_pending" : "no_passkey");
    }
    const options = await generateAuthenticationOptions({
      rpID: config.rpId, userVerification: "required",
      allowCredentials: usable.map((k) => ({ id: k.credential_id, transports: k.transports })),
    });
    await saveChallenge(c, req.staff.id, "clock", options.challenge);
    return options;
  }));

  app.post("/api/clock", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const kind = body.kind === "in" || body.kind === "out" ? body.kind as "in" | "out" : null;
    if (!kind) throw new HttpError(400, "Say whether you're clocking in or out.");
    const browserId = str(body, "browserId", { max: 64 }) || null;
    const now = Date.now();
    const staff = req.staff;

    // Use up the challenge in its own transaction, so a failed attempt can't be replayed.
    const challenge = await asService((c) => takeChallenge(c, staff.id, "clock"));
    return asService(async (c) => {
      // WHO: fingerprint passkey
      const key = await one(c,
        `select id, credential_id, public_key, sign_count, transports, approved_at from passkeys
         where staff_id = $1 and credential_id = $2 and revoked_at is null`, [staff.id, String(body.assertion?.id ?? "")]);
      if (!key) throw new HttpError(403, "This phone isn't set up for you. Clock in on the control-room phone.");
      if (!key.approved_at) throw new HttpError(403, "This phone is waiting for the Plant Manager's approval.");
      const v = await verifyAuthenticationResponse({
        response: body.assertion, expectedChallenge: challenge,
        expectedOrigin: config.appOrigin, expectedRPID: config.rpId, requireUserVerification: true,
        authenticator: { credentialID: key.credential_id, credentialPublicKey: new Uint8Array(key.public_key), counter: Number(key.sign_count), transports: key.transports },
      }).catch(() => null);
      if (!v?.verified) throw new HttpError(403, "The fingerprint check failed. Try again.");
      await c.query("update passkeys set sign_count = $2, last_used_at = now() where id = $1", [key.id, v.authenticationInfo.newCounter]);

      // WHERE: rotating QR code from a registered control-room phone
      const q = parseQr(String(body.qr ?? ""));
      if (!q) throw new HttpError(400, "Scan the code on the control-room phone.");
      const device = await one(c,
        "select d.id, d.plant_id, d.active, s.qr_secret from devices d join device_secrets s on s.device_id = d.id where d.id = $1", [q.deviceId]);
      if (!device?.active) throw new HttpError(403, "That control-room phone isn't registered. Ask the Plant Manager.");
      const qr = await verifyQr(String(body.qr), new Uint8Array(device.qr_secret), now);
      if (!qr.ok) throw new HttpError(403, qr.reason!);

      const { today, expected, last } = await shiftFacts(c, staff.id, staff.shift_letter, kind, now);
      const myPlant = (await one<{ p: string | null }>(c, "select plant_of($1, $2::date) as p", [staff.id, today]))?.p;
      if (myPlant && myPlant !== device.plant_id) throw new HttpError(403, "That code is from the other plant's control room. Scan the code at your own plant.");
      if (last && last.kind === kind && last.qr_window != null && Number(last.qr_window) === qr.window) throw new HttpError(409, "You've already done that with this code.");
      refuseDoubleClockIn(kind, last, now);

      const plant = await one(c, "select centre_lat, centre_lng, radius_m from plants where id = $1", [device.plant_id]);
      const others = browserId ? (await one<{ n: number }>(c,
        "select count(distinct staff_id)::int as n from clock_events where browser_id = $1 and staff_id <> $2 and at > now() - interval '12 hours'",
        [browserId, staff.id]))!.n : 0;
      const p = body.position;
      const position = p && Number.isFinite(p.lat) && Number.isFinite(p.lng)
        ? { lat: Number(p.lat), lng: Number(p.lng), accuracyM: Number(p.accuracy) || 9999 } : null;
      const verdict = assess({
        kind, nowMs: now, method: "personal_passkey", expected, otherStaffOnThisBrowser: others, position,
        plant: plant ? { centreLat: plant.centre_lat, centreLng: plant.centre_lng, radiusM: plant.radius_m } : null,
      });
      if (kind === "out" && last?.kind !== "in") verdict.flags.push("out_without_in");

      const ev = await one(c,
        `insert into clock_events (staff_id, plant_id, kind, method, kiosk_id, passkey_id, qr_window, lat, lng, accuracy_m, distance_m, browser_id, flags, created_by)
         values ($1, $2, $3, 'personal_passkey', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id, at`,
        [staff.id, device.plant_id, kind, device.id, key.id, qr.window, position?.lat ?? null, position?.lng ?? null,
         position?.accuracyM ?? null, verdict.distanceM, browserId, verdict.flags, req.userId]);
      const notes = verdict.flags.map((f) => FLAG_TEXT[f]).filter(Boolean);
      return {
        ok: true, id: ev!.id, at: ev!.at, flags: verdict.flags,
        message: `${kind === "in" ? "Clocked in" : "Clocked out"} at ${plantTimeText(now)}.` +
          (verdict.lateByMin ? ` ${verdict.lateByMin} minutes after your shift started.` : "") + (notes.length ? " " + notes.join(" ") : ""),
      };
    });
  });
}
