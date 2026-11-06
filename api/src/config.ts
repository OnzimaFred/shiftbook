// Settings come from environment variables (see .env.example at the project root).
const env = process.env;

const appOrigin = (env.APP_ORIGIN ?? "http://localhost:8080").replace(/\/$/, "");

export const config = {
  port: Number(env.PORT ?? 8080),
  /** The API's own connection: role shiftbook_api, which switches into authenticated or service_role per request. */
  databaseUrl: env.DATABASE_URL ?? "postgres://shiftbook_api@localhost:5432/shiftbook",
  /** Owner connection used only by the migration runner. */
  adminDatabaseUrl: env.DATABASE_ADMIN_URL ?? "",
  apiDbPassword: env.API_DB_PASSWORD ?? "",
  /** The address staff open, e.g. https://shiftbook.example.com. Passkeys and cookies are tied to it. */
  appOrigin,
  rpId: env.RP_ID ?? new URL(appOrigin).hostname,
  photoDir: env.PHOTO_DIR ?? "/data/photos",
  publicDir: env.PUBLIC_DIR ?? new URL("../public/", import.meta.url).pathname,
  dbDir: env.DB_DIR ?? new URL("../../db/", import.meta.url).pathname,
  cookieSecure: appOrigin.startsWith("https://"),
  sessionDays: Number(env.SESSION_DAYS ?? 30),
  /** Run seed.sql on first start when the database is empty. */
  seed: env.SEED !== "false",
};
