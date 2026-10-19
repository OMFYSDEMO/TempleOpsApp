import { env, SELF } from "cloudflare:test";
import seedSql from "../seed/meadows-varkala.sql?raw";

export const USERS = { shaji: "shajianandan@gmail.com", prachi: "bookings@meadowsvarkala.com", sindhu: "meadowsvarkala@gmail.com", trupti: "trupti@truvic.co.in", ca: "shubham.kandalkar@gmail.com" } as const;
export type User = keyof typeof USERS;

export async function seed() {
  const stmts = seedSql.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
  await env.DB.batch(stmts.map((s) => env.DB.prepare(s)));
}

export async function api<T = any>(user: User | null, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: T }> {
  const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
  if (user) headers["x-dev-user"] = USERS[user];
  const res = await SELF.fetch(`http://avos.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

export async function ok<T = any>(user: User, method: string, path: string, body?: unknown): Promise<T> {
  const r = await api<T>(user, method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

export const sql = <T = any>(q: string, ...params: unknown[]) => env.DB.prepare(q).bind(...params).all<T>().then((r) => r.results);
