// Database access. Every request runs in its own transaction, in one of two roles:
//   asUser(id, ...)  -> role "authenticated" with app.user_id set; row-level security applies
//   asService(...)   -> role "service_role"; for the server's own checks (clock-in, kiosk, sign-in)
import pg from "pg";
import { config } from "./config.ts";

// Return dates and timestamps as strings exactly as Postgres sends them.
pg.types.setTypeParser(1082, (v: string) => v);           // date -> "2026-11-06"

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10, idleTimeoutMillis: 30_000 });
// An idle connection dropped by the database (restart, upgrade) must not crash the server; the pool replaces it.
pool.on("error", (err) => console.error("Database connection lost:", err.message));
export type Db = pg.PoolClient;

async function tx<T>(setup: (c: Db) => Promise<unknown>, fn: (c: Db) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await setup(c);
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export const asService = <T>(fn: (c: Db) => Promise<T>) =>
  tx((c) => c.query("set local role service_role"), fn);

export const asUser = <T>(userId: string, fn: (c: Db) => Promise<T>) =>
  tx(async (c) => {
    await c.query("set local role authenticated");
    await c.query("select set_config('app.user_id', $1, true)", [userId]);
  }, fn);

/** First row or null. */
export async function one<T = Record<string, any>>(c: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await c.query(sql, params);
  return (r.rows[0] as T) ?? null;
}
export async function many<T = Record<string, any>>(c: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await c.query(sql, params)).rows as T[];
}
