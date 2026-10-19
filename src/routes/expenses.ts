import { newRouter, body, str, optStr, int, oneOf, paise } from "../app";
import { Batch, HttpError, all, one, id, assertPeriodOpen } from "../db";
import { nowIso, todayIn } from "../domain/dates";
import { gstinFormatValid } from "../domain/gst";
import { splitInclusive } from "../domain/money";
import { allowed } from "../auth";

const r = newRouter();
export const CATEGORIES = ["repairs", "fnb", "housekeeping", "amenities", "utilities", "subscriptions", "professional", "marketing", "bank_charges", "salaries", "misc"] as const;

/**
 * Expenses split by who holds the money (W5): petty-cash/cash expenses are the property manager's,
 * bank-paid expenses are the owner's. The role wall is on the *account*, not the screen.
 */
r.get("/", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const scope = c.req.query("scope") ?? (actor.role === "owner" || actor.role === "accountant" ? "all" : "petty");
  if (scope === "bank" && !allowed(actor, "bank_expenses")) throw new HttpError(403, "bank expenses are the owner's");
  if (scope === "all" && !allowed(actor, "pnl_reports")) throw new HttpError(403, "full expense view is owner/CA only");
  if (scope === "petty" && !allowed(actor, "petty_expenses")) throw new HttpError(403, "not allowed");
  const period = c.req.query("period") ?? todayIn(p.timezone).slice(0, 7);
  const kindFilter = scope === "bank" ? "AND a.kind = 'bank'" : scope === "petty" ? "AND a.kind IN ('petty_cash','cash')" : "";
  const rows = await all(c.env.DB, `SELECT e.*, a.name AS account_name, a.kind AS account_kind, u.name AS recorded_name FROM expenses e LEFT JOIN money_accounts a ON a.id = e.paid_from_account_id LEFT JOIN users u ON u.id = e.recorded_by
     WHERE e.property_id = ? AND substr(e.on_date,1,7) = ? ${kindFilter} ORDER BY e.on_date DESC, e.created_at DESC`, p.id, period);
  return c.json({ period, scope, expenses: rows, categories: CATEGORIES });
});

