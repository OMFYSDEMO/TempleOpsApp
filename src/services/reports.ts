import { all, one } from "../db";
import { periodRange } from "../domain/dates";

/** Revenue for a period, recognised on books_date (= check-out), ex-GST, net of credit notes. */
export async function revenueSummary(db: D1Database, propertyId: string, period: string) {
  const { from, to } = periodRange(period);
  const rev = await one<any>(db, `SELECT COALESCE(SUM(b.room_total_paise),0) AS taxable_paise, COALESCE(SUM(b.gst_paise),0) AS gst_paise, COALESCE(SUM(b.gross_paise),0) AS gross_paise, COUNT(*) AS stays,
      COALESCE(SUM(CASE WHEN ch.collection_type = 'direct' THEN b.room_total_paise ELSE 0 END),0) AS direct_taxable_paise
     FROM bookings b JOIN channels ch ON ch.id = b.channel_id WHERE b.property_id = ? AND b.status = 'checked_out' AND b.books_date BETWEEN ? AND ?`, propertyId, from, to);
  const cn = await one<any>(db, "SELECT COALESCE(SUM(taxable_paise),0) AS taxable_paise, COALESCE(SUM(gst_paise),0) AS gst_paise FROM credit_notes WHERE property_id = ? AND issued_on BETWEEN ? AND ?", propertyId, from, to);
  const bySource = await all<any>(db, `SELECT ch.name AS channel, ch.collection_type, COUNT(*) AS stays, SUM(b.room_total_paise) AS taxable_paise, SUM(b.gross_paise) AS gross_paise FROM bookings b JOIN channels ch ON ch.id = b.channel_id
     WHERE b.property_id = ? AND b.status = 'checked_out' AND b.books_date BETWEEN ? AND ? GROUP BY ch.id ORDER BY taxable_paise DESC`, propertyId, from, to);
  const bySlab = await all<any>(db, `SELECT br.gst_rate_bp, SUM(br.room_total_paise) AS taxable_paise, SUM(br.gst_paise) AS gst_paise FROM booking_rooms br JOIN bookings b ON b.id = br.booking_id
     WHERE b.property_id = ? AND b.status = 'checked_out' AND b.books_date BETWEEN ? AND ? GROUP BY br.gst_rate_bp`, propertyId, from, to);
  const otaClearing = await one<any>(db, `SELECT COALESCE(SUM(b.gross_paise),0) AS paise, COUNT(*) AS stays FROM bookings b JOIN channels ch ON ch.id = b.channel_id WHERE b.property_id = ? AND ch.collection_type = 'channel_collect' AND b.status = 'checked_out'
     AND b.id NOT IN (SELECT si.booking_id FROM settlement_items si JOIN settlements s ON s.id = si.settlement_id WHERE s.status = 'settled')`, propertyId);
  const advances = await one<any>(db, `SELECT COALESCE(SUM(p.amount_paise),0) AS paise, COUNT(*) AS n FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE p.property_id = ? AND p.kind = 'advance' AND p.status != 'void' AND p.received_on BETWEEN ? AND ? AND b.books_date > ?`, propertyId, from, to, to);
  const taxable = rev.taxable_paise - cn.taxable_paise;
  return {
    period, stays: rev.stays, taxable_paise: taxable, gst_paise: rev.gst_paise - cn.gst_paise, gross_paise: rev.gross_paise - cn.taxable_paise - cn.gst_paise,
    direct_share_pct: rev.taxable_paise ? Math.round((rev.direct_taxable_paise * 100) / rev.taxable_paise) : 0,
    credit_notes: cn, by_source: bySource, by_slab: bySlab, ota_clearing: otaClearing,
    advances_for_future_stays: advances, // GST time-of-supply note for the CA (F2)
  };
}

export async function expenseSummary(db: D1Database, propertyId: string, period: string) {
  const { from, to } = periodRange(period);
  const byCat = await all<any>(db, `SELECT category, kind, SUM(amount_paise) AS amount_paise, SUM(gst_paise) AS gst_paise, COUNT(*) AS n FROM expenses WHERE property_id = ? AND voided_at IS NULL AND on_date BETWEEN ? AND ? GROUP BY category, kind ORDER BY amount_paise DESC`, propertyId, from, to);
  const total = byCat.reduce((a, r) => a + r.amount_paise, 0);
  const otaCosts = byCat.filter((r) => r.kind !== "normal").reduce((a, r) => a + r.amount_paise, 0);
  return { period, total_paise: total, ota_and_gateway_costs_paise: otaCosts, operating_paise: total - otaCosts, by_category: byCat };
}

