import { HttpError, all, one, type PropertyRow } from "../db";
import { todayIn } from "../domain/dates";

/**
 * Cancellation policy (owner, Nov 2026): free cancellation up to 7 days before arrival; inside 7 days the total price is
 * charged; a no-show is charged. A cancellation by the hotel (overbooking, property issue) refunds in full.
 * "In full" is what Meadows actually received: the guest's payments less the gateway and card-machine charges deducted
 * before the money reached the bank. Refunds go by bank transfer only.
 */
export const FREE_CANCEL_DAYS = 7;
export const REASONS = ["guest_cancelled", "date_change", "overbooking", "hotel_cancelled", "no_show", "other"] as const;
export type ReasonCode = (typeof REASONS)[number];
const HOTEL_REASONS: ReasonCode[] = ["overbooking", "hotel_cancelled"];

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export async function refundQuote(db: D1Database, p: PropertyRow, bookingId: string, reason: ReasonCode, today = todayIn(p.timezone)) {
  const bk = await one<{ id: string; check_in: string; channel_id: string; status: string; cancelled_at: string | null }>(db, "SELECT id, check_in, channel_id, status, cancelled_at FROM bookings WHERE id = ? AND property_id = ?", bookingId, p.id);
  if (!bk) throw new HttpError(404, "booking not found");
  // Already cancelled: the policy counts from the day it was cancelled, not from when the refund is asked.
  if (["cancelled", "no_show"].includes(bk.status) && bk.cancelled_at) today = todayIn(p.timezone, new Date(bk.cancelled_at));
  const ch = await one<{ collection_type: string; name: string }>(db, "SELECT collection_type, name FROM channels WHERE id = ?", bk.channel_id);
  const pays = await all<{ id: string; method: string; kind: string; amount_paise: number; received_on: string; reference: string | null; charge_paise: number | null }>(db,
    `SELECT p.id, p.method, p.kind, p.amount_paise, p.received_on, p.reference,
            (SELECT e.amount_paise FROM expenses e WHERE e.id = p.fee_expense_id AND e.voided_at IS NULL) AS charge_paise
       FROM payments p WHERE p.booking_id = ? AND p.status != 'void' AND p.method != 'ota' ORDER BY p.received_on`, bk.id);
  const lines = pays.map((x) => ({ method: x.method, kind: x.kind, received_on: x.received_on, reference: x.reference, amount_paise: x.kind === "refund" ? -x.amount_paise : x.amount_paise, charge_paise: x.kind === "refund" ? 0 : (x.charge_paise ?? 0) }));
  const paid = lines.reduce((a, l) => a + l.amount_paise, 0);
  const charges = lines.reduce((a, l) => a + l.charge_paise, 0);
  const net = Math.max(0, paid - charges);
  const daysBefore = daysBetween(today, bk.check_in);
  const otaCollected = ch?.collection_type === "channel_collect";
  let policy: number; let rule: string;
  if (otaCollected) { policy = 0; rule = `the guest paid ${ch?.name}: the refund is theirs to make`; }
  else if (HOTEL_REASONS.includes(reason)) { policy = net; rule = "cancelled by the hotel: refund what we received in full"; }
  else if (reason === "no_show") { policy = 0; rule = "no-show: the cancellation fee applies, no refund"; }
  else if (daysBefore >= FREE_CANCEL_DAYS) { policy = net; rule = `${daysBefore} days before arrival: free cancellation, refund what we received`; }
  else { policy = 0; rule = `${Math.max(daysBefore, 0)} day${daysBefore === 1 ? "" : "s"} before arrival (inside ${FREE_CANCEL_DAYS}): the total price is charged, no refund`; }
  return { booking_id: bk.id, check_in: bk.check_in, today, days_before_arrival: daysBefore, ota_collected: otaCollected, lines, paid_paise: paid, charges_paise: charges, net_received_paise: net, policy_refund_paise: policy, rule };
}

export interface RefundInput {
  reason_code: ReasonCode; reason_note?: string | null; refund_paise: number; above_policy_reason?: string | null;
  payee_name?: string | null; account_no?: string | null; account_no_confirm?: string | null; ifsc?: string | null; bank_name?: string | null;
}

/** Check a refund request against the quote: never above what was received; above policy needs a reason; money needs a bank account. */
export function checkRefund(x: RefundInput, q: Awaited<ReturnType<typeof refundQuote>>) {
  if (!REASONS.includes(x.reason_code)) throw new HttpError(400, "pick a cancellation reason");
  if (x.reason_code === "other" && (x.reason_note ?? "").trim().length < 3) throw new HttpError(400, "say why the booking is cancelled");
  if (!Number.isInteger(x.refund_paise) || x.refund_paise < 0) throw new HttpError(400, "refund must be zero or more");
  if (x.refund_paise > q.net_received_paise) throw new HttpError(400, `refund cannot be more than what Meadows received (${q.net_received_paise / 100})`);
  if (x.refund_paise > q.policy_refund_paise && (x.above_policy_reason ?? "").trim().length < 3) throw new HttpError(400, "the refund is above the cancellation policy: say why (e.g. goodwill, owner agreed)");
  if (x.refund_paise === 0) return { payee_name: null, account_no: null, ifsc: null, bank_name: null };
  const name = (x.payee_name ?? "").trim();
  const acct = String(x.account_no ?? "").replace(/\s/g, "");
  const ifsc = String(x.ifsc ?? "").trim().toUpperCase();
  if (name.length < 3) throw new HttpError(400, "account holder's name is required");
  if (!/^\d{9,18}$/.test(acct)) throw new HttpError(400, "account number must be 9 to 18 digits");
  if (acct !== String(x.account_no_confirm ?? "").replace(/\s/g, "")) throw new HttpError(400, "the two account numbers do not match");
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw new HttpError(400, "IFSC must look like HDFC0001234");
  return { payee_name: name, account_no: acct, ifsc, bank_name: (x.bank_name ?? "").trim() || null };
}

export const REASON_LABEL: Record<ReasonCode, string> = { guest_cancelled: "guest cancelled", date_change: "date change", overbooking: "overbooking", hotel_cancelled: "cancelled by the hotel", no_show: "no-show", other: "other" };
