import { newRouter, requireCap, body, str, optStr, int, date, oneOf, paise } from "../app";
import { Batch, HttpError, all, one, id, assertPeriodOpen } from "../db";
import { nowIso, todayIn } from "../domain/dates";
import { applyBp } from "../domain/money";
import { loadBooking, paidOnBooking } from "../services/bookings";

const r = newRouter();

const METHODS = ["upi", "cash", "card", "airpay", "bank", "ota"] as const;
/** Contracted gateway fees (bp of amount) by method; the fee expense is booked once, here (F4). */
const GATEWAY_FEE_BP: Record<string, number> = { airpay: 200, card: 200, upi: 0, cash: 0, bank: 0, ota: 0 };

async function account(db: D1Database, propertyId: string, accountId: string) {
  const a: any = await one(db, "SELECT * FROM money_accounts WHERE id = ? AND property_id = ? AND active = 1", accountId, propertyId);
  if (!a) throw new HttpError(400, "unknown money account");
  return a;
}

/** Who owes money today: in-house or arriving direct guests with a balance, plus upcoming stays wanting an advance. */
r.get("/due", requireCap("payments"), async (c) => {
  const p = c.get("property");
  const today = todayIn(p.timezone);
  const rows = await all(c.env.DB,
    `SELECT b.id AS booking_id, g.name AS guest_name, g.phone AS guest_phone, b.check_in, b.check_out, b.status, b.gross_paise, ch.collection_type,
            (SELECT COALESCE(SUM(CASE WHEN kind='refund' THEN -amount_paise ELSE amount_paise END),0) FROM payments WHERE booking_id = b.id AND status != 'void') AS paid_paise
     FROM bookings b JOIN guests g ON g.id = b.guest_id JOIN channels ch ON ch.id = b.channel_id
     WHERE b.property_id = ? AND ch.collection_type != 'channel_collect' AND b.status IN ('approved','checked_in','checked_out','provisional') AND b.check_out >= ?
     ORDER BY b.check_in LIMIT 100`, p.id, today);
  const due = rows.map((x: any) => ({ ...x, balance_paise: x.gross_paise - x.paid_paise, due_today: x.status === "checked_in" || x.check_in === today || x.check_out === today })).filter((x: any) => x.balance_paise > 0);
  return c.json({ due: due.sort((a: any, b: any) => Number(b.due_today) - Number(a.due_today)) });
});

r.get("/", requireCap("payments"), async (c) => {
  const p = c.get("property");
  const from = c.req.query("from"), to = c.req.query("to"), bookingId = c.req.query("booking_id");
  const where = ["p.property_id = ?"]; const params: unknown[] = [p.id];
  if (from) { where.push("p.received_on >= ?"); params.push(date(from, "from")); }
  if (to) { where.push("p.received_on <= ?"); params.push(date(to, "to")); }
  if (bookingId) { where.push("p.booking_id = ?"); params.push(bookingId); }
  const rows = await all(c.env.DB, `SELECT p.*, g.name AS guest_name, a.name AS account_name, e.amount_paise AS fee_paise FROM payments p LEFT JOIN guests g ON g.id = p.guest_id JOIN money_accounts a ON a.id = p.account_id LEFT JOIN expenses e ON e.id = p.fee_expense_id WHERE ${where.join(" AND ")} ORDER BY p.received_on DESC, p.created_at DESC LIMIT 300`, ...params);
  return c.json({ payments: rows });
});

/** Airpay emails routed from the inbox, waiting for Sindhu to confirm against a stay. */
r.get("/gateway-inbox", requireCap("payments"), async (c) => {
  const p = c.get("property");
  const items = await all(c.env.DB, "SELECT * FROM inbox_items WHERE property_id = ? AND kind = 'payment' AND status = 'routed' ORDER BY received_at DESC", p.id);
  const out = [];
  for (const it of items as any[]) {
    const d = JSON.parse(it.parsed_json ?? "{}");
    // Order-id prefix match: Airpay order ids start with the SwiftBook itinerary number.
    let match: any = null;
    if (d.order_id) match = await one(c.env.DB, `SELECT b.id, b.gross_paise, b.external_ref, g.name AS guest_name FROM bookings b JOIN guests g ON g.id = b.guest_id WHERE b.property_id = ? AND b.external_ref IS NOT NULL AND ? LIKE b.external_ref || '%' AND b.status NOT IN ('cancelled','no_show') ORDER BY b.created_at DESC LIMIT 1`, p.id, String(d.order_id));
    out.push({ ...it, parsed: d, suggested_booking: match });
  }
  return c.json({ items: out });
});

