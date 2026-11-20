import { newRouter, requireCap, body, str, optStr, int, paise } from "../app";
import { Batch, HttpError, all, one, id, nextSequence, assertPeriodOpen } from "../db";
import { todayIn, nowIso } from "../domain/dates";
import { formatINR } from "../domain/money";
import { loadBooking, paidOnBooking } from "../services/bookings";
import { issueInvoice } from "../services/invoices";

const r = newRouter();
r.use("*", requireCap("invoices"));

import type { InvoiceLine } from "../services/invoices";
export type { InvoiceLine };

/** Issue the guest invoice (W6), dated the stay's check-out date. AVOS also issues it on its own after check-out (cron). */
r.post("/bookings/:id", async (c) => {
  const x = await body(c).catch(() => ({} as Record<string, unknown>));
  const r1 = await issueInvoice(c.env.DB, c.get("property"), c.get("actor"), c.req.param("id"), { guestGstin: optStr(x.guest_gstin, "guest_gstin") });
  if (r1.duplicate) return c.json({ id: r1.id, number: r1.number, duplicate: true });
  const { duplicate: _d, ...out } = r1;
  return c.json(out, 201);
});

r.get("/", async (c) => {
  const p = c.get("property");
  const period = c.req.query("period");
  const rows = await all(c.env.DB, `SELECT i.*, (SELECT COUNT(*) FROM credit_notes cn WHERE cn.invoice_id = i.id) AS credit_notes FROM invoices i WHERE i.property_id = ? ${period ? "AND substr(i.issued_on,1,7) = ?" : ""} ORDER BY i.fy DESC, i.seq DESC LIMIT 300`, ...(period ? [p.id, period] : [p.id]));
  return c.json({ invoices: rows });
});

/**
 * Credit notes for the accountant: every one in full (number, date, the invoice it reduces and when that was issued,
 * guest, taxable value, GST and its rate, total, reason, any refund paid against it, who issued it), by month.
 */
r.get("/credit-notes", async (c) => {
  const p = c.get("property");
  const period = c.req.query("period");
  const rows = await all(c.env.DB, `SELECT cn.id, cn.number, cn.fy, cn.issued_on, cn.taxable_paise, cn.gst_paise, cn.total_paise, cn.reason, cn.created_at,
       i.id AS invoice_id, i.number AS invoice_number, i.issued_on AS invoice_date, i.total_paise AS invoice_total_paise, i.guest_name, i.guest_gstin, i.gst_applicable,
       CASE WHEN cn.taxable_paise > 0 THEN ROUND(cn.gst_paise * 10000.0 / cn.taxable_paise) ELSE 0 END AS gst_rate_bp,
       u.name AS issued_by_name, pm.amount_paise AS refund_paise, pm.reference AS refund_reference, pm.received_on AS refund_on
     FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id LEFT JOIN users u ON u.id = cn.issued_by LEFT JOIN payments pm ON pm.id = cn.refund_payment_id
     WHERE cn.property_id = ? ${period ? "AND substr(cn.issued_on,1,7) = ?" : ""} ORDER BY cn.fy DESC, cn.seq DESC LIMIT 300`, ...(period ? [p.id, period] : [p.id]));
  return c.json({ credit_notes: rows });
});