/** The pre-close exceptions the revenue desk clears before the CA locks (W9). */
export async function precloseExceptions(db: D1Database, propertyId: string, period: string) {
  const { from, to } = periodRange(period);
  const unreconciled = await all<any>(db, "SELECT id, on_date, description, amount_paise, status FROM bank_statement_lines WHERE property_id = ? AND on_date BETWEEN ? AND ? AND status IN ('unmatched','proposed') ORDER BY on_date", propertyId, from, to);
  const partPaid = await all<any>(db, `SELECT b.id, g.name AS guest_name, b.gross_paise, b.check_out, ch.collection_type,
      (SELECT COALESCE(SUM(CASE WHEN kind='refund' THEN -amount_paise ELSE amount_paise END),0) FROM payments WHERE booking_id = b.id AND status != 'void') AS paid_paise
     FROM bookings b JOIN guests g ON g.id = b.guest_id JOIN channels ch ON ch.id = b.channel_id WHERE b.property_id = ? AND b.status = 'checked_out' AND b.books_date BETWEEN ? AND ? AND ch.collection_type != 'channel_collect'`, propertyId, from, to);
  const missingBills = await all<any>(db, "SELECT id, on_date, category, amount_paise, vendor_name, bill_no, bill_photo_key FROM expenses WHERE property_id = ? AND kind = 'normal' AND voided_at IS NULL AND on_date BETWEEN ? AND ? AND (vendor_name IS NULL OR bill_no IS NULL)", propertyId, from, to);
  const pendingApprovals = await all<any>(db, "SELECT id, kind, summary, amount_paise, created_at FROM approvals WHERE property_id = ? AND status = 'pending'", propertyId);
  const unsettled = await all<any>(db, `SELECT b.id, b.external_ref, b.check_out, b.gross_paise FROM bookings b JOIN channels ch ON ch.id = b.channel_id WHERE b.property_id = ? AND ch.collection_type = 'channel_collect' AND b.status = 'checked_out' AND b.books_date BETWEEN ? AND ?
     AND b.id NOT IN (SELECT si.booking_id FROM settlement_items si JOIN settlements s ON s.id = si.settlement_id WHERE s.status = 'settled')`, propertyId, from, to);
  const uninvoiced = await all<any>(db, `SELECT b.id, g.name AS guest_name, b.check_out FROM bookings b JOIN guests g ON g.id = b.guest_id JOIN channels ch ON ch.id = b.channel_id WHERE b.property_id = ? AND b.status = 'checked_out' AND b.books_date BETWEEN ? AND ? AND ch.collection_type = 'direct' AND b.id NOT IN (SELECT booking_id FROM invoices)`, propertyId, from, to);
  const inHouseOverdue = await all<any>(db, "SELECT id, check_out FROM bookings WHERE property_id = ? AND status = 'checked_in' AND check_out <= ?", propertyId, to);
  return {
    period,
    unreconciled_bank_lines: unreconciled,
    part_paid_stays: partPaid.filter((x) => x.gross_paise !== x.paid_paise),
    expenses_missing_bill_details: missingBills,
    pending_approvals: pendingApprovals,
    unsettled_ota_stays: unsettled,
    uninvoiced_direct_stays: uninvoiced,
    stays_not_checked_out: inHouseOverdue,
  };
}

/** GST filing sheet (W10): taxable by slab, output GST, TCS to accept, TDS for 26AS, credit notes, advances. */
export async function gstSheet(db: D1Database, propertyId: string, period: string) {
  const rev = await revenueSummary(db, propertyId, period);
  const credits = await all<any>(db, "SELECT kind, status, SUM(amount_paise) AS amount_paise, COUNT(*) AS n FROM statutory_credits WHERE property_id = ? AND period = ? GROUP BY kind, status", propertyId, period);
  const { from, to } = periodRange(period);
  const purchaseGst = await one<any>(db, "SELECT COALESCE(SUM(gst_paise),0) AS gst_paise, COUNT(*) AS n FROM expenses WHERE property_id = ? AND voided_at IS NULL AND gst_paise > 0 AND on_date BETWEEN ? AND ?", propertyId, from, to);
  const changeLog = await all<any>(db, "SELECT id, actor_email, action, entity, entity_id, before_json, after_json, at FROM audit_log WHERE property_id = ? AND substr(at,1,7) = ? AND action LIKE '%.update' OR (property_id = ? AND substr(at,1,7) = ? AND action LIKE '%.void') ORDER BY at", propertyId, period, propertyId, period);
  return {
    period,
    by_slab: rev.by_slab.map((s) => ({ rate_pct: s.gst_rate_bp / 100, taxable_paise: s.taxable_paise, gst_paise: s.gst_paise })),
    credit_notes: rev.credit_notes,
    taxable_total_paise: rev.taxable_paise, output_gst_paise: rev.gst_paise,
    tcs: credits.filter((c) => c.kind === "tcs"), tds: credits.filter((c) => c.kind === "tds"),
    input_gst_on_purchases: { ...purchaseGst, note: "Not creditable while rooms are supplied at the 5% slab; shown for the register." },
    advances_received_for_future_stays: rev.advances_for_future_stays,
    change_log: changeLog,
  };
}
