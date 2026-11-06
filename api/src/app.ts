// Builds the Shiftbook API. server.ts starts it; the tests use it directly.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { config } from "./config.ts";
import { asService, asUser, one } from "./db.ts";
import { HttpError, clientIp, type Staff } from "./http.ts";
import { authRoutes, SESSION_COOKIE } from "./routes/auth.ts";
import { clockRoutes } from "./routes/clock.ts";
import { kioskRoutes } from "./routes/kiosk.ts";
import { adminRoutes } from "./routes/admin.ts";
import { dataRoutes } from "./routes/data.ts";

const PG_ERRORS: Record<string, [number, string | null]> = {
  P0001: [400, null],                                                     // a guard's own message
  "42501": [403, "You don't have permission to do that."],               // includes row-level security refusals
  "23505": [409, "That already exists."],
  "23503": [400, "That refers to something that doesn't exist."],
  "23514": [400, "One of the values isn't allowed."],
  "22P02": [400, "One of the values isn't in the right format."],
  "22007": [400, "That date isn't valid."],
  "22008": [400, "That date isn't valid."],
};

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 600_000 });

  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute", keyGenerator: clientIp });

  // Security headers on every response
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Permissions-Policy", "camera=(self), geolocation=(self), microphone=()");
    reply.header("Content-Security-Policy",
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  });

  // Requests that change something must come from the app's own address (stops cross-site forgery).
  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/api/") || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const origin = req.headers.origin ?? (req.headers.referer ? new URL(req.headers.referer).origin : "");
    if (origin !== config.appOrigin) throw new HttpError(403, "That request didn't come from Shiftbook.");
  });

  // Who is signed in? Every /api route needs a session unless it's marked public.
  app.addHook("preHandler", async (req) => {
    if (!req.url.startsWith("/api/") || req.routeOptions.config?.public) return;
    const token = req.cookies[SESSION_COOKIE] ?? "";
    if (!/^[0-9a-f]{64}$/.test(token)) throw new HttpError(401, "Sign in to continue.", "signed_out");
    const s = await asService((c) => one<{ user_id: string; must_change_password: boolean }>(c,
      "select * from auth.session_user_id($1)", [token]));
    if (!s) throw new HttpError(401, "Your sign-in has expired. Sign in again.", "signed_out");
    const staff = await asUser(s.user_id, (c) => one<Staff>(c,
      "select id, full_name, designation, app_role, shift_letter, my_plant() as plant from staff where user_id = auth.uid() and active"));
    if (!staff) throw new HttpError(403, "This sign-in isn't linked to an active staff member. Ask the Plant Manager.");
    req.userId = s.user_id; req.staff = staff; req.sessionToken = token; req.mustChangePassword = s.must_change_password;
    if (s.must_change_password && !req.routeOptions.config?.allowWhilePasswordTemporary) {
      throw new HttpError(403, "Choose your own password first.", "must_change_password");
    }
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, code: err.code });
    if (err.statusCode === 429) return reply.status(429).send({ error: "Too many requests. Wait a minute and try again." });
    if (err.validation || err.statusCode === 400 || err.statusCode === 415) return reply.status(400).send({ error: "That request isn't in the right format." });
    if (err.statusCode === 413) return reply.status(413).send({ error: "That's too large." });
    const pg = err.code && PG_ERRORS[err.code];
    if (pg) return reply.status(pg[0]).send({ error: pg[1] ?? err.message });
    req.log.error(err);
    return reply.status(500).send({ error: "Something went wrong on the server. Try again in a moment." });
  });

  app.get("/api/health", { config: { public: true } }, async () => {
    await asService((c) => c.query("select 1"));
    return { ok: true };
  });

  await app.register(authRoutes);
  await app.register(clockRoutes);
  await app.register(kioskRoutes);
  await app.register(adminRoutes);
  await app.register(dataRoutes);

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "Not found." });
    return existsSync(config.publicDir + "index.html") ? reply.sendFile("index.html") : reply.status(404).send("Not found");
  });
  if (existsSync(config.publicDir)) await app.register(staticFiles, { root: config.publicDir, wildcard: false });

  return app;
}
