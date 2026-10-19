import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env";

export type Role = "sales" | "property" | "revenue" | "owner" | "accountant";

export interface Actor {
  id: string;
  property_id: string;
  email: string;
  name: string;
  role: Role;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Identify the caller. In production this is the Cloudflare Access JWT (verified against the team's
 * JWKS); the email claim is then looked up in `users`. Outside production, when Access is not
 * configured, an `x-dev-user` header or DEV_USER_EMAIL stands in so the API can be exercised locally.
 */
export async function resolveEmail(req: Request, env: Env): Promise<string | null> {
  const jwt = req.headers.get("Cf-Access-Jwt-Assertion");
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    if (!jwt) return null;
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    let jwks = jwksCache.get(issuer);
    if (!jwks) { jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)); jwksCache.set(issuer, jwks); }
    try {
      const { payload } = await jwtVerify(jwt, jwks, { issuer, audience: env.ACCESS_AUD });
      return typeof payload.email === "string" ? payload.email.toLowerCase() : null;
    } catch { return null; }
  }
  if (env.APP_ENV === "production") return null; // never fall through to dev identity in production
  const dev = req.headers.get("x-dev-user") || env.DEV_USER_EMAIL;
  return dev ? dev.toLowerCase() : null;
}

export async function loadActor(db: D1Database, email: string): Promise<Actor | null> {
  const row = await db.prepare("SELECT id, property_id, email, name, role FROM users WHERE email = ? AND active = 1").bind(email).first<Actor>();
  return row ?? null;
}

/** Role walls, enforced at the API (not just the menu). Owner keeps full rights as the safety net. */
export const CAN: Record<string, Role[]> = {
  leads: ["sales", "revenue", "owner"],
  inbox: ["sales", "revenue", "owner"],
  bookings_write: ["sales", "revenue", "owner"],
  bookings_read: ["sales", "property", "revenue", "owner", "accountant"],
  frontdesk: ["property", "owner"],
  payments: ["property", "revenue", "owner"],
  invoices: ["property", "revenue", "owner", "accountant"],
  tasks: ["property", "owner"],
  petty_expenses: ["property", "owner"],
  bank_expenses: ["owner"],
  transfers: ["property", "owner"],
  approvals: ["revenue", "owner"],
  settlements: ["revenue", "owner"],
  recon: ["revenue", "owner", "accountant"],
  revenue_reports: ["revenue", "owner", "accountant"],
  pnl_reports: ["owner", "accountant"],
  close: ["accountant", "owner"],
  gst: ["accountant", "owner"],
  admin: ["owner"],
  audit: ["owner", "accountant", "revenue"],
};

export function allowed(actor: Actor, cap: keyof typeof CAN): boolean {
  return CAN[cap].includes(actor.role);
}