r.post("/", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const x = await body(c);
  const idem = optStr(x.idempotency_key, "idempotency_key");
  if (idem) { const ex = await one<{ id: string }>(c.env.DB, "SELECT id FROM expenses WHERE property_id = ? AND idempotency_key = ?", p.id, idem); if (ex) return c.json({ id: ex.id, duplicate: true }); }
  let acct: any = x.account_id ? await one(c.env.DB, "SELECT * FROM money_accounts WHERE id = ? AND property_id = ? AND active = 1", String(x.account_id), p.id) : null;
  if (!acct) {
    const wanted = actor.role === "owner" ? "bank" : "petty_cash";
    acct = await one(c.env.DB, "SELECT * FROM money_accounts WHERE property_id = ? AND kind = ? AND active = 1 LIMIT 1", p.id, wanted);
  }
  if (!acct) throw new HttpError(400, "no money account");
  if (acct.kind === "bank" && !allowed(actor, "bank_expenses")) throw new HttpError(403, "bank-paid bills are recorded by the owner, who holds the bank");
  if (acct.kind !== "bank" && !allowed(actor, "petty_expenses")) throw new HttpError(403, "petty cash is the property manager's");
  const amount = paise(x.amount_paise, "amount_paise");
  const onDate = optStr(x.on_date, "on_date") ?? todayIn(p.timezone);
  await assertPeriodOpen(c.env.DB, p.id, onDate);
  const gstin = optStr(x.vendor_gstin, "vendor_gstin");
  if (gstin && !gstinFormatValid(gstin)) throw new HttpError(400, "vendor GSTIN format is invalid (15 chars: 22AAAAA0000A1Z5)");
  const gstBp = int(x.gst_rate_bp ?? 0, "gst_rate_bp", { min: 0, max: 2800, optional: true });
  const { gst } = splitInclusive(amount, gstBp);
  const eid = id("exp");
  const b = new Batch(c.env.DB, actor);
  b.add(`INSERT INTO expenses (id, property_id, kind, category, description, vendor_name, vendor_gstin, bill_no, bill_date, amount_paise, gst_rate_bp, gst_paise, paid_from_account_id, on_date, reference, bill_photo_key, recorded_by, idempotency_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    eid, p.id, "normal", oneOf(x.category, "category", CATEGORIES), optStr(x.description, "description"), optStr(x.vendor_name, "vendor_name"), gstin?.toUpperCase() ?? null, optStr(x.bill_no, "bill_no"), optStr(x.bill_date, "bill_date"),
    amount, gstBp, gst, acct.id, onDate, optStr(x.reference, "reference"), optStr(x.bill_photo_key, "bill_photo_key"), actor.id, idem);
  b.audit("expense.create", "expense", eid, null, { amount_paise: amount, category: x.category, account: acct.name });
  await b.run();
  return c.json({ id: eid, gst_paise: gst, itc_note: p.gstin ? "GST on purchases is not creditable while rooms are supplied at the 5% slab" : null }, 201);
});

/** Capture first, classify later: vendor, bill no and photo can be filled in afterwards from the photo. */
r.patch("/:id", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const e: any = await one(c.env.DB, "SELECT e.*, a.kind AS account_kind FROM expenses e LEFT JOIN money_accounts a ON a.id = e.paid_from_account_id WHERE e.id = ? AND e.property_id = ?", c.req.param("id"), p.id);
  if (!e) throw new HttpError(404, "expense not found");
  if (e.kind !== "normal") throw new HttpError(409, "fee expenses follow their payment or settlement and cannot be edited directly");
  if (e.voided_at) throw new HttpError(409, "expense is void");
  if (e.account_kind === "bank" ? !allowed(actor, "bank_expenses") : !allowed(actor, "petty_expenses")) throw new HttpError(403, "not your account");
  await assertPeriodOpen(c.env.DB, p.id, e.on_date);
  const x = await body(c);
  const after: Record<string, unknown> = {};
  for (const k of ["description", "vendor_name", "bill_no", "bill_date", "bill_photo_key", "reference"]) if (x[k] !== undefined) after[k] = optStr(x[k], k);
  if (x.vendor_gstin !== undefined) { const g = optStr(x.vendor_gstin, "vendor_gstin"); if (g && !gstinFormatValid(g)) throw new HttpError(400, "vendor GSTIN format is invalid"); after.vendor_gstin = g?.toUpperCase() ?? null; }
  if (x.category !== undefined) after.category = oneOf(x.category, "category", CATEGORIES);
  if (x.gst_rate_bp !== undefined) { const bp = int(x.gst_rate_bp, "gst_rate_bp", { min: 0, max: 2800 }); after.gst_rate_bp = bp; after.gst_paise = splitInclusive(e.amount_paise, bp).gst; }
  if (x.amount_paise !== undefined) { const a = paise(x.amount_paise, "amount_paise"); after.amount_paise = a; after.gst_paise = splitInclusive(a, Number(after.gst_rate_bp ?? e.gst_rate_bp)).gst; }
  if (!Object.keys(after).length) throw new HttpError(400, "nothing to update");
  const b = new Batch(c.env.DB, actor);
  b.add(`UPDATE expenses SET ${Object.keys(after).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...Object.values(after), e.id);
  b.audit("expense.update", "expense", e.id, Object.fromEntries(Object.keys(after).map((k) => [k, e[k]])), after);
  await b.run();
  return c.json({ ok: true });
});

r.post("/:id/void", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const e: any = await one(c.env.DB, "SELECT e.*, a.kind AS account_kind FROM expenses e LEFT JOIN money_accounts a ON a.id = e.paid_from_account_id WHERE e.id = ? AND e.property_id = ?", c.req.param("id"), p.id);
  if (!e) throw new HttpError(404, "expense not found");
  if (e.kind !== "normal") throw new HttpError(409, "void the payment or undo the settlement instead; fee expenses follow them");
  if (e.account_kind === "bank" ? !allowed(actor, "bank_expenses") : !allowed(actor, "petty_expenses")) throw new HttpError(403, "not your account");
  await assertPeriodOpen(c.env.DB, p.id, e.on_date);
  const x = await body(c);
  const b = new Batch(c.env.DB, actor);
  b.add("UPDATE expenses SET voided_at = ?, void_reason = ? WHERE id = ?", nowIso(), str(x.reason, "reason"), e.id);
  b.audit("expense.void", "expense", e.id, { amount_paise: e.amount_paise }, { void: true, reason: x.reason });
  await b.run();
  return c.json({ ok: true });
});

export default r;
