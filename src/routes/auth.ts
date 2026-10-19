import { Hono } from "hono";
import type { Env } from "../env";
import { Batch, HttpError, one, id } from "../db";
import { nowIso } from "../domain/dates";
import {
  hashPassword, verifyPassword, passwordProblem, randomToken, sha256Hex, sessionCookie, cookieValue,
  resolveActor, SESSION_COOKIE, SESSION_DAYS, LOCK_AFTER_FAILURES, LOCK_MINUTES, type Actor,
} from "../auth";

/** Unauthenticated login endpoints. Mounted before the authenticate middleware. */
const r = new Hono<{ Bindings: Env }>();

async function jsonBody(c: any): Promise<Record<string, any>> {
  if (!(c.req.header("content-type") ?? "").includes("application/json")) throw new HttpError(415, "send JSON");
  try { return await c.req.json(); } catch { throw new HttpError(400, "invalid JSON body"); }
}

async function startSession(db: D1Database, req: Request, user: { id: string }, actorForAudit: Actor | null) {
  const value = randomToken(32);
  const sid = await sha256Hex(value);
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  const b = new Batch(db, actorForAudit);
  b.add("INSERT INTO sessions (id, user_id, expires_at, last_seen_at, user_agent) VALUES (?,?,?,?,?)", sid, user.id, expires, nowIso(), (req.headers.get("user-agent") ?? "").slice(0, 200));
  await b.run();
  return { cookie: sessionCookie(value, req, SESSION_DAYS * 86_400), expires };
}

export async function setPassword(db: D1Database, userId: string, password: string, mustChange: boolean, actor: Actor | null, action: string) {
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, problem);
  const { hash, salt, iterations } = await hashPassword(password);
  const b = new Batch(db, actor);
  b.add(`INSERT INTO credentials (user_id, password_hash, salt, iterations, must_change, failed_attempts, locked_until, updated_at) VALUES (?,?,?,?,?,0,NULL,?)
         ON CONFLICT(user_id) DO UPDATE SET password_hash = excluded.password_hash, salt = excluded.salt, iterations = excluded.iterations, must_change = excluded.must_change, failed_attempts = 0, locked_until = NULL, updated_at = excluded.updated_at`,
    userId, hash, salt, iterations, mustChange ? 1 : 0, nowIso());
  b.add("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", nowIso(), userId); // every other device signs out
  b.audit(action, "user", userId, null, { must_change: mustChange });
  await b.run();
}

export function appUrl(env: Env, req: Request): string {
  return (env.APP_URL && env.APP_URL.trim()) || new URL(req.url).origin;
}

/** Create a one-time set/reset link (72 h). The link is returned to the caller; emailing it is the caller's choice. */
export async function createPasswordLink(db: D1Database, env: Env, req: Request, userId: string, kind: "invite" | "reset", createdBy: string | null) {
  const token = randomToken(32);
  const b = new Batch(db, null);
  b.add("INSERT INTO password_tokens (id, user_id, kind, expires_at, created_by) VALUES (?,?,?,?,?)", await sha256Hex(token), userId, kind, new Date(Date.now() + 72 * 3_600_000).toISOString(), createdBy);
  await b.run();
  return `${appUrl(env, req)}/#reset?token=${token}`;
}

async function sendMail(env: Env, to: string, subject: string, text: string): Promise<boolean> {
  if (!env.EMAIL || !env.EMAIL_FROM) return false;
  try { await env.EMAIL.send({ from: env.EMAIL_FROM, to, subject, text }); return true; } catch (e) { console.error("email failed", e); return false; }
}

r.get("/session", async (c) => {
  const actor = await resolveActor(c.req.raw, c.env);
  if (!actor) return c.json({ signed_in: false, email_login: true, access_login: !!c.env.ACCESS_TEAM_DOMAIN });
  const cred = await one<{ must_change: number }>(c.env.DB, "SELECT must_change FROM credentials WHERE user_id = ?", actor.id);
  return c.json({ signed_in: true, email: actor.email, name: actor.name, role: actor.role, via: actor.via, must_change_password: !!cred?.must_change, has_password: !!cred });
});

