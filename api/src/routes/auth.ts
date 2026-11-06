// Sign in, sign out, choose a password, and who am I.
import type { FastifyInstance } from "fastify";
import { config } from "../config.ts";
import { asService, one } from "../db.ts";
import { HttpError, str, clientIp } from "../http.ts";

export const SESSION_COOKIE = "shiftbook_session";

const cookieOptions = () => ({
  httpOnly: true, secure: config.cookieSecure, sameSite: "lax" as const, path: "/",
  maxAge: config.sessionDays * 86_400,
});

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", {
    config: { public: true, rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const username = str(req.body, "username", { required: true, max: 40 });
    const password = str(req.body, "password", { required: true, max: 200 });
    const r = await asService((c) => one<{ status: string; token: string; must_change_password: boolean }>(c,
      "select * from auth.login($1, $2, $3, $4, $5)",
      [username, password, String(req.headers["user-agent"] ?? ""), clientIp(req), config.sessionDays]));
    if (r?.status === "locked") throw new HttpError(423, "Too many wrong tries. Wait 15 minutes, or ask the Plant Manager to reset your password.");
    if (r?.status === "disabled") throw new HttpError(403, "This sign-in has been switched off. Ask the Plant Manager.");
    if (r?.status !== "ok") throw new HttpError(401, "That username or password isn't right.");
    reply.setCookie(SESSION_COOKIE, r.token, cookieOptions());
    return { ok: true, mustChangePassword: r.must_change_password };
  });

  app.post("/api/auth/logout", { config: { allowWhilePasswordTemporary: true } }, async (req, reply) => {
    await asService((c) => c.query("select auth.logout($1)", [req.sessionToken]));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post("/api/auth/password", {
    config: { allowWhilePasswordTemporary: true, rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req) => {
    const current = str(req.body, "current", { required: true, max: 200 });
    const next = str(req.body, "new", { required: true, max: 200 });
    const r = await asService((c) => one<{ s: string }>(c,
      "select auth.change_password($1, $2, $3, $4) as s", [req.userId, current, next, req.sessionToken]));
    if (r?.s === "wrong") throw new HttpError(400, "Your current password isn't right.");
    if (r?.s === "too_short") throw new HttpError(400, "Use at least 8 characters.");
    if (r?.s === "same") throw new HttpError(400, "Choose a password different from the temporary one.");
    return { ok: true, message: "Password changed. You've been signed out on your other devices." };
  });

  app.get("/api/me", { config: { allowWhilePasswordTemporary: true } }, async (req) => ({
    staff: req.staff, mustChangePassword: req.mustChangePassword,
  }));
}
