// Small request helpers shared by the routes.
import type { FastifyRequest } from "fastify";

export class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) { super(message); this.status = status; this.code = code; }
}

export interface Staff { id: string; full_name: string; designation: string; app_role: "staff" | "pt2" | "manager"; shift_letter: string; plant: string | null }

declare module "fastify" {
  interface FastifyRequest { userId: string; staff: Staff; sessionToken: string; mustChangePassword: boolean }
  interface FastifyContextConfig { public?: boolean; allowWhilePasswordTemporary?: boolean }
}

/** Reads a string field from a JSON body, trimmed, with a maximum length. */
export function str(body: unknown, key: string, opts: { required?: boolean; max?: number } = {}): string {
  const v = (body as Record<string, unknown> | null)?.[key];
  if (v == null || v === "") {
    if (opts.required) throw new HttpError(400, `Missing ${key}.`);
    return "";
  }
  if (typeof v !== "string" && typeof v !== "number") throw new HttpError(400, `${key} must be text.`);
  const s = String(v).trim();
  if (s.length > (opts.max ?? 500)) throw new HttpError(400, `${key} is too long.`);
  return s;
}

export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
export const isMonth = (s: string) => /^\d{4}-\d{2}(-01)?$/.test(s);
export const monthStart = (s: string) => s.slice(0, 7) + "-01";

export function uuidParam(req: FastifyRequest, key = "id"): string {
  const v = (req.params as Record<string, string>)[key];
  if (!isUuid(v)) throw new HttpError(404, "Not found.");
  return v;
}

export function requireRole(req: FastifyRequest, ...roles: Staff["app_role"][]) {
  if (!roles.includes(req.staff.app_role)) {
    throw new HttpError(403, roles.length === 1 && roles[0] === "manager" ? "Only the Plant Manager can do that." : "You don't have permission to do that.");
  }
}

/** The visitor's address. Behind Cloudflare, the real one is in CF-Connecting-IP. */
export const clientIp = (req: FastifyRequest) => (req.headers["cf-connecting-ip"] as string) || req.ip;

/** Plant local time is UTC+3 (Africa/Kampala). */
export const plantTimeText = (ms: number) => new Date(ms + 3 * 3600_000).toISOString().slice(11, 16);