/**
 * Record a payment. Rules: amount is the only typed field; advances and part-payments allowed; the
 * gateway fee expense is created here, once, at the contracted rate, linked to the payment.
 */
r.post("/", requireCap("payments"), async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const x = await body(c);
  const idem = optStr(x.idempotency_key, "idempotency_key");
  if (idem) { const ex = await one<{ id: string }>(c.env.DB, "SELECT id FROM payments WHERE property_id = ? AND idempotency_key = ?", p.id, idem); if (ex) return c.json({ id: ex.id, duplicate: true }); }
  const bookingId = optStr(x.booking_id, "booking_id");
  const method = oneOf(x.method, "method", METHODS);
  const amount = paise(x.amount_paise, "amount_paise");
  const receivedOn = optStr(x.received_on, "received_on") ?? todayIn(p.timezone);
  await assertPeriodOpen(c.env.DB, p.id, receivedOn);
  let guestId: string | null = optStr(x.guest_id, "guest_id");
  let kind: "advance" | "balance" = "balance";
  if (bookingId) {
    const bk = await loadBooking(c.env.DB, p.id, bookingId);
    if (["cancelled", "no_show"].includes(bk.status)) throw new HttpError(409, `booking is ${bk.status}`);
    guestId = bk.guest_id;
    kind = bk.status === "checked_in" || bk.status === "checked_out" ? "balance" : "advance";
  }
  // Default account by method: cash → cash in hand; upi/bank/card/airpay → bank (or the gateway clearing account if present).
  let accountId = optStr(x.account_id, "account_id");
  if (!accountId) {
    const kindWanted = method === "cash" ? "cash" : method === "airpay" || method === "card" ? "gateway" : "bank";
    const a = await one<{ id: string }>(c.env.DB, "SELECT id FROM money_accounts WHERE property_id = ? AND kind = ? AND active = 1 ORDER BY id LIMIT 1", p.id, kindWanted)
      ?? await one<{ id: string }>(c.env.DB, "SELECT id FROM money_accounts WHERE property_id = ? AND kind = 'bank' AND active = 1 LIMIT 1", p.id);
    if (!a) throw new HttpError(400, "no money account configured");
    accountId = a.id;
  } else await account(c.env.DB, p.id, accountId);
  const pid = id("pay");
  const b = new Batch(c.env.DB, actor);
  const feeBp = int(x.fee_bp ?? GATEWAY_FEE_BP[method] ?? 0, "fee_bp", { min: 0, max: 1000, optional: true });
  let feeId: string | null = null;
  if (feeBp > 0) {
    feeId = id("exp");
    const fee = applyBp(amount, feeBp);
    b.add(`INSERT INTO expenses (id, property_id, kind, category, description, amount_paise, gst_rate_bp, gst_paise, paid_from_account_id, on_date, payment_id, recorded_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, feeId, p.id, "gateway_fee", "bank_charges", `${method} fee ${feeBp / 100}% on payment ${pid}`, fee, 0, 0, accountId, receivedOn, pid, actor.id);
  }
  b.add(`INSERT INTO payments (id, property_id, booking_id, guest_id, kind, method, amount_paise, account_id, reference, received_on, status, fee_expense_id, inbox_item_id, recorded_by, idempotency_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    pid, p.id, bookingId, guestId, kind, method, amount, accountId, optStr(x.reference, "reference"), receivedOn, method === "airpay" && !x.inbox_item_id ? "recorded" : "confirmed", feeId, optStr(x.inbox_item_id, "inbox_item_id"), actor.id, idem);
  if (x.inbox_item_id) b.add("UPDATE inbox_items SET status = 'approved', payment_id = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ? AND property_id = ?", pid, actor.id, nowIso(), String(x.inbox_item_id), p.id);
  b.audit("payment.create", "payment", pid, null, { booking_id: bookingId, kind, method, amount_paise: amount, account_id: accountId, fee_expense_id: feeId });
  await b.run();
  const balance = bookingId ? (await loadBooking(c.env.DB, p.id, bookingId)).gross_paise - (await paidOnBooking(c.env.DB, bookingId)) : null;
  return c.json({ id: pid, kind, fee_expense_id: feeId, balance_paise: balance }, 201);
});

/** Void follows the payment through: its fee expense is voided in the same batch (F4). */
r.post("/:id/void", requireCap("payments"), async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const pay: any = await one(c.env.DB, "SELECT * FROM payments WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!pay) throw new HttpError(404, "payment not found");
  if (pay.status === "void") throw new HttpError(409, "already void");
  if (pay.status === "matched") throw new HttpError(409, "payment is reconciled to the bank; unmatch it first");
  await assertPeriodOpen(c.env.DB, p.id, pay.received_on);
  const x = await body(c);
  const reason = str(x.reason, "reason");
  const b = new Batch(c.env.DB, actor);
  b.add("UPDATE payments SET status = 'void', voided_at = ?, void_reason = ? WHERE id = ?", nowIso(), reason, pay.id);
  if (pay.fee_expense_id) b.add("UPDATE expenses SET voided_at = ?, void_reason = ? WHERE id = ?", nowIso(), `payment voided: ${reason}`, pay.fee_expense_id);
  b.audit("payment.void", "payment", pay.id, { status: pay.status, amount_paise: pay.amount_paise }, { status: "void", reason, fee_expense_voided: pay.fee_expense_id });
  await b.run();
  return c.json({ ok: true });
});

// ---- Money accounts and transfers (F6) ----
r.get("/accounts", requireCap("payments"), async (c) => {
  const p = c.get("property");
  const asOf = c.req.query("as_of") ?? todayIn(p.timezone);
  const rows = await all(c.env.DB,
    `SELECT a.*,
       a.opening_paise
       + COALESCE((SELECT SUM(CASE WHEN kind='refund' THEN -amount_paise ELSE amount_paise END) FROM payments WHERE account_id = a.id AND status != 'void' AND received_on <= ?),0)
       - COALESCE((SELECT SUM(amount_paise) FROM expenses WHERE paid_from_account_id = a.id AND voided_at IS NULL AND on_date <= ?),0)
       + COALESCE((SELECT SUM(amount_paise) FROM transfers WHERE to_account_id = a.id AND voided_at IS NULL AND on_date <= ?),0)
       - COALESCE((SELECT SUM(amount_paise) FROM transfers WHERE from_account_id = a.id AND voided_at IS NULL AND on_date <= ?),0) AS balance_paise
     FROM money_accounts a WHERE a.property_id = ? AND a.active = 1 ORDER BY a.kind`, asOf, asOf, asOf, asOf, p.id);
  const period = asOf.slice(0, 7);
  const spent = await all(c.env.DB, "SELECT paid_from_account_id AS account_id, SUM(amount_paise) AS spent_paise FROM expenses WHERE property_id = ? AND voided_at IS NULL AND substr(on_date,1,7) = ? GROUP BY paid_from_account_id", p.id, period);
  return c.json({ as_of: asOf, accounts: rows, spent_this_month: spent });
});

r.post("/transfers", requireCap("transfers"), async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const x = await body(c);
  const idem = optStr(x.idempotency_key, "idempotency_key");
  if (idem) { const ex = await one<{ id: string }>(c.env.DB, "SELECT id FROM transfers WHERE property_id = ? AND idempotency_key = ?", p.id, idem); if (ex) return c.json({ id: ex.id, duplicate: true }); }
  const from = await account(c.env.DB, p.id, str(x.from_account_id, "from_account_id"));
  const to = await account(c.env.DB, p.id, str(x.to_account_id, "to_account_id"));
  if (from.id === to.id) throw new HttpError(400, "from and to must differ");
  // Who holds the money records the movement: bank movements are the owner's; cash/petty movements the property's.
  const touchesBank = from.kind === "bank" || to.kind === "bank";
  if (touchesBank && !["owner", "property"].includes(actor.role)) throw new HttpError(403, "bank transfers are recorded by the owner");
  const amount = paise(x.amount_paise, "amount_paise");
  const onDate = optStr(x.on_date, "on_date") ?? todayIn(p.timezone);
  await assertPeriodOpen(c.env.DB, p.id, onDate);
  const tid = id("trf");
  const b = new Batch(c.env.DB, actor);
  b.add("INSERT INTO transfers (id, property_id, from_account_id, to_account_id, amount_paise, on_date, reference, note, recorded_by, idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?)",
    tid, p.id, from.id, to.id, amount, onDate, optStr(x.reference, "reference"), optStr(x.note, "note"), actor.id, idem);
  b.audit("transfer.create", "transfer", tid, null, { from: from.name, to: to.name, amount_paise: amount, on_date: onDate });
  await b.run();
  return c.json({ id: tid }, 201);
});

r.get("/transfers", requireCap("payments"), async (c) => {
  const p = c.get("property");
  const rows = await all(c.env.DB, "SELECT t.*, fa.name AS from_name, ta.name AS to_name FROM transfers t JOIN money_accounts fa ON fa.id = t.from_account_id JOIN money_accounts ta ON ta.id = t.to_account_id WHERE t.property_id = ? AND t.voided_at IS NULL ORDER BY t.on_date DESC LIMIT 200", p.id);
  return c.json({ transfers: rows });
});

export default r;
