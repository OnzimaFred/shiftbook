// Applies db/migrations/*.sql in order (each once), sets the API role's password, and seeds an
// empty database. Runs at container start, before the server. Safe to run repeatedly.
import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";

export async function migrate(log = console.log): Promise<void> {
  if (!config.adminDatabaseUrl) { log("DATABASE_ADMIN_URL isn't set, so migrations were skipped."); return; }
  const c = new pg.Client({ connectionString: config.adminDatabaseUrl });
  await c.connect();
  try {
    await c.query("select pg_advisory_lock(727401)");          // one runner at a time
    await c.query(`create schema if not exists meta;
      create table if not exists meta.migrations (name text primary key, applied_at timestamptz not null default now());
      revoke all on schema meta from public;`);
    const done = new Set((await c.query("select name from meta.migrations")).rows.map((r) => r.name));
    const dir = join(config.dbDir, "migrations");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(join(dir, f), "utf8");
      await c.query("begin");
      try {
        await c.query(sql);
        await c.query("insert into meta.migrations(name) values ($1)", [f]);
        await c.query("commit");
        log(`Applied ${f}`);
      } catch (e) {
        await c.query("rollback");
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
    }
    if (config.apiDbPassword) {
      const { rows } = await c.query("select format('alter role shiftbook_api login password %L', $1::text) as q", [config.apiDbPassword]);
      await c.query(rows[0].q);
    }
    const { rows } = await c.query("select count(*)::int as n from public.plants");
    if (rows[0].n === 0 && config.seed) {
      await c.query("begin");
      await c.query(await readFile(join(config.dbDir, "seed.sql"), "utf8"));
      await c.query("commit");
      log("Loaded the starting data (seed.sql).");
    }
  } finally {
    await c.query("select pg_advisory_unlock(727401)").catch(() => {});
    await c.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
}