/** A credit note as a document: printable like the invoice it reduces. */
r.get("/credit-notes/:cid/html", async (c) => {
  const p = c.get("property");
  const cn: any = await one(c.env.DB, "SELECT * FROM credit_notes WHERE id = ? AND property_id = ?", c.req.param("cid"), p.id);
  if (!cn) throw new HttpError(404, "credit note not found");
  const inv: any = await one(c.env.DB, "SELECT * FROM invoices WHERE id = ?", cn.invoice_id);
  const lines: InvoiceLine[] = JSON.parse(inv.lines_json);
  const refund = cn.refund_payment_id ? await one<any>(c.env.DB, "SELECT amount_paise, reference, received_on, method FROM payments WHERE id = ?", cn.refund_payment_id) : null;
  const rate = cn.taxable_paise > 0 ? Math.round((cn.gst_paise * 10000) / cn.taxable_paise) / 100 : 0;
  const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(cn.number)}</title>
<style>body{font:14px/1.45 -apple-system,Segoe UI,sans-serif;color:#1C2420;margin:32px;max-width:720px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:20px 0 4px}.muted{color:#5a615c}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #DDD8CB}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}.tot td{font-weight:700;border-top:2px solid #14453A}.hdr{display:flex;justify-content:space-between;gap:24px}.box{border:1px solid #DDD8CB;padding:12px;border-radius:8px}@media print{body{margin:12mm}}</style></head><body>
<div class="hdr"><div><h1>${esc(p.legal_name || p.name)}</h1><div class="muted">${esc(p.address ?? "")}</div><div class="muted">${inv.gst_applicable ? "GSTIN " + esc(p.gstin) : "GST not applicable — unregistered supplier"}</div></div>
<div class="box"><div><b>Credit Note</b> ${esc(cn.number)}</div><div>Date ${esc(cn.issued_on)}</div><div class="muted">FY ${esc(cn.fy)}</div></div></div>
<p><b>Against ${inv.gst_applicable ? "tax invoice" : "invoice"}</b> ${esc(inv.number)} dated ${esc(inv.issued_on)} · invoice total ${formatINR(inv.total_paise)}<br><b>Guest</b> ${esc(inv.guest_name)}${inv.guest_gstin ? " · GSTIN " + esc(inv.guest_gstin) : ""}</p>
<p><b>Reason</b> ${esc(cn.reason)}</p>
<table><thead><tr><th>Credited</th><th class="n">Taxable</th>${inv.gst_applicable ? '<th class="n">GST</th>' : ""}<th class="n">Amount</th></tr></thead><tbody>
<tr><td>Accommodation (SAC 9963)${inv.gst_applicable ? ` <span class="muted">· GST ${rate}%</span>` : ""}</td><td class="n">${formatINR(cn.taxable_paise)}</td>${inv.gst_applicable ? `<td class="n">${formatINR(cn.gst_paise)}</td>` : ""}<td class="n">${formatINR(cn.total_paise)}</td></tr>
<tr class="tot"><td>Total credited</td><td class="n">${formatINR(cn.taxable_paise)}</td>${inv.gst_applicable ? `<td class="n">${formatINR(cn.gst_paise)}</td>` : ""}<td class="n">${formatINR(cn.total_paise)}</td></tr></tbody></table>
${refund ? `<p>Refund paid ${formatINR(refund.amount_paise)} by ${esc(refund.method)} on ${esc(refund.received_on)}${refund.reference ? ` · ref ${esc(refund.reference)}` : ""}</p>` : ""}
<h2>Original invoice ${esc(inv.number)}</h2>
<table><thead><tr><th>Description</th><th class="n">Taxable</th>${inv.gst_applicable ? '<th class="n">GST</th>' : ""}</tr></thead><tbody>
${lines.map((l) => `<tr><td>${esc(l.description)}${inv.gst_applicable ? ` <span class="muted">(${l.gst_rate_bp / 100}%)</span>` : ""}</td><td class="n">${formatINR(l.taxable_paise)}</td>${inv.gst_applicable ? `<td class="n">${formatINR(l.gst_paise)}</td>` : ""}</tr>`).join("")}
</tbody></table></body></html>`;
  return c.html(html);
});

r.get("/:id", async (c) => {
  const p = c.get("property");
  const inv: any = await one(c.env.DB, "SELECT * FROM invoices WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!inv) throw new HttpError(404, "invoice not found");
  const payments = await all(c.env.DB, "SELECT id, kind, method, amount_paise, reference, received_on FROM payments WHERE booking_id = ? AND status != 'void' ORDER BY received_on", inv.booking_id);
  const creditNotes = await all(c.env.DB, "SELECT * FROM credit_notes WHERE invoice_id = ? ORDER BY issued_on", inv.id);
  return c.json({ invoice: { ...inv, lines: JSON.parse(inv.lines_json) }, payments, credit_notes: creditNotes, property: { name: p.name, legal_name: p.legal_name, address: p.address, gstin: p.gstin } });
});

/** Printable HTML (the reference invoice.html). Browser Run or the phone's print-to-PDF turns it into the PDF. */
r.get("/:id/html", async (c) => {
  const p = c.get("property");
  const inv: any = await one(c.env.DB, "SELECT * FROM invoices WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!inv) throw new HttpError(404, "invoice not found");
  const lines: InvoiceLine[] = JSON.parse(inv.lines_json);
  const payments = await all<any>(c.env.DB, "SELECT method, amount_paise, reference, received_on, kind FROM payments WHERE booking_id = ? AND status != 'void' ORDER BY received_on", inv.booking_id);
  const cns = await all<any>(c.env.DB, "SELECT number, total_paise, reason FROM credit_notes WHERE invoice_id = ?", inv.id);
  const ch = await one<{ name: string; collection_type: string }>(c.env.DB, "SELECT ch.name, ch.collection_type FROM bookings b JOIN channels ch ON ch.id = b.channel_id WHERE b.id = ?", inv.booking_id);
  const viaOta = ch?.collection_type === "channel_collect";
  const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(inv.number)}</title>
<style>body{font:14px/1.45 -apple-system,Segoe UI,sans-serif;color:#1C2420;margin:32px;max-width:720px}h1{font-size:20px;margin:0 0 4px}.muted{color:#5a615c}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #DDD8CB}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}.tot td{font-weight:700;border-top:2px solid #14453A}.hdr{display:flex;justify-content:space-between;gap:24px}.box{border:1px solid #DDD8CB;padding:12px;border-radius:8px}@media print{body{margin:12mm}}</style></head><body>
<div class="hdr"><div><h1>${esc(p.legal_name || p.name)}</h1><div class="muted">${esc(p.address ?? "")}</div><div class="muted">${inv.gst_applicable ? "GSTIN " + esc(p.gstin) : "GST not applicable — unregistered supplier"}</div></div>
<div class="box"><div><b>${inv.gst_applicable ? "Tax Invoice" : "Invoice"}</b> ${esc(inv.number)}</div><div>Date ${esc(inv.issued_on)}</div><div class="muted">FY ${esc(inv.fy)}</div></div></div>
<p><b>Bill to</b> ${esc(inv.guest_name)}${inv.guest_phone ? " · " + esc(inv.guest_phone) : ""}${inv.guest_gstin ? "<br>GSTIN " + esc(inv.guest_gstin) : ""}</p>
<table><thead><tr><th>Description</th><th class="n">Taxable</th>${inv.gst_applicable ? '<th class="n">GST</th>' : ""}<th class="n">Amount</th></tr></thead><tbody>
${lines.map((l) => `<tr><td>${esc(l.description)}${inv.gst_applicable ? ` <span class="muted">(SAC 9963 · ${l.gst_rate_bp / 100}%)</span>` : ""}</td><td class="n">${formatINR(l.taxable_paise)}</td>${inv.gst_applicable ? `<td class="n">${formatINR(l.gst_paise)}</td>` : ""}<td class="n">${formatINR(l.taxable_paise + l.gst_paise)}</td></tr>`).join("")}
<tr class="tot"><td>Total</td><td class="n">${formatINR(inv.taxable_paise)}</td>${inv.gst_applicable ? `<td class="n">${formatINR(inv.gst_paise)}</td>` : ""}<td class="n">${formatINR(inv.total_paise)}</td></tr>
${viaOta ? `<tr><td>Paid through ${esc(ch!.name)}</td><td></td>${inv.gst_applicable ? "<td></td>" : ""}<td class="n">${formatINR(inv.total_paise)}</td></tr>` : ""}
${(viaOta ? payments.filter((pm) => pm.method !== "ota") : payments).map((pm) => `<tr><td>${pm.kind === "refund" ? "Refunded" : "Received"} · ${esc(pm.method)}${pm.reference ? " ····" + esc(String(pm.reference).slice(-4)) : ""} · ${esc(pm.received_on)}</td><td></td>${inv.gst_applicable ? "<td></td>" : ""}<td class="n">${pm.kind === "refund" ? "" : "− "}${formatINR(pm.amount_paise)}</td></tr>`).join("")}
${cns.map((cn) => `<tr><td>Credit note ${esc(cn.number)} · ${esc(cn.reason)}</td><td></td>${inv.gst_applicable ? "<td></td>" : ""}<td class="n">− ${formatINR(cn.total_paise)}</td></tr>`).join("")}
<tr class="tot"><td>Balance due</td><td></td>${inv.gst_applicable ? "<td></td>" : ""}<td class="n">${formatINR(inv.balance_paise)}</td></tr></tbody></table>
<p class="muted">Thank you for staying with us.</p></body></html>`;
  return c.html(html);
});

