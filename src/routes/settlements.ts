import { newRouter, requireCap, requireAny, body, str, optStr, oneOf, paise } from "../app";
import { Batch, HttpError, all, one, id, assertPeriodOpen, defaultBank, bankAccount } from "../db";
import { nowIso, todayIn } from "../domain/dates";
import { computeSettlement } from "../domain/settlement";
import type { ChannelRow } from "../services/bookings";
import { allowed } from "../auth";

const r = newRouter();
// The CA reads OTA payouts for the books; computing and settling stays with the revenue desk and owner.
r.use("*", async (c, next) => (c.req.method === "GET" ? requireAny("settlements", "finance") : requireCap("settlements"))(c, next));

r.get("/", async (c) => {
  const p = c.get("property");
  const rows = await all(c.env.DB, "SELECT s.*, ch.name AS channel_name, (SELECT COUNT(*) FROM settlement_items si WHERE si.settlement_id = s.id) AS stays FROM settlements s JOIN channels ch ON ch.id = s.channel_id WHERE s.property_id = ? ORDER BY s.created_at DESC LIMIT 100", p.id);
  return c.json({ settlements: rows });
});

/** Stays an OTA still owes us for: channel-collect bookings checked out and not in a settled settlement. */
r.get("/unsettled", async (c) => {
  const p = c.get("property");
  const channelCode = c.req.query("channel") ?? "booking_com";
  const rows = await all(c.env.DB,
    `SELECT b.id, b.external_ref, b.check_in, b.check_out, b.room_total_paise, b.gst_paise, b.gross_paise, g.name AS guest_name
     FROM bookings b JOIN channels ch ON ch.id = b.channel_id JOIN guests g ON g.id = b.guest_id
     WHERE b.property_id = ? AND ch.code = ? AND ch.collection_type = 'channel_collect' AND b.status IN ('checked_out','checked_in','approved')
       AND b.id NOT IN (SELECT si.booking_id FROM settlement_items si JOIN settlements s ON s.id = si.settlement_id WHERE s.status = 'settled')
     ORDER BY b.check_out`, p.id, channelCode);
  return c.json({ stays: rows });
});