r.post("/login", async (c) => {
  const x = await jsonBody(c);
  const email = String(x.email ?? "").trim().toLowerCase();
  const password = String(x.password ?? "");
  if (!email || !password) throw new HttpError(400, "email and password are required");
  const user = await one<{ id: string; property_id: string; email: string; name: string; role: string; active: number }>(c.env.DB, "SELECT id, property_id, email, name, role, active FROM users WHERE email = ?", email);
  const cred = user ? await one<{ password_hash: string; salt: string; iterations: number; must_change: number; failed_attempts: number; locked_until: string | null }>(c.env.DB, "SELECT * FROM credentials WHERE user_id = ?", user.id) : null;
  const generic = () => { throw new HttpError(401, "wrong email or password"); };
  if (!user || !user.active || !cred) { await hashPassword(password); generic(); } // constant-ish time: still run a hash
  if (cred!.locked_until && cred!.locked_until > nowIso()) throw new HttpError(423, `too many attempts; try again after ${LOCK_MINUTES} minutes`);
  const okPw = await verifyPassword(password, cred!.password_hash, cred!.salt, cred!.iterations);
  if (!okPw) {
    const attempts = cred!.failed_attempts + 1;
    const lock = attempts >= LOCK_AFTER_FAILURES ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
    const b = new Batch(c.env.DB, null);
    b.add("UPDATE credentials SET failed_attempts = ?, locked_until = ? WHERE user_id = ?", lock ? 0 : attempts, lock, user!.id);
    b.audit("login.failed", "user", user!.id, null, { attempts, locked: !!lock });
    await b.run();
    if (lock) throw new HttpError(423, `too many attempts; try again after ${LOCK_MINUTES} minutes`);
    generic();
  }
  const actor: Actor = { id: user!.id, property_id: user!.property_id, email: user!.email, name: user!.name, role: user!.role as Actor["role"], via: "session" };
  const b = new Batch(c.env.DB, actor);
  b.add("UPDATE credentials SET failed_attempts = 0, locked_until = NULL WHERE user_id = ?", user!.id);
  b.audit("login.success", "user", user!.id, null, { via: "password" });
  await b.run();
  const s = await startSession(c.env.DB, c.req.raw, user!, actor);
  c.header("set-cookie", s.cookie);
  return c.json({ ok: true, name: user!.name, role: user!.role, must_change_password: !!cred!.must_change });
});

r.post("/logout", async (c) => {
  const value = cookieValue(c.req.raw, SESSION_COOKIE);
  if (value) await c.env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(nowIso(), await sha256Hex(value)).run();
  c.header("set-cookie", sessionCookie("", c.req.raw, 0));
  return c.json({ ok: true });
});

/** Signed-in user changes their own password (also clears the must-change flag). */
r.post("/change-password", async (c) => {
  const actor = await resolveActor(c.req.raw, c.env);
  if (!actor) throw new HttpError(401, "not signed in");
  const x = await jsonBody(c);
  const cred = await one<{ password_hash: string; salt: string; iterations: number }>(c.env.DB, "SELECT * FROM credentials WHERE user_id = ?", actor.id);
  if (cred) {
    if (!(await verifyPassword(String(x.current_password ?? ""), cred.password_hash, cred.salt, cred.iterations))) throw new HttpError(401, "current password is wrong");
  } else if (actor.via !== "access" && actor.via !== "dev") throw new HttpError(400, "no password set; use a set-password link");
  await setPassword(c.env.DB, actor.id, String(x.new_password ?? ""), false, actor, "password.change");
  const s = await startSession(c.env.DB, c.req.raw, { id: actor.id }, actor); // this device stays signed in
  c.header("set-cookie", s.cookie);
  return c.json({ ok: true });
});

/** Forgot password: always answers the same way; sends a link only when an email provider is configured. */
r.post("/forgot", async (c) => {
  const x = await jsonBody(c);
  const email = String(x.email ?? "").trim().toLowerCase();
  const user = await one<{ id: string; name: string }>(c.env.DB, "SELECT id, name FROM users WHERE email = ? AND active = 1", email);
  let sent = false;
  if (user) {
    const link = await createPasswordLink(c.env.DB, c.env, c.req.raw, user.id, "reset", null);
    sent = await sendMail(c.env, email, "AVOS · reset your password", `Hi ${user.name},\n\nUse this link within 72 hours to set a new AVOS password:\n${link}\n\nIf you did not ask for this, ignore this mail.`);
    const b = new Batch(c.env.DB, null); b.audit("password.forgot", "user", user.id, null, { emailed: sent }); await b.run();
  }
  return c.json({ ok: true, message: c.env.EMAIL && c.env.EMAIL_FROM ? "If that address belongs to a user, a reset link has been emailed." : "Email sending is not set up yet: ask the owner for a reset link (Settings & users → Password link)." });
});

/** Set a password from an invite/reset link, then sign in. */
r.post("/reset", async (c) => {
  const x = await jsonBody(c);
  const token = String(x.token ?? "");
  if (!token) throw new HttpError(400, "token missing");
  const row = await one<{ id: string; user_id: string; kind: string; expires_at: string; used_at: string | null }>(c.env.DB, "SELECT * FROM password_tokens WHERE id = ?", await sha256Hex(token));
  if (!row || row.used_at || row.expires_at < nowIso()) throw new HttpError(400, "this link is invalid or has expired; ask for a new one");
  const user = await one<{ id: string; property_id: string; email: string; name: string; role: string }>(c.env.DB, "SELECT id, property_id, email, name, role FROM users WHERE id = ? AND active = 1", row.user_id);
  if (!user) throw new HttpError(400, "user is not active");
  const actor: Actor = { ...user, role: user.role as Actor["role"], via: "session" };
  await setPassword(c.env.DB, user.id, String(x.password ?? ""), false, actor, `password.${row.kind}`);
  await c.env.DB.prepare("UPDATE password_tokens SET used_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
  const s = await startSession(c.env.DB, c.req.raw, user, actor);
  c.header("set-cookie", s.cookie);
  return c.json({ ok: true, name: user.name, role: user.role });
});

export default r;
export { id as _id };
