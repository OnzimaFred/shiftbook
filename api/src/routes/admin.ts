// Manager tools: sign-ins, PINs, phone approval, control-room phones, staff records, plants, holidays.
// Permission checks live in the database (row-level security and guarded functions); the role
// checks here just give clearer messages.
import type { FastifyInstance } from "fastify";
import { randomInt } from "node:crypto";
import { asService, asUser, one, many } from "../db.ts";
import { HttpError, str, uuidParam, requireRole, isDay } from "../http.ts";

const WORDS = "river,stone,falls,turbine,valley,rain,forest,bridge,light,water,hill,cloud,weir,intake".split(",");
/** Easy to read out and type on a phone, e.g. river-stone-4821. Changed at first sign-in. */
const tempPassword = () => `${WORDS[randomInt(WORDS.length)]}-${WORDS[randomInt(WORDS.length)]}-${String(randomInt(10000)).padStart(4, "0")}`;

const DESIGNATIONS = ["plant_manager", "maintenance_supervisor", "site_admin", "ehs_officer", "plant_technician_2",
  "plant_technician", "plant_assistant", "sanitation_environment", "machine_operator"];

export async function adminRoutes(app: FastifyInstance) {
  // ---------- Sign-ins ----------
  app.post("/api/staff/:id/sign-in", async (req) => {
    requireRole(req, "manager");
    const staffId = uuidParam(req);
    const username = str(req.body, "username", { required: true, max: 31 }).toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,30}$/.test(username)) throw new HttpError(400, "Use 3 to 31 letters, numbers, dots or dashes for the username.");
    const password = tempPassword();
    return asService(async (c) => {
      const person = await one(c, "select id, full_name, user_id, active from staff where id = $1", [staffId]);
      if (!person?.active) throw new HttpError(404, "That staff member wasn't found.");
      if (person.user_id) throw new HttpError(409, `${person.full_name} already has a sign-in. Reset the password instead.`);
      const u = await one<{ id: string }>(c, "select auth.create_user($1, $2) as id", [username, password])
        .catch((e) => { if (e.code === "23505") throw new HttpError(409, "That username is taken. Choose another."); throw e; });
      await c.query("update staff set user_id = $1 where id = $2", [u!.id, staffId]);
      await c.query("insert into audit_log (actor, action, entity, entity_id, details) values ($1, 'create_sign_in', 'staff', $2, $3)",
        [req.staff.id, staffId, { username }]);
      return { username, temporaryPassword: password, message: `Give ${person.full_name} this password in person. They choose their own at first sign-in.` };
    });
  });

  app.post("/api/staff/:id/reset-password", async (req) => {
    requireRole(req, "manager");
    const staffId = uuidParam(req);
    const password = tempPassword();
    return asService(async (c) => {
      const person = await one(c, "select full_name, user_id from staff where id = $1", [staffId]);
      if (!person) throw new HttpError(404, "That staff member wasn't found.");
      if (!person.user_id) throw new HttpError(409, `${person.full_name} doesn't have a sign-in yet.`);
      await c.query("select auth.reset_password($1, $2)", [person.user_id, password]);
      await c.query("insert into audit_log (actor, action, entity, entity_id) values ($1, 'reset_password', 'staff', $2)", [req.staff.id, staffId]);
      return { temporaryPassword: password, message: `Give ${person.full_name} this password in person. They've been signed out everywhere.` };
    });
  });

  // ---------- Control-room PINs ----------
  app.post("/api/me/pin", async (req) => {
    const pin = str(req.body, "pin", { required: true, max: 6 });
    await asUser(req.userId, (c) => c.query("select set_my_kiosk_pin($1)", [pin]));
    return { ok: true, message: "PIN saved. Use it on the control-room phone." };
  });
  app.post("/api/staff/:id/clear-pin", async (req) => {
    await asUser(req.userId, (c) => c.query("select clear_kiosk_pin($1)", [uuidParam(req)]));
    return { ok: true };
  });

  // ---------- Phones (passkeys) ----------
  app.get("/api/passkeys/mine", async (req) => asUser(req.userId, (c) => many(c,
    "select id, label, created_at, last_used_at, approved_at from passkeys where staff_id = me() and revoked_at is null order by created_at")));
  app.get("/api/passkeys/pending", async (req) => asUser(req.userId, (c) => many(c, "select * from pending_passkeys order by created_at")));
  app.post("/api/passkeys/:id/approve", async (req) => {
    await asUser(req.userId, (c) => c.query("select approve_passkey($1)", [uuidParam(req)]));
    return { ok: true, message: "Phone approved. They can now clock in with it." };
  });
  app.post("/api/passkeys/:id/remove", async (req) => {
    const r = await asUser(req.userId, (c) => c.query("update passkeys set revoked_at = now() where id = $1 and revoked_at is null", [uuidParam(req)]));
    if (!r.rowCount) throw new HttpError(404, "That phone wasn't found.");
    return { ok: true, message: "Phone removed. It can no longer clock in." };
  });

  // ---------- Control-room phones (kiosks) ----------
  app.get("/api/kiosk/devices", async (req) => asUser(req.userId, (c) => many(c,
    "select id, plant_id, label, active, last_seen_at, created_at from devices order by plant_id, created_at")));
  app.post("/api/kiosk/devices/:id/remove", async (req) => {
    requireRole(req, "manager");
    const r = await asUser(req.userId, (c) => c.query("update devices set active = false where id = $1 and active", [uuidParam(req)]));
    if (!r.rowCount) throw new HttpError(404, "That control-room phone wasn't found.");
    return { ok: true, message: "Control-room phone removed. Its codes stop working straight away." };
  });

  // ---------- Staff records ----------
  app.post("/api/staff", async (req) => {
    requireRole(req, "manager");
    const b = req.body as Record<string, unknown>;
    const designation = str(b, "designation", { required: true });
    if (!DESIGNATIONS.includes(designation)) throw new HttpError(400, "Choose a designation from the list.");
    const fromDate = str(b, "fromDate") || new Date().toISOString().slice(0, 10);
    if (!isDay(fromDate)) throw new HttpError(400, "The start date isn't valid.");
    return asUser(req.userId, async (c) => {
      const s = await one(c,
        `insert into staff (emp_no, full_name, designation, app_role, shift_letter) values (nullif($1, ''), $2, $3, $4, $5) returning id`,
        [str(b, "empNo", { max: 20 }), str(b, "fullName", { required: true, max: 80 }), designation, str(b, "appRole") || "staff", str(b, "shiftLetter", { required: true, max: 1 })]);
      await c.query("insert into staff_assignments (staff_id, plant_id, from_date) values ($1, nullif($2, ''), $3)", [s!.id, str(b, "plantId"), fromDate]);
      return { id: s!.id };
    });
  });

  app.patch("/api/staff/:id", async (req) => {
    requireRole(req, "manager");
    const b = req.body as Record<string, unknown>, id = uuidParam(req);
    const fields: [string, unknown][] = [];
    if (b.fullName !== undefined) fields.push(["full_name", str(b, "fullName", { required: true, max: 80 })]);
    if (b.empNo !== undefined) fields.push(["emp_no", str(b, "empNo", { max: 20 }) || null]);
    if (b.designation !== undefined) {
      const d = str(b, "designation", { required: true });
      if (!DESIGNATIONS.includes(d)) throw new HttpError(400, "Choose a designation from the list.");
      fields.push(["designation", d]);
    }
    if (b.appRole !== undefined) fields.push(["app_role", str(b, "appRole", { required: true })]);
    if (b.shiftLetter !== undefined) fields.push(["shift_letter", str(b, "shiftLetter", { required: true, max: 1 })]);
    if (b.active !== undefined) fields.push(["active", Boolean(b.active)]);
    if (!fields.length) throw new HttpError(400, "Nothing to change.");
    const sets = fields.map(([k], i) => `${k} = $${i + 2}`).join(", ");
    const r = await asUser(req.userId, (c) => c.query(`update staff set ${sets} where id = $1`, [id, ...fields.map(([, v]) => v)]));
    if (!r.rowCount) throw new HttpError(404, "That staff member wasn't found.");
    return { ok: true };
  });

  /** Moves someone to a plant from a date (null plant = shared staff). Used for transfers. */
  app.post("/api/staff/:id/assignments", async (req) => {
    requireRole(req, "manager");
    const fromDate = str(req.body, "fromDate", { required: true });
    if (!isDay(fromDate)) throw new HttpError(400, "The date isn't valid.");
    await asUser(req.userId, (c) => c.query(
      `insert into staff_assignments (staff_id, plant_id, from_date) values ($1, nullif($2, ''), $3)
       on conflict (staff_id, from_date) do update set plant_id = excluded.plant_id`, [uuidParam(req), str(req.body, "plantId"), fromDate]));
    return { ok: true };
  });

  // ---------- Plants, holidays, settings ----------
  app.put("/api/plants/:id/boundary", async (req) => {
    requireRole(req, "manager");
    const b = req.body as Record<string, unknown>;
    const lat = Number(b.lat), lng = Number(b.lng), radius = Math.round(Number(b.radiusM ?? 300));
    if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) throw new HttpError(400, "That location isn't valid.");
    const r = await asUser(req.userId, (c) => c.query("update plants set centre_lat = $2, centre_lng = $3, radius_m = $4 where id = $1",
      [(req.params as { id: string }).id, lat, lng, radius]));
    if (!r.rowCount) throw new HttpError(404, "That plant wasn't found.");
    return { ok: true };
  });

  app.put("/api/holidays/:day", async (req) => {
    const day = (req.params as { day: string }).day;
    if (!isDay(day)) throw new HttpError(400, "The date isn't valid.");
    await asUser(req.userId, (c) => c.query("insert into holidays (day, name) values ($1, $2) on conflict (day) do update set name = excluded.name",
      [day, str(req.body, "name", { required: true, max: 60 })]));
    return { ok: true };
  });
  app.delete("/api/holidays/:day", async (req) => {
    const day = (req.params as { day: string }).day;
    if (!isDay(day)) throw new HttpError(400, "The date isn't valid.");
    const r = await asUser(req.userId, (c) => c.query("delete from holidays where day = $1", [day]));
    if (!r.rowCount) throw new HttpError(404, "There's no holiday on that date.");
    return { ok: true };
  });

  app.put("/api/settings/:key", async (req) => {
    const key = (req.params as { key: string }).key;
    if (!/^[a-z_]{2,30}$/.test(key)) throw new HttpError(404, "Not found.");
    await asUser(req.userId, (c) => c.query(
      "insert into settings (key, value, updated_at) values ($1, $2, now()) on conflict (key) do update set value = excluded.value, updated_at = now()",
      [key, JSON.stringify((req.body as { value?: unknown })?.value ?? null)]));
    return { ok: true };
  });

  app.get("/api/audit", async (req) => {
    requireRole(req, "manager");
    return asUser(req.userId, (c) => many(c,
      `select a.at, a.action, a.entity, a.entity_id, a.details, s.full_name as actor
       from audit_log a left join staff s on s.id = a.actor order by a.at desc limit 200`));
  });
}