/** Preview or create a settlement: the formula runs on the channel's terms; nothing posts until Mark settled. */
r.post("/", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const x = await body(c);
  const ch = await one<ChannelRow>(c.env.DB, "SELECT * FROM channels WHERE property_id = ? AND code = ?", p.id, str(x.channel_code, "channel_code"));
  if (!ch) throw new HttpError(400, "unknown channel");
  const ids: string[] = Array.isArray(x.booking_ids) ? x.booking_ids.map(String) : [];
  if (!ids.length) throw new HttpError(400, "booking_ids required");
  const stays = await all<{ id: string; room_total_paise: number; gst_paise: number; check_in: string; guest_name: string }>(c.env.DB, `SELECT b.id, b.room_total_paise, b.gst_paise, b.check_in, (SELECT name FROM guests g WHERE g.id = b.guest_id) AS guest_name FROM bookings b WHERE b.property_id = ? AND b.channel_id = ? AND b.id IN (${ids.map(() => "?").join(",")})`, p.id, ch.id, ...ids);
  if (stays.length !== ids.length) throw new HttpError(400, "a booking is not on this channel");
  const already = await all<{ booking_id: string }>(c.env.DB, `SELECT si.booking_id FROM settlement_items si JOIN settlements s ON s.id = si.settlement_id WHERE s.status = 'settled' AND si.booking_id IN (${ids.map(() => "?").join(",")})`, ...ids);
  if (already.length) throw new HttpError(409, "already settled", { booking_ids: already.map((a) => a.booking_id) });
  // A payout cannot pay for a stay that had not begun when it was paid: that is an older payout matched to the wrong stays.
  const payoutOn = optStr(x.payout_on, "payout_on");
  const early = payoutOn ? stays.filter((s) => s.check_in > payoutOn) : [];
  if (early.length) throw new HttpError(409, `a payout dated ${payoutOn} cannot cover stays that began later (${early.map((s) => `${s.guest_name}, check-in ${s.check_in}`).join("; ")}): tick the stays this payout actually covers`);
  const terms = { ...ch };
  if (x.terms) Object.assign(terms, x.terms); // per-payout override (e.g. a promo commission), audited below
  const calc = computeSettlement(terms, stays.map((s) => ({ bookingId: s.id, roomTotalPaise: s.room_total_paise, gstPaise: s.gst_paise })));
  if (x.preview) return c.json({ preview: calc, terms });
  const payoutRef = str(x.payout_ref, "payout_ref");
  const received = x.received_paise !== undefined ? paise(x.received_paise, "received_paise", { allowZero: true }) : null;
  const sid = id("stl");
  const b = new Batch(c.env.DB, actor);
  b.add(`INSERT INTO settlements (id, property_id, channel_id, payout_ref, payout_on, gross_paise, commission_paise, commission_gst_paise, payment_fee_paise, tcs_paise, tds_paise, expected_paise, received_paise, variance_paise, status, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,
    sid, p.id, ch.id, payoutRef, optStr(x.payout_on, "payout_on"), calc.grossPaise, calc.commissionPaise, calc.commissionGstPaise, calc.paymentFeePaise, calc.tcsPaise, calc.tdsPaise, calc.expectedPaise, received, received === null ? 0 : received - calc.expectedPaise, actor.id);
  for (const it of calc.items) b.add("INSERT INTO settlement_items (settlement_id, booking_id, gross_paise, commission_paise, commission_gst_paise, payment_fee_paise, tcs_paise, tds_paise, net_paise) VALUES (?,?,?,?,?,?,?,?,?)",
    sid, it.bookingId, it.grossPaise, it.commissionPaise, it.commissionGstPaise, it.paymentFeePaise, it.tcsPaise, it.tdsPaise, it.netPaise);
  b.audit("settlement.create", "settlement", sid, null, { payout_ref: payoutRef, expected_paise: calc.expectedPaise, received_paise: received, terms: { commission_bp: terms.commission_bp, commission_gst_bp: terms.commission_gst_bp ?? 0, payment_fee_bp: terms.payment_fee_bp, tcs_bp: terms.tcs_bp, tds_bp: terms.tds_bp } });
  await b.run();
  return c.json({ id: sid, ...calc, received_paise: received, variance_paise: received === null ? 0 : received - calc.expectedPaise }, 201);
});

r.get("/:id", async (c) => {
  const p = c.get("property");
  const s: any = await one(c.env.DB, "SELECT s.*, ch.name AS channel_name, ch.code AS channel_code FROM settlements s JOIN channels ch ON ch.id = s.channel_id WHERE s.id = ? AND s.property_id = ?", c.req.param("id"), p.id);
  if (!s) throw new HttpError(404, "settlement not found");
  const items = await all(c.env.DB, "SELECT si.*, g.name AS guest_name, b.check_in, b.check_out, b.external_ref FROM settlement_items si JOIN bookings b ON b.id = si.booking_id JOIN guests g ON g.id = b.guest_id WHERE si.settlement_id = ?", s.id);
  const expenses = await all(c.env.DB, "SELECT id, kind, amount_paise, voided_at FROM expenses WHERE settlement_id = ?", s.id);
  const credits = await all(c.env.DB, "SELECT * FROM statutory_credits WHERE settlement_id = ?", s.id);
  return c.json({ settlement: s, items, expenses, credits });
});

/**
 * Mark settled: posts the commission and payment-fee expenses (once), the TCS/TDS recoverable credits,
 * records the OTA receipt into the bank, and settles the stays. One batch; Undo reverses every row it created.
 */
r.post("/:id/settle", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const s: any = await one(c.env.DB, "SELECT s.*, ch.name AS channel_name FROM settlements s JOIN channels ch ON ch.id = s.channel_id WHERE s.id = ? AND s.property_id = ?", c.req.param("id"), p.id);
  if (!s) throw new HttpError(404, "settlement not found");
  if (s.status !== "draft") throw new HttpError(409, `settlement is ${s.status}`);
  const x = await body(c).catch(() => ({} as Record<string, unknown>));
  const onDate = optStr(x.payout_on, "payout_on") ?? s.payout_on ?? todayIn(p.timezone);
  await assertPeriodOpen(c.env.DB, p.id, onDate);
  const received = x.received_paise !== undefined ? paise(x.received_paise, "received_paise", { allowZero: true }) : s.received_paise ?? s.expected_paise;
  const variance = received - s.expected_paise;
  const bank = x.account_id ? await bankAccount(c.env.DB, p.id, str(x.account_id, "account_id")) : await defaultBank(c.env.DB, p.id);
  // The bank's opening balance already holds everything received before it was taken: adding an older payout counts it twice.
  // The owner can close such a payout against the opening instead: the amount moves out of the opening into the payout,
  // so the commission is booked and the stays are settled while the bank balance stays where the bank says it is.
  const beforeOpening = !!bank.opening_date && onDate < bank.opening_date;
  if (beforeOpening && x.before_opening !== true) throw new HttpError(409, `${bank.name}'s balance in AVOS starts from the bank's own figure on ${bank.opening_date}, which already includes a payout received on ${onDate}: it cannot be added again. The owner can close it as "paid before AVOS started".`, { before_opening: true, opening_date: bank.opening_date });
  if (beforeOpening && !allowed(actor, "admin")) throw new HttpError(403, "only the owner can close a payout against the opening balance");
  const items = await all<any>(c.env.DB, "SELECT si.*, b.guest_id FROM settlement_items si JOIN bookings b ON b.id = si.booking_id WHERE si.settlement_id = ?", s.id);
  const now = nowIso();
  const b = new Batch(c.env.DB, actor);
  const created: string[] = [];
  const exp = (kind: string, amount: number, desc: string, gst = { bp: 0, paise: 0 }) => { if (amount === 0) return; const eid = id("exp"); created.push(eid);
    b.add("INSERT INTO expenses (id, property_id, kind, category, description, amount_paise, gst_rate_bp, gst_paise, paid_from_account_id, on_date, settlement_id, recorded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", eid, p.id, kind, "bank_charges", desc, amount, gst.bp, gst.paise, bank.id, onDate, s.id, actor.id); };
  // The commission expense carries the OTA's GST on it (input GST for the register), as on the OTA's commission invoice.
  const cgst = Number(s.commission_gst_paise ?? 0);
  exp("ota_commission", s.commission_paise + cgst, `${s.channel_name} commission${cgst ? " incl. GST" : ""} · payout ${s.payout_ref}`, cgst ? { bp: s.commission_paise ? Math.round((cgst * 10000) / s.commission_paise) : 0, paise: cgst } : undefined);
  exp("ota_payment_fee", s.payment_fee_paise, `${s.channel_name} payment fee · payout ${s.payout_ref}`);
  if (variance !== 0) exp("fee_variance", -variance, `${s.channel_name} payout variance · ${s.payout_ref}`); // short receipt is a cost; excess a negative cost
  for (const k of ["tcs", "tds"] as const) if (s[`${k}_paise`] > 0)
    b.add("INSERT INTO statutory_credits (id, property_id, kind, settlement_id, amount_paise, period) VALUES (?,?,?,?,?,?)", id("stc"), p.id, k, s.id, s[`${k}_paise`], onDate.slice(0, 7));
  // The OTA pays each stay's gross (the commission/fee expenses net it off) — one 'ota' payment per stay keeps the stay fully paid.
  for (const it of items) {
    const pid = id("pay");
    b.add("INSERT INTO payments (id, property_id, booking_id, guest_id, kind, method, amount_paise, account_id, reference, received_on, status, recorded_by) VALUES (?,?,?,?,'balance','ota',?,?,?,?,'confirmed',?)",
      pid, p.id, it.booking_id, it.guest_id, it.gross_paise, bank.id, `${s.payout_ref}:${s.id}`, onDate, actor.id);
  }
  b.add("UPDATE settlements SET status = 'settled', received_paise = ?, variance_paise = ?, payout_on = ?, settled_by = ?, settled_at = ? WHERE id = ?", received, variance, onDate, actor.id, now, s.id);
  if (beforeOpening) {
    b.add("UPDATE money_accounts SET opening_paise = opening_paise - ? WHERE id = ?", received, bank.id);
    b.add("UPDATE settlements SET opening_adjusted_paise = ?, opening_account_id = ? WHERE id = ?", received, bank.id, s.id);
    b.audit("account.opening_adjusted", "money_account", bank.id, null, { less_paise: received, reason: `payout ${s.payout_ref} of ${onDate} was already in the opening balance of ${bank.opening_date}`, settlement_id: s.id });
  }
  b.add("INSERT INTO approvals (id, property_id, kind, ref_id, summary, amount_paise, status, requested_by, decided_by, decided_at) VALUES (?,?,?,?,?,?,'approved',?,?,?)",
    id("apr"), p.id, "settlement", s.id, `${s.channel_name} payout ${s.payout_ref} settlement`, received, actor.id, actor.id, now);
  b.audit("settlement.settle", "settlement", s.id, { status: "draft" }, { status: "settled", received_paise: received, variance_paise: variance, expenses: created, stays: items.map((i: any) => i.booking_id), before_opening: beforeOpening });
  await b.run();
  return c.json({ ok: true, received_paise: received, variance_paise: variance, expenses_created: created.length });
});

/** Undo removes every expense, credit and receipt the settlement created — the duplicate-₹806 class of error cannot recur. */
r.post("/:id/undo", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const s: any = await one(c.env.DB, "SELECT * FROM settlements WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!s) throw new HttpError(404, "settlement not found");
  if (s.status !== "settled") throw new HttpError(409, `settlement is ${s.status}`);
  await assertPeriodOpen(c.env.DB, p.id, s.payout_on ?? todayIn(p.timezone));
  const matched = await one(c.env.DB, "SELECT id FROM bank_statement_lines WHERE match_kind = 'settlement' AND match_id = ? AND status = 'matched'", s.id);
  if (matched) throw new HttpError(409, "settlement is reconciled to the bank; unmatch it first");
  const x = await body(c);
  const reason = str(x.reason, "reason");
  const now = nowIso();
  const b = new Batch(c.env.DB, actor);
  b.add("UPDATE expenses SET voided_at = ?, void_reason = ? WHERE settlement_id = ? AND voided_at IS NULL", now, `settlement undone: ${reason}`, s.id);
  b.add("UPDATE statutory_credits SET status = 'reversed' WHERE settlement_id = ?", s.id);
  b.add("UPDATE payments SET status = 'void', voided_at = ?, void_reason = ? WHERE property_id = ? AND method = 'ota' AND reference = ? AND status != 'void'", now, `settlement undone: ${reason}`, p.id, `${s.payout_ref}:${s.id}`);
  b.add("UPDATE settlements SET status = 'undone', undone_by = ?, undone_at = ? WHERE id = ?", actor.id, now, s.id);
  // A payout closed against the opening balance puts its amount back into the opening.
  if (s.opening_adjusted_paise && s.opening_account_id) b.add("UPDATE money_accounts SET opening_paise = opening_paise + ? WHERE id = ?", s.opening_adjusted_paise, s.opening_account_id);
  b.audit("settlement.undo", "settlement", s.id, { status: "settled" }, { status: "undone", reason });
  await b.run();
  return c.json({ ok: true });
});

export default r;
export { oneOf as _o };
