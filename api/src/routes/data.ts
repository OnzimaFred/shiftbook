// Everyday data for the app. Every query runs as the signed-in user, so row-level security in
// the database decides what each person can see and change.
import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { config } from "../config.ts";
import { asUser, one, many } from "../db.ts";
import { HttpError, str, uuidParam, isDay, isMonth, monthStart, isUuid } from "../http.ts";

const CODES = new Set(["D/P", "N/P", "N/W", "D", "O.T D/P", "O.T N/P", "OFF", "A/L", "S/L", "C/L", "ML", "U/L", ""]);
const LEAVE = new Set(["annual", "sick", "casual", "maternity_paternity", "unpaid"]);

interface CellIn { staffId: string; day: string; code: string; source?: string }
function cellsFrom(body: unknown): CellIn[] {
  const cells = (body as { cells?: unknown })?.cells;
  if (!Array.isArray(cells) || cells.length > 2000) throw new HttpError(400, "Send up to 2000 cells.");
  return cells.map((x: any) => {
    if (!isUuid(String(x?.staffId)) || !isDay(String(x?.day)) || !CODES.has(String(x?.code ?? ""))) {
      throw new HttpError(400, "One of the roster cells isn't valid.");
    }
    const source = ["rotation", "manual", "import"].includes(x.source) ? x.source : "manual";
    return { staffId: x.staffId, day: x.day, code: String(x.code ?? ""), source };
  });
}

