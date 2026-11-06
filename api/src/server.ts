// Starts the Shiftbook API. In Docker: migrations run first (src/migrate.ts), then this.
import { buildApp } from "./app.ts";
import { config } from "./config.ts";
import { pool } from "./db.ts";

const app = await buildApp({ logger: true });
await app.listen({ host: "0.0.0.0", port: config.port });

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => { await app.close(); await pool.end(); process.exit(0); });
}
