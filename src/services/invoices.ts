import type { Actor } from "../auth";
import { Batch, HttpError, all, one, id, nextSequence, assertPeriodOpen, type PropertyRow } from "../db";
import { formatINR } from "../domain/money";
import { loadBooking, paidOnBooking } from "./bookings";

export interface InvoiceLine { description: string; room_id: string; nights: number; rate_paise: number; taxable_paise: number; gst_rate_bp: number; gst_paise: number; }

/**
 * Issue the guest invoice for a stay. The invoice is dated the check-out date (the date of supply, and the month
 * the revenue is booked in), whenever it is issued. Number is sequential per FY per property and survives deletes
 * because the sequence is allocated by an atomic upsert and invoices are never deleted, only credited.
 * Idempotent: a stay that already has an issued invoice gets that one back.
 */
export async function issueInvoice(db: D1Database, p: PropertyRow, actor: Actor | null, bookingId: string, opts: { guestGstin?: string | null } = {}) {
  const bk = await loadBooking(db, p.id, bookingId);
  if (["cancelled", "no_show", "provisional"].includes(bk.status)) throw new HttpError(409, `booking is ${bk.status}`);
  const existing = await one<{ id: string; number: string }>(db, "SELECT id, number FROM invoices WHERE booking_id = ? AND status = 'issued'", bk.id);
  if (existing) return { id: existing.id, number: existing.number, duplicate: true as const };
  const issuedOn = bk.check_out;
  await assertPeriodOpen(db, p.id, issuedOn);
  const guest: any = await one(db, "SELECT * FROM guests WHERE id = ?", bk.guest_id);
  const rooms = await all<any>(db, "SELECT br.*, l.name AS room_name FROM booking_rooms br JOIN locations l ON l.id = br.room_id WHERE br.booking_id = ?", bk.id);
  const gstApplicable = !!p.gstin;
  const lines: InvoiceLine[] = rooms.map((rm) => ({
    description: `${rm.room_name} · ${rm.nights} night(s) × ${formatINR(rm.nightly_rate_paise)}`,
    room_id: rm.room_id, nights: rm.nights, rate_paise: rm.nightly_rate_paise, taxable_paise: rm.room_total_paise,
    gst_rate_bp: gstApplicable ? rm.gst_rate_bp : 0, gst_paise: gstApplicable ? rm.gst_paise : 0,
  }));
  const taxable = lines.reduce((a, l) => a + l.taxable_paise, 0);
  const gst = lines.reduce((a, l) => a + l.gst_paise, 0);
  const total = taxable + gst;
  // The guest of an OTA-collected stay paid the OTA in full: the invoice shows it paid through the OTA, nothing due.
  const channel = await one<{ name: string; collection_type: string }>(db, "SELECT name, collection_type FROM channels WHERE id = ?", bk.channel_id);
  const received = channel?.collection_type === "channel_collect" ? total : await paidOnBooking(db, bk.id);
  const { fy, seq } = await nextSequence(db, p.id, "invoice", issuedOn, p.fy_start_month);
  const number = `${p.invoice_prefix}/${fy}/${String(seq).padStart(3, "0")}`;
  const iid = id("inv");
  const b = new Batch(db, actor);
  b.add(`INSERT INTO invoices (id, property_id, booking_id, number, fy, seq, issued_on, guest_name, guest_phone, guest_gstin, lines_json, taxable_paise, gst_paise, total_paise, received_paise, balance_paise, gst_applicable, issued_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    iid, p.id, bk.id, number, fy, seq, issuedOn, guest.name, guest.phone, opts.guestGstin ?? null, JSON.stringify(lines), taxable, gst, total, received, total - received, gstApplicable ? 1 : 0, actor?.id ?? null);
  b.audit("invoice.issue", "invoice", iid, null, { number, booking_id: bk.id, issued_on: issuedOn, total_paise: total, gst_applicable: gstApplicable, ...(actor ? {} : { via: "auto at check-out" }) });
  await b.run();
  return { id: iid, number, issued_on: issuedOn, total_paise: total, received_paise: received, balance_paise: total - received, gst_applicable: gstApplicable, duplicate: false as const };
}

/** A direct guest's balance is collected at the desk before the invoice; after this long it is issued anyway. */
export const AUTO_INVOICE_AFTER_HOURS = 24;

/**
 * Cron step: every checked-out stay gets its invoice without anyone asking. OTA-collected stays at once; stays the
 * guest pays at the property once nothing is owed, or a day after check-out at the latest. Oldest check-out first, so
 * numbers follow the dates as far as they can. A stay in a locked month is left for the accountant (unlock first).
 */
export async function runAutoInvoices(db: D1Database, p: PropertyRow, now: string, limit = 25) {
  const cutoff = new Date(Date.parse(now) - AUTO_INVOICE_AFTER_HOURS * 3_600_000).toISOString();
  const due = await all<{ id: string }>(db, `SELECT b.id FROM bookings b JOIN channels ch ON ch.id = b.channel_id
     WHERE b.property_id = ? AND b.status = 'checked_out' AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.booking_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM period_locks l WHERE l.property_id = b.property_id AND l.period = substr(b.check_out, 1, 7) AND l.status IN ('locked','filed'))
       AND (ch.collection_type = 'channel_collect'
            OR b.gross_paise <= COALESCE((SELECT SUM(CASE WHEN kind = 'refund' THEN -amount_paise ELSE amount_paise END) FROM payments WHERE booking_id = b.id AND status != 'void'), 0)
            OR replace(COALESCE(b.checked_out_at, b.updated_at), ' ', 'T') <= ?)
     ORDER BY b.check_out, b.created_at LIMIT ?`, p.id, cutoff, limit);
  let issued = 0;
  for (const r of due) {
    try { if (!(await issueInvoice(db, p, null, r.id)).duplicate) issued++; } catch (e) { console.error("auto invoice failed", r.id, e); }
  }
  return { issued };
}
