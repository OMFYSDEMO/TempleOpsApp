import { newRouter, requireCap, body, str, optStr, oneOf, paise } from "../app";
import { Batch, HttpError, all, one, id, assertPeriodOpen } from "../db";
import { nowIso, todayIn } from "../domain/dates";
import { notifyUser } from "../services/notify";

const r = newRouter();
r.use("*", requireCap("approvals"));

r.get("/", async (c) => {
  const p = c.get("property");
  const status = c.req.query("status") ?? "pending";
  const rows = await all(c.env.DB, `SELECT a.*, ru.name AS requested_name, du.name AS decided_name FROM approvals a LEFT JOIN users ru ON ru.id = a.requested_by LEFT JOIN users du ON du.id = a.decided_by
     WHERE a.property_id = ? AND a.status = ? ORDER BY a.created_at DESC LIMIT 100`, p.id, status);
  const recent = await all(c.env.DB, `SELECT a.*, du.name AS decided_name FROM approvals a LEFT JOIN users du ON du.id = a.decided_by WHERE a.property_id = ? AND a.status IN ('approved','returned') ORDER BY a.decided_at DESC LIMIT 20`, p.id);
  return c.json({ approvals: rows, recent });
});

/** Approve: bookings become approved; refunds are released to the owner to pay; others just record the decision. */
r.post("/:id/approve", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const a: any = await one(c.env.DB, "SELECT * FROM approvals WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!a) throw new HttpError(404, "approval not found");
  if (a.status !== "pending") throw new HttpError(409, `already ${a.status}`);
  const x = await body(c).catch(() => ({} as Record<string, unknown>));
  const now = nowIso();
  const b = new Batch(c.env.DB, actor);
  b.add("UPDATE approvals SET status = 'approved', decided_by = ?, decided_at = ?, note = ? WHERE id = ?", actor.id, now, optStr(x.note, "note"), a.id);
  if (a.kind === "booking") {
    const bk: any = await one(c.env.DB, "SELECT * FROM bookings WHERE id = ?", a.ref_id);
    if (!bk) throw new HttpError(404, "booking gone");
    if (bk.status === "provisional") b.add("UPDATE bookings SET status = 'approved', approved_by = ?, approved_at = ?, approval_mode = 'manual', updated_at = ? WHERE id = ?", actor.id, now, now, bk.id);
    b.audit("booking.approve", "booking", bk.id, { status: bk.status }, { status: "approved", by: actor.id });
    if (bk.created_by) notifyUser(b, p.id, bk.created_by, "booking_approved", `Booking ${bk.id} approved`, { kind: "booking", id: bk.id });
  } else if (a.kind === "refund") {
    const owners = await all<{ id: string }>(c.env.DB, "SELECT id FROM users WHERE property_id = ? AND role = 'owner' AND active = 1", p.id);
    for (const o of owners) notifyUser(b, p.id, o.id, "refund_to_pay", `Refund approved: ${(a.amount_paise / 100).toLocaleString("en-IN")} — make the bank transfer and record it`, { kind: "booking", id: a.ref_id });
  }
  b.audit("approval.approve", "approval", a.id, { status: "pending" }, { status: "approved", kind: a.kind, ref_id: a.ref_id });
  await b.run();
  return c.json({ ok: true });
});

r.post("/:id/return", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const a: any = await one(c.env.DB, "SELECT * FROM approvals WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!a) throw new HttpError(404, "approval not found");
  if (a.status !== "pending") throw new HttpError(409, `already ${a.status}`);
  const x = await body(c);
  const note = str(x.note, "note");
  const b = new Batch(c.env.DB, actor);
  b.add("UPDATE approvals SET status = 'returned', decided_by = ?, decided_at = ?, note = ? WHERE id = ?", actor.id, nowIso(), note, a.id);
  if (a.requested_by) notifyUser(b, p.id, a.requested_by, "approval_returned", `Returned: ${a.summary} — ${note}`, { kind: a.kind, id: a.ref_id });
  b.audit("approval.return", "approval", a.id, { status: "pending" }, { status: "returned", note });
  await b.run();
  return c.json({ ok: true });
});

/**
 * Refund execution (v1.5 in the mock; v1 here because cancellations happen from day one): after Trupti
 * approves, the owner records the bank transfer. The refund payment, its credit note (when an invoice
 * exists) and the audit entry are one batch. The bank debit then matches at reconciliation.
 */
r.post("/refunds/:approvalId/pay", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  if (actor.role !== "owner") throw new HttpError(403, "the owner makes the bank transfer");
  const a: any = await one(c.env.DB, "SELECT * FROM approvals WHERE id = ? AND property_id = ? AND kind = 'refund'", c.req.param("approvalId"), p.id);
  if (!a) throw new HttpError(404, "refund approval not found");
  if (a.status !== "approved") throw new HttpError(409, `refund is ${a.status}`);
  const existing = await one<{ id: string }>(c.env.DB, "SELECT id FROM payments WHERE refund_approval_id = ? AND status != 'void'", a.id);
  if (existing) throw new HttpError(409, "refund already recorded");
  const x = await body(c);
  const amount = x.amount_paise !== undefined ? paise(x.amount_paise, "amount_paise") : a.amount_paise;
  if (amount > a.amount_paise) throw new HttpError(400, "refund exceeds the approved amount");
  const onDate = optStr(x.on_date, "on_date") ?? todayIn(p.timezone);
  await assertPeriodOpen(c.env.DB, p.id, onDate);
  const bank = await one<{ id: string }>(c.env.DB, "SELECT id FROM money_accounts WHERE property_id = ? AND kind = 'bank' AND active = 1 LIMIT 1", p.id);
  if (!bank) throw new HttpError(400, "no bank account");
  const bk: any = await one(c.env.DB, "SELECT * FROM bookings WHERE id = ?", a.ref_id);
  const pid = id("pay");
  const b = new Batch(c.env.DB, actor);
  b.add(`INSERT INTO payments (id, property_id, booking_id, guest_id, kind, method, amount_paise, account_id, reference, received_on, status, refund_approval_id, recorded_by)
         VALUES (?,?,?,?,'refund',?,?,?,?,?,'confirmed',?,?)`, pid, p.id, bk.id, bk.guest_id, oneOf(x.method ?? "bank", "method", ["bank", "upi", "cash"] as const), amount, bank.id, optStr(x.reference, "reference"), onDate, a.id, actor.id);
  b.audit("refund.pay", "payment", pid, null, { booking_id: bk.id, amount_paise: amount, approval_id: a.id });
  await b.run();
  // Credit note if the stay was invoiced (handled by the invoices router's own numbering).
  const inv = await one<{ id: string; total_paise: number }>(c.env.DB, "SELECT id, total_paise FROM invoices WHERE booking_id = ? AND status = 'issued'", bk.id);
  return c.json({ id: pid, invoice_to_credit: inv ? { id: inv.id, suggested_total_paise: Math.min(amount, inv.total_paise) } : null }, 201);
});

export default r;
