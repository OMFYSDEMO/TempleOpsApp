import type { Actor } from "./auth";
import { newId } from "./domain/ids";
import { fyOf } from "./domain/dates";

export class HttpError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) { super(message); }
}

export type Stmt = D1PreparedStatement;

export interface PropertyRow {
  id: string; name: string; legal_name: string | null; address: string | null; gstin: string | null; state_code: string | null;
  timezone: string; fy_start_month: number; invoice_prefix: string;
  gst_nil_upto_paise: number;  gst_threshold_paise: number; gst_rate_below_bp: number; gst_rate_above_bp: number;
  auto_approve_on_tariff: number; auto_approve_max_rooms: number;
  quote_valid_hours: number; hold_hours: number; lead_nudge_minutes: number; lead_escalate_minutes: number;
  recon_fee_tolerance_bp: number; recon_subset_tolerance_bp: number;
  inbox_automation: number;
  pos_account_id: string | null;
}

export async function loadProperty(db: D1Database, id: string): Promise<PropertyRow> {
  const p = await db.prepare("SELECT * FROM properties WHERE id = ?").bind(id).first<PropertyRow>();
  if (!p) throw new HttpError(404, "property not found");
  return p;
}

/**
 * A unit of work: statements accumulate and run in ONE D1 batch, which is one SQLite transaction.
 * Every mutation that touches more than one row (and every audit entry) goes through this.
 */
export class Batch {
  private stmts: Stmt[] = [];
  constructor(public db: D1Database, public actor: Actor | null) {}

  add(sql: string, ...params: unknown[]): this {
    this.stmts.push(this.db.prepare(sql).bind(...params));
    return this;
  }

  audit(action: string, entity: string, entityId: string, before: unknown, after: unknown): this {
    return this.add(
      "INSERT INTO audit_log (property_id, actor_id, actor_email, action, entity, entity_id, before_json, after_json) VALUES (?,?,?,?,?,?,?,?)",
      this.actor?.property_id ?? "system", this.actor?.id ?? null, this.actor?.email ?? "system", action, entity, entityId,
      before === undefined || before === null ? null : JSON.stringify(before),
      after === undefined || after === null ? null : JSON.stringify(after),
    );
  }

  get size() { return this.stmts.length; }

  async run(): Promise<D1Result[]> {
    if (!this.stmts.length) return [];
    try {
      return await this.db.batch(this.stmts);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/UNIQUE constraint failed: room_nights/.test(msg)) throw new HttpError(409, "room is not available for one or more of those nights");
      if (/UNIQUE constraint failed/.test(msg)) throw new HttpError(409, `duplicate: ${msg.replace(/.*failed:\s*/, "")}`);
      throw e;
    }
  }
}

/**
 * Next sequential number for a property/FY. Uses an atomic upsert so two concurrent invoices
 * can never share a number; D1 serialises writes per database.
 */
export async function nextSequence(db: D1Database, propertyId: string, name: string, onDate: string, fyStartMonth: number): Promise<{ fy: string; seq: number }> {
  const fy = fyOf(onDate, fyStartMonth);
  const row = await db
    .prepare(
      `INSERT INTO sequences (property_id, name, fy, next) VALUES (?, ?, ?, 2)
       ON CONFLICT(property_id, name, fy) DO UPDATE SET next = next + 1
       RETURNING next - 1 AS seq`,
    )
    .bind(propertyId, name, fy)
    .first<{ seq: number }>();
  if (!row) throw new Error("sequence allocation failed");
  return { fy, seq: row.seq };
}

export function id(prefix: string) { return newId(prefix); }

/** The bank that receives money when nobody picks one: the account marked default, else the first active bank. */
export async function defaultBank(db: D1Database, propertyId: string): Promise<{ id: string; name: string; opening_date: string | null }> {
  const a = await one<{ id: string; name: string; opening_date: string | null }>(db, "SELECT id, name, opening_date FROM money_accounts WHERE property_id = ? AND kind = 'bank' AND active = 1 ORDER BY is_default DESC, id LIMIT 1", propertyId);
  if (!a) throw new HttpError(400, "no bank account configured");
  return a;
}

/** A bank account the caller named, checked to belong to the property and be active. */
export async function bankAccount(db: D1Database, propertyId: string, accountId: string): Promise<{ id: string; name: string; opening_date: string | null }> {
  const a = await one<{ id: string; name: string; opening_date: string | null }>(db, "SELECT id, name, opening_date FROM money_accounts WHERE id = ? AND property_id = ? AND kind = 'bank' AND active = 1", accountId, propertyId);
  if (!a) throw new HttpError(400, "unknown or inactive bank account");
  return a;
}

export async function one<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...params).first<T>()) ?? null;
}
export async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...params).all<T>()).results;
}
export async function must<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T> {
  const r = await one<T>(db, sql, ...params);
  if (!r) throw new HttpError(404, "not found");
  return r;
}

/** Period lock guard (F11): any write dated inside a locked month is refused at the API. */
export async function assertPeriodOpen(db: D1Database, propertyId: string, onDate: string): Promise<void> {
  const period = onDate.slice(0, 7);
  const row = await one<{ status: string }>(db, "SELECT status FROM period_locks WHERE property_id = ? AND period = ?", propertyId, period);
  if (row && (row.status === "locked" || row.status === "filed")) throw new HttpError(423, `period ${period} is ${row.status}; unlock it first`);
}