export async function dataRoutes(app: FastifyInstance) {
  // Everything the app needs to draw its screens.
  app.get("/api/bootstrap", async (req) => asUser(req.userId, async (c) => ({
    me: req.staff,
    staff: await many(c, "select id, emp_no, full_name, designation, app_role, shift_letter, active, user_id is not null as has_sign_in from staff order by full_name"),
    assignments: await many(c, "select staff_id, plant_id, from_date from staff_assignments order by staff_id, from_date"),
    plants: await many(c, "select id, name, doc_name, centre_lat, centre_lng, radius_m from plants order by id"),
    shifts: await many(c, "select letter, starts::text, ends::text, days, rotating from shift_definitions order by letter"),
    holidays: await many(c, "select day, name from holidays order by day"),
    settings: Object.fromEntries((await many(c, "select key, value from settings")).map((r) => [r.key, r.value])),
  })));

  // ---------- Rosters ----------
  app.get("/api/rosters", async (req) => asUser(req.userId, (c) => many(c,
    `select r.id, r.plant_id, r.month, r.status, r.submitted_at, r.approved_at, r.return_note, p.full_name as prepared_by_name
     from rosters r left join staff p on p.id = r.prepared_by order by r.month desc, r.plant_id limit 60`)));

  app.get("/api/rosters/:plant/:month", async (req) => {
    const { plant, month } = req.params as { plant: string; month: string };
    if (!isMonth(month)) throw new HttpError(400, "The month isn't valid.");
    return asUser(req.userId, async (c) => {
      const roster = await one(c,
        `select r.*, p.full_name as prepared_by_name, a.full_name as approved_by_name from rosters r
         left join staff p on p.id = r.prepared_by left join staff a on a.id = r.approved_by
         where r.plant_id = $1 and r.month = $2`, [plant, monthStart(month)]);
      if (!roster) return { roster: null, cells: [], problems: [], covers: [] };
      return {
        roster,
        cells: await many(c, "select staff_id, day, code, source from roster_cells where roster_id = $1", [roster.id]),
        problems: await many(c, "select * from roster_problems($1)", [roster.id]),
        covers: await many(c, "select * from cover_assignments where plant_id = $1 and date_trunc('month', day) = $2::date", [plant, monthStart(month)]),
      };
    });
  });

  app.post("/api/rosters", async (req) => {
    const plantId = str(req.body, "plantId", { required: true, max: 10 });
    const month = str(req.body, "month", { required: true });
    if (!isMonth(month)) throw new HttpError(400, "The month isn't valid.");
    const cells = (req.body as { cells?: unknown }).cells ? cellsFrom(req.body) : [];
    return asUser(req.userId, async (c) => {
      const r = await one(c, "insert into rosters (plant_id, month, prepared_by) values ($1, $2, me()) returning id", [plantId, monthStart(month)]);
      for (const x of cells) {
        await c.query("insert into roster_cells (roster_id, staff_id, day, code, source) values ($1, $2, $3, $4, $5)", [r!.id, x.staffId, x.day, x.code, x.source ?? "rotation"]);
      }
      return { id: r!.id };
    });
  });

  app.put("/api/rosters/:id/cells", async (req) => {
    const id = uuidParam(req), cells = cellsFrom(req.body);
    return asUser(req.userId, async (c) => {
      let n = 0;
      for (const x of cells) {
        const r = await c.query(
          `insert into roster_cells (roster_id, staff_id, day, code, source) values ($1, $2, $3, $4, $5)
           on conflict (roster_id, staff_id, day) do update set code = excluded.code, source = excluded.source`,
          [id, x.staffId, x.day, x.code, x.source]);
        n += r.rowCount ?? 0;
      }
      return { saved: n, problems: await many(c, "select * from roster_problems($1)", [id]) };
    });
  });

  app.post("/api/rosters/:id/status", async (req) => {
    const status = str(req.body, "status", { required: true });
    if (!["draft", "submitted", "returned", "approved"].includes(status)) throw new HttpError(400, "Unknown status.");
    const note = str(req.body, "note", { max: 500 }) || null;
    const r = await asUser(req.userId, (c) => one(c,
      "update rosters set status = $2, return_note = coalesce($3, return_note) where id = $1 returning status, submitted_at, approved_at",
      [uuidParam(req), status, note]));
    if (!r) throw new HttpError(403, "You can't change this roster now.");
    return r;
  });

  // ---------- Leave ----------
  app.get("/api/leave", async (req) => asUser(req.userId, (c) => many(c,
    `select l.*, s.full_name from leave_requests l join staff s on s.id = l.staff_id
     order by l.status = 'pending' desc, l.from_date desc limit 500`)));

  app.post("/api/leave", async (req) => {
    const b = req.body as Record<string, unknown>;
    const type = str(b, "type", { required: true }), from = str(b, "from", { required: true }), to = str(b, "to", { required: true });
    if (!LEAVE.has(type)) throw new HttpError(400, "Choose a leave type.");
    if (!isDay(from) || !isDay(to) || to < from) throw new HttpError(400, "Check the dates: the end must be on or after the start.");
    const staffId = str(b, "staffId") || null;
    const status = str(b, "status") === "approved" ? "approved" : "pending";   // only allowed for managers and PT II sick days (database checks)
    return asUser(req.userId, (c) => one(c,
      `insert into leave_requests (staff_id, type, from_date, to_date, reason, status)
       values (coalesce($1::uuid, me()), $2, $3, $4, $5, $6) returning id, status`,
      [staffId, type, from, to, str(b, "reason", { max: 500 }), status]));
  });

  app.post("/api/leave/:id/decide", async (req) => {
    const status = str(req.body, "status", { required: true });
    if (!["approved", "declined", "cancelled"].includes(status)) throw new HttpError(400, "Approve or decline.");
    const r = await asUser(req.userId, (c) => one(c,
      "update leave_requests set status = $2, decision_note = $3 where id = $1 returning id, status",
      [uuidParam(req), status, str(req.body, "note", { max: 500 }) || null]));
    if (!r) throw new HttpError(404, "That request wasn't found.");
    return r;
  });

  // ---------- Overtime ----------
  app.get("/api/overtime", async (req) => asUser(req.userId, (c) => many(c,
    `select o.*, s.full_name from overtime_claims o join staff s on s.id = o.staff_id
     order by o.status = 'pending' desc, o.month desc limit 500`)));

  app.post("/api/overtime", async (req) => {
    const b = req.body as Record<string, unknown>;
    const month = str(b, "month", { required: true });
    if (!isMonth(month)) throw new HttpError(400, "The month isn't valid.");
    const ot = Number(b.otHours ?? 0), ph = Number(b.phHours ?? 0);
    if (!(ot >= 0 && ph >= 0 && ot + ph > 0 && ot <= 400 && ph <= 200)) throw new HttpError(400, "Enter overtime or public-holiday hours above zero.");
    return asUser(req.userId, (c) => one(c,
      "insert into overtime_claims (staff_id, month, ot_hours, ph_hours, reason) values (me(), $1, $2, $3, $4) returning id, status",
      [monthStart(month), ot, ph, str(b, "reason", { required: true, max: 500 })]))
      .catch((e) => { if (e.code === "23505") throw new HttpError(409, "You've already claimed that month. Cancel the existing claim to change it."); throw e; });
  });

  app.post("/api/overtime/:id/decide", async (req) => {
    const status = str(req.body, "status", { required: true });
    if (!["approved", "declined", "cancelled"].includes(status)) throw new HttpError(400, "Approve or decline.");
    const r = await asUser(req.userId, (c) => one(c, "update overtime_claims set status = $2 where id = $1 returning id, status", [uuidParam(req), status]));
    if (!r) throw new HttpError(404, "That claim wasn't found.");
    return r;
  });

  // ---------- Cover ----------
  app.post("/api/cover", async (req) => {
    const b = req.body as Record<string, unknown>;
    const day = str(b, "day", { required: true }), shift = str(b, "shift"), slot = str(b, "slot"), mode = str(b, "mode") || "full";
    if (!isDay(day) || !["D", "N"].includes(shift) || !["head", "asst"].includes(slot) || !["extend", "full"].includes(mode)) {
      throw new HttpError(400, "Check the cover details.");
    }
    return asUser(req.userId, (c) => one(c,
      `insert into cover_assignments (plant_id, day, shift, slot, for_staff_id, cover_staff_id, mode, ot_minutes, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, me()) returning id`,
      [str(b, "plantId", { required: true }), day, shift, slot, str(b, "forStaffId") || null, str(b, "coverStaffId", { required: true }), mode, Math.max(0, Math.round(Number(b.otMinutes ?? 0)))]))
      .catch((e) => { if (e.code === "23505") throw new HttpError(409, "Someone is already booked to cover that shift."); throw e; });
  });

  app.delete("/api/cover/:id", async (req) => {
    const r = await asUser(req.userId, (c) => c.query("delete from cover_assignments where id = $1", [uuidParam(req)]));
    if (!r.rowCount) throw new HttpError(404, "That cover booking wasn't found.");
    return { ok: true };
  });

  // ---------- Handover ----------
  app.get("/api/handovers/expected", async (req) => {
    const q = req.query as { plant?: string; day?: string; shift?: string };
    if (!q.plant || !isDay(q.day ?? "") || !["D", "N"].includes(q.shift ?? "")) throw new HttpError(400, "Choose the plant, day and shift.");
    return asUser(req.userId, (c) => many(c, "select * from handover_expected($1, $2, $3)", [q.plant, q.day, q.shift]));
  });

  app.post("/api/handovers", async (req) => {
    const b = req.body as Record<string, unknown>;
    const arrived = Array.isArray(b.arrived) ? b.arrived.map(String).filter(isUuid) : [];
    const shiftDate = str(b, "shiftDate", { required: true }), shift = str(b, "shift");
    if (!isDay(shiftDate) || !["D", "N"].includes(shift)) throw new HttpError(400, "Choose the shift you're handing over to.");
    return asUser(req.userId, (c) => one(c,
      `insert into handovers (plant_id, shift_date, shift, outgoing_head, arrived, note)
       values (my_plant(), $1, $2, me(), $3, $4) returning id`, [shiftDate, shift, arrived, str(b, "note", { max: 500 }) || null]))
      .catch((e) => { if (e.code === "23505") throw new HttpError(409, "That handover has already been confirmed."); throw e; });
  });

  // ---------- Attendance ----------
  app.get("/api/clock-events", async (req) => {
    const q = req.query as { from?: string; to?: string; staff?: string };
    const staff = q.staff && isUuid(q.staff) ? q.staff : null;
    const from = isDay(q.from ?? "") ? q.from : new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const to = isDay(q.to ?? "") ? q.to : new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    return asUser(req.userId, (c) => many(c,
      `select e.id, e.staff_id, s.full_name, e.plant_id, e.kind, e.at, e.method, e.distance_m, e.flags,
              e.photo_path is not null as has_photo, e.reviewed_at, e.review_note
       from clock_events e join staff s on s.id = e.staff_id
       where e.at >= $1::date - interval '3 hours' and e.at < $2::date - interval '3 hours' and ($3::uuid is null or e.staff_id = $3)
       order by e.at desc limit 2000`, [from, to, staff]));
  });

  app.get("/api/exceptions", async (req) => asUser(req.userId, async (c) => ({
    attendance: await many(c, `select x.*, s.full_name from attendance_exceptions x join staff s on s.id = x.staff_id order by x.at desc limit 300`),
    handovers: await many(c, "select * from handover_mismatches order by shift_date desc limit 100"),
    phones: await many(c, "select * from pending_passkeys order by created_at"),
  })));

  app.post("/api/clock-events/:id/review", async (req) => {
    const r = await asUser(req.userId, (c) => c.query("update clock_events set review_note = $2 where id = $1",
      [uuidParam(req), str(req.body, "note", { required: true, max: 300 })]));
    if (!r.rowCount) throw new HttpError(404, "That clock-in wasn't found.");
    return { ok: true };
  });

  // Clock-in photos: served only if the requester can read the clock-in (row-level security decides).
  app.get("/api/photos/:id", async (req, reply) => {
    const row = await asUser(req.userId, (c) => one<{ photo_path: string | null }>(c, "select photo_path from clock_events where id = $1", [uuidParam(req)]));
    if (!row?.photo_path) throw new HttpError(404, "No photo for that clock-in.");
    const file = normalize(join(config.photoDir, row.photo_path));
    if (!file.startsWith(normalize(config.photoDir)) || !existsSync(file)) throw new HttpError(404, "The photo file is missing.");
    reply.header("Cache-Control", "private, max-age=3600");
    return reply.type(file.endsWith(".webp") ? "image/webp" : "image/jpeg").send(createReadStream(file));
  });
}
