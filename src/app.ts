import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { Env } from "./env";
import { resolveActor, allowed, CAN, type Actor } from "./auth";
import { HttpError, loadProperty, type PropertyRow } from "./db";
import { assertIsoDate } from "./domain/dates";

export type AppEnv = { Bindings: Env; Variables: { actor: Actor; property: PropertyRow } };
export type Ctx = Context<AppEnv>;

export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const actor = await resolveActor(c.req.raw, c.env);
  if (!actor) throw new HttpError(401, "not signed in");
  c.set("actor", actor);
  c.set("property", await loadProperty(c.env.DB, actor.property_id));
  await next();
};

/** Role wall. Returns 403 for a role that may not use the capability, even if the screen is hidden. */
export function requireCap(cap: keyof typeof CAN): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!allowed(c.get("actor"), cap)) throw new HttpError(403, `${c.get("actor").role} may not use ${cap}`);
    await next();
  };
}

/** Allowed if the actor holds any one of the capabilities. */
export function requireAny(...caps: (keyof typeof CAN)[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!caps.some((cap) => allowed(c.get("actor"), cap))) throw new HttpError(403, `${c.get("actor").role} may not use ${caps.join(" or ")}`);
    await next();
  };
}

export function errorHandler(err: unknown, c: Context<AppEnv>) {
  if (err instanceof HttpError) return c.json({ error: err.message, detail: err.detail ?? null }, err.status as 400);
  console.error("unhandled", err);
  return c.json({ error: "internal error", detail: String((err as Error)?.message ?? err) }, 500);
}

export async function body<T = Record<string, unknown>>(c: Ctx): Promise<T> {
  try { return (await c.req.json()) as T; } catch { throw new HttpError(400, "invalid JSON body"); }
}

// --- tiny validators: fail loudly with the field name ---
export function str(v: unknown, label: string, opts: { optional?: boolean; max?: number } = {}): string {
  if (v === undefined || v === null || v === "") { if (opts.optional) return ""; throw new HttpError(400, `${label} is required`); }
  if (typeof v !== "string") throw new HttpError(400, `${label} must be a string`);
  if (opts.max && v.length > opts.max) throw new HttpError(400, `${label} too long`);
  return v.trim();
}
export function optStr(v: unknown, label: string): string | null { const s = str(v, label, { optional: true }); return s === "" ? null : s; }
export function int(v: unknown, label: string, opts: { min?: number; max?: number; optional?: boolean } = {}): number {
  if (v === undefined || v === null || v === "") { if (opts.optional) return 0; throw new HttpError(400, `${label} is required`); }
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) throw new HttpError(400, `${label} must be an integer`);
  if (opts.min !== undefined && n < opts.min) throw new HttpError(400, `${label} must be ≥ ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw new HttpError(400, `${label} must be ≤ ${opts.max}`);
  return n;
}
export function paise(v: unknown, label: string, opts: { allowZero?: boolean } = {}): number {
  const n = int(v, label, { min: opts.allowZero ? 0 : 1 });
  return n;
}
export function date(v: unknown, label: string): string { return assertIsoDate(str(v, label), label); }
export function optDate(v: unknown, label: string): string | null { const s = optStr(v, label); return s ? assertIsoDate(s, label) : null; }
export function oneOf<T extends string>(v: unknown, label: string, values: readonly T[]): T {
  const s = str(v, label);
  if (!values.includes(s as T)) throw new HttpError(400, `${label} must be one of ${values.join(", ")}`);
  return s as T;
}

export function newRouter() { return new Hono<AppEnv>(); }