/** Credit note: never edits the invoice; links to it and reduces the GST sheet (v1 because cancellations happen from day one). */
r.post("/:id/credit-notes", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const inv: any = await one(c.env.DB, "SELECT * FROM invoices WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!inv) throw new HttpError(404, "invoice not found");
  const x = await body(c);
  const issuedOn = optStr(x.issued_on, "issued_on") ?? todayIn(p.timezone);
  await assertPeriodOpen(c.env.DB, p.id, issuedOn);
  const reason = str(x.reason, "reason");
  const already = (await one<{ s: number | null }>(c.env.DB, "SELECT SUM(total_paise) AS s FROM credit_notes WHERE invoice_id = ?", inv.id))?.s ?? 0;
  const total = x.total_paise !== undefined ? paise(x.total_paise, "total_paise") : inv.total_paise - already;
  if (total <= 0 || total + already > inv.total_paise) throw new HttpError(400, `credit must be between 1 and ${inv.total_paise - already} paise`);
  // Pro-rata GST on the credited amount at the invoice's blended rate.
  const gst = inv.total_paise ? Math.round((inv.gst_paise * total) / inv.total_paise) : 0;
  const { fy, seq } = await nextSequence(c.env.DB, p.id, "credit_note", issuedOn, p.fy_start_month);
  const number = `${p.invoice_prefix}/CN/${fy}/${String(seq).padStart(3, "0")}`;
  const cid = id("cdn");
  const b = new Batch(c.env.DB, actor);
  b.add("INSERT INTO credit_notes (id, property_id, invoice_id, number, fy, seq, issued_on, taxable_paise, gst_paise, total_paise, reason, refund_payment_id, issued_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    cid, p.id, inv.id, number, fy, seq, issuedOn, total - gst, gst, total, reason, optStr(x.refund_payment_id, "refund_payment_id"), actor.id);
  b.add("UPDATE invoices SET status = CASE WHEN ? + ? >= total_paise THEN 'credited' ELSE status END, balance_paise = MAX(0, balance_paise - ?) WHERE id = ?", already, total, total, inv.id);
  b.audit("credit_note.issue", "credit_note", cid, null, { number, invoice: inv.number, total_paise: total, reason });
  await b.run();
  return c.json({ id: cid, number, total_paise: total, gst_paise: gst }, 201);
});

export default r;
export { int as _i, nowIso as _n };
