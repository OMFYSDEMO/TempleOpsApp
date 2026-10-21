import { newRouter, requireCap, body, str, optStr, oneOf } from "../app";
import { Batch, HttpError, all, one, id, assertPeriodOpen } from "../db";
import { nowIso, todayIn, addDays } from "../domain/dates";
import { parseStatement, proposeMatch, type Candidate, type StatementLine } from "../domain/recon";

const r = newRouter();
r.use("*", requireCap("recon"));

/**
 * Role wall (F7): the revenue desk reconciles credits; debits (expenses, refunds, transfers out) are
 * the owner's or the CA's. The query filters by sign unless the actor may see expenses.
 */
function signFilter(role: string): string {
  return role === "revenue" ? "AND l.amount_paise > 0" : "";
}

export async function candidatesFor(db: D1Database, propertyId: string, accountId: string, from: string, to: string): Promise<Candidate[]> {
  const pays = await all<any>(db, `SELECT p.id, p.amount_paise, p.reference, p.received_on, p.method, p.kind, g.name AS guest_name, e.amount_paise AS fee_paise
     FROM payments p LEFT JOIN guests g ON g.id = p.guest_id LEFT JOIN expenses e ON e.id = p.fee_expense_id
     WHERE p.property_id = ? AND p.account_id = ? AND p.status IN ('recorded','confirmed') AND p.method != 'ota' AND p.received_on BETWEEN ? AND ?`, propertyId, accountId, from, to);
  const trf = await all<any>(db, `SELECT t.id, t.amount_paise, t.reference, t.on_date, t.from_account_id, t.to_account_id, fa.name AS from_name, ta.name AS to_name FROM transfers t JOIN money_accounts fa ON fa.id = t.from_account_id JOIN money_accounts ta ON ta.id = t.to_account_id
     WHERE t.property_id = ? AND (t.from_account_id = ? OR t.to_account_id = ?) AND t.voided_at IS NULL AND t.on_date BETWEEN ? AND ?
       AND t.id NOT IN (SELECT match_id FROM bank_statement_lines WHERE match_kind = 'transfer' AND status = 'matched')`, propertyId, accountId, accountId, from, to);
  const stl = await all<any>(db, `SELECT s.id, s.expected_paise, s.payout_ref, s.payout_on, s.created_at, ch.name AS channel_name FROM settlements s JOIN channels ch ON ch.id = s.channel_id
     WHERE s.property_id = ? AND s.status IN ('draft','settled') AND s.id NOT IN (SELECT match_id FROM bank_statement_lines WHERE match_kind = 'settlement' AND status = 'matched')`, propertyId);
  const exps = await all<any>(db, `SELECT e.id, e.amount_paise, e.reference, e.on_date, e.description, e.vendor_name FROM expenses e WHERE e.property_id = ? AND e.paid_from_account_id = ? AND e.voided_at IS NULL AND e.kind = 'normal' AND e.on_date BETWEEN ? AND ?
       AND e.id NOT IN (SELECT match_id FROM bank_statement_lines WHERE match_kind = 'expense' AND status = 'matched')`, propertyId, accountId, from, to);
  const out: Candidate[] = [];
  for (const p of pays) out.push({ kind: "payment", id: p.id, amount_paise: p.kind === "refund" ? -p.amount_paise : p.amount_paise, reference: p.reference, on_date: p.received_on, label: `${p.method} ${p.kind} · ${p.guest_name ?? ""}`.trim(), gateway_fee_bp: p.fee_paise ? Math.round((p.fee_paise * 10_000) / p.amount_paise) : (p.method === "airpay" || p.method === "card" ? 0 : undefined) });
  for (const t of trf) out.push({ kind: "transfer", id: t.id, amount_paise: t.to_account_id === accountId ? t.amount_paise : -t.amount_paise, reference: t.reference, on_date: t.on_date, label: `transfer ${t.from_name} → ${t.to_name}` });
  for (const s of stl) {
    const stays = await all<{ booking_id: string; net_paise: number }>(db, "SELECT booking_id, net_paise FROM settlement_items WHERE settlement_id = ?", s.id);
    out.push({ kind: "settlement", id: s.id, amount_paise: s.expected_paise, reference: s.payout_ref, on_date: s.payout_on ?? s.created_at.slice(0, 10), label: `${s.channel_name} payout ${s.payout_ref}`, stays: stays.map((x) => ({ bookingId: x.booking_id, netPaise: x.net_paise })) });
  }
  for (const e of exps) out.push({ kind: "expense", id: e.id, amount_paise: -e.amount_paise, reference: e.reference, on_date: e.on_date, label: `${e.vendor_name ?? e.description ?? "expense"}` });
  return out;
}

/** Paste a statement: lines are stored (deduped by hash) with a proposal each. Nothing writes to the books. */
r.post("/paste", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const x = await body(c);
  const accountId = str(x.account_id, "account_id");
  const acct = await one<{ id: string; kind: string }>(c.env.DB, "SELECT id, kind FROM money_accounts WHERE id = ? AND property_id = ?", accountId, p.id);
  if (!acct) throw new HttpError(400, "unknown account");
  // Not trimmed: a trailing tab on the last line is the empty credit column that marks a debit.
  if (typeof x.text !== "string" || !x.text.trim()) throw new HttpError(400, "text is required");
  if (x.text.length > 200_000) throw new HttpError(400, "text too long");
  const text: string = x.text;
  const { lines, rejected } = parseStatement(text, Number(todayIn(p.timezone).slice(0, 4)));
  if (!lines.length) throw new HttpError(400, "no statement lines recognised", { rejected });
  const runId = id("run");
  const dates = lines.map((l) => l.on_date).sort();
  const from = dates[0], to = dates[dates.length - 1];
  // Window: from the first of the earliest month to a few days after the last line — bank posting dates lag or lead the books by a day or two.
  const cands = await candidatesFor(c.env.DB, p.id, accountId, from.slice(0, 8) + "01", addDays(to, 3));
  const b = new Batch(c.env.DB, actor);
  let inserted = 0, dup = 0;
  const usedIds = new Set<string>();
  for (const l of lines) {
    const exists = await one(c.env.DB, "SELECT id FROM bank_statement_lines WHERE property_id = ? AND account_id = ? AND line_hash = ?", p.id, accountId, l.line_hash);
    if (exists) { dup++; continue; }
    const proposal = proposeMatch(l, cands.filter((cd) => !usedIds.has(`${cd.kind}:${cd.id}`)), { feeBp: p.recon_fee_tolerance_bp, subsetBp: p.recon_subset_tolerance_bp });
    if (proposal) usedIds.add(`${proposal.kind}:${proposal.id}`);
    b.add("INSERT INTO bank_statement_lines (id, property_id, account_id, run_id, on_date, description, amount_paise, reference, line_hash, status, tier, match_kind, match_id, match_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id("bsl"), p.id, accountId, runId, l.on_date, l.description, l.amount_paise, l.reference, l.line_hash, proposal ? "proposed" : "unmatched", proposal?.tier ?? null, proposal?.kind ?? null, proposal?.id ?? null, proposal ? JSON.stringify({ label: proposal.label, ...proposal.detail }) : null);
    inserted++;
  }
  b.audit("recon.paste", "recon_run", runId, null, { account_id: accountId, lines: inserted, duplicates: dup, rejected: rejected.length });
  await b.run();
  return c.json({ run_id: runId, inserted, duplicates: dup, rejected }, 201);
});

r.get("/", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const period = c.req.query("period");
  const status = c.req.query("status");
  const where = ["l.property_id = ?"]; const params: unknown[] = [p.id];
  if (period) { where.push("substr(l.on_date,1,7) = ?"); params.push(period); }
  if (status) { where.push("l.status = ?"); params.push(status); }
  const rows = await all<any>(c.env.DB, `SELECT l.*, a.name AS account_name FROM bank_statement_lines l JOIN money_accounts a ON a.id = l.account_id WHERE ${where.join(" AND ")} ${signFilter(actor.role)} ORDER BY l.on_date, l.created_at LIMIT 500`, ...params);
  const total = rows.length, matched = rows.filter((x) => x.status === "matched").length, proposed = rows.filter((x) => x.status === "proposed").length;
  return c.json({ lines: rows.map((x) => ({ ...x, match: x.match_json ? JSON.parse(x.match_json) : null })), stats: { total, matched, proposed, unmatched: total - matched - proposed, auto_rate: total ? Math.round(((matched + proposed) / total) * 100) : 0 } });
});

/**
 * Accept proposals: writes happen here and only here. Accepting a gateway match adjusts the fee expense
 * to the implied actual (a variance line, never a second fee); accepting an OTA subset settles those stays.
 */
r.post("/accept", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const x = await body(c);
  const ids: string[] = Array.isArray(x.line_ids) ? x.line_ids.map(String) : [];
  if (!ids.length) throw new HttpError(400, "line_ids required");
  const lines = await all<any>(c.env.DB, `SELECT * FROM bank_statement_lines WHERE property_id = ? AND id IN (${ids.map(() => "?").join(",")})`, p.id, ...ids);
  const b = new Batch(c.env.DB, actor);
  const now = nowIso();
  let accepted = 0;
  for (const l of lines) {
    if (l.status !== "proposed" || !l.match_kind || !l.match_id) continue;
    if (actor.role === "revenue" && l.amount_paise < 0) throw new HttpError(403, "debits are reconciled by the owner or the CA");
    await assertPeriodOpen(c.env.DB, p.id, l.on_date);
    const detail = l.match_json ? JSON.parse(l.match_json) : {};
    if (l.match_kind === "payment") {
      b.add("UPDATE payments SET status = 'matched' WHERE id = ?", l.match_id);
      if (l.tier === 3 && typeof detail.variance_paise === "number" && detail.variance_paise !== 0) {
        const pay: any = await one(c.env.DB, "SELECT fee_expense_id, account_id FROM payments WHERE id = ?", l.match_id);
        const vid = id("exp");
        b.add("INSERT INTO expenses (id, property_id, kind, category, description, amount_paise, gst_rate_bp, gst_paise, paid_from_account_id, on_date, payment_id, recorded_by) VALUES (?,?,?,?,?,?,0,0,?,?,?,?)",
          vid, p.id, "fee_variance", "bank_charges", `gateway fee variance vs contracted (implied ${(detail.implied_fee_bp / 100).toFixed(2)}%)`, detail.variance_paise, pay?.account_id ?? l.account_id, l.on_date, l.match_id, actor.id);
        b.audit("expense.create", "expense", vid, null, { kind: "fee_variance", amount_paise: detail.variance_paise, payment_id: l.match_id });
      }
    } else if (l.match_kind === "settlement") {
      const s: any = await one(c.env.DB, "SELECT status, expected_paise FROM settlements WHERE id = ?", l.match_id);
      if (s && s.status === "draft") {
        // Accepting the bank credit settles the payout: same posting as Mark settled, with the received amount from the bank.
        b.add("UPDATE settlements SET received_paise = ?, variance_paise = ? WHERE id = ?", l.amount_paise, l.amount_paise - s.expected_paise, l.match_id);
        b.audit("settlement.received_from_bank", "settlement", l.match_id, null, { received_paise: l.amount_paise, note: "settle it from the OTA payouts screen to post expenses" });
      } else if (s && s.status === "settled") {
        b.add("UPDATE settlements SET received_paise = ?, variance_paise = ? WHERE id = ? AND received_paise IS NULL", l.amount_paise, l.amount_paise - s.expected_paise, l.match_id);
      }
    }
    b.add("UPDATE bank_statement_lines SET status = 'matched', matched_by = ?, matched_at = ? WHERE id = ?", actor.id, now, l.id);
    b.audit("recon.accept", "bank_line", l.id, { status: "proposed" }, { status: "matched", tier: l.tier, kind: l.match_kind, id: l.match_id });
    accepted++;
  }
  await b.run();
  return c.json({ accepted });
});

/** Manual match of an unmatched line to a specific record. */
r.post("/:id/match", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const l: any = await one(c.env.DB, "SELECT * FROM bank_statement_lines WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!l) throw new HttpError(404, "line not found");
  if (l.status === "matched") throw new HttpError(409, "already matched");
  const x = await body(c);
  const kind = oneOf(x.kind, "kind", ["payment", "transfer", "settlement", "expense"] as const);
  const target = str(x.id, "id");
  const b = new Batch(c.env.DB, actor);
  b.add("UPDATE bank_statement_lines SET status = 'proposed', tier = 0, match_kind = ?, match_id = ?, match_json = ? WHERE id = ?", kind, target, JSON.stringify({ label: "manual", manual: true }), l.id);
  b.audit("recon.manual_match", "bank_line", l.id, { status: l.status }, { kind, id: target });
  await b.run();
  return c.json({ ok: true, next: "accept" });
});

r.post("/:id/carry", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const l: any = await one(c.env.DB, "SELECT * FROM bank_statement_lines WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!l) throw new HttpError(404, "line not found");
  const x = await body(c);
  const b = new Batch(c.env.DB, actor);
  b.add("UPDATE bank_statement_lines SET status = 'carried', reason = ? WHERE id = ?", str(x.reason, "reason"), l.id);
  b.audit("recon.carry", "bank_line", l.id, { status: l.status }, { status: "carried", reason: x.reason });
  await b.run();
  return c.json({ ok: true });
});

r.post("/:id/unmatch", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const l: any = await one(c.env.DB, "SELECT * FROM bank_statement_lines WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!l) throw new HttpError(404, "line not found");
  await assertPeriodOpen(c.env.DB, p.id, l.on_date);
  const b = new Batch(c.env.DB, actor);
  if (l.match_kind === "payment" && l.match_id) b.add("UPDATE payments SET status = 'confirmed' WHERE id = ? AND status = 'matched'", l.match_id);
  b.add("UPDATE bank_statement_lines SET status = 'unmatched', tier = NULL, match_kind = NULL, match_id = NULL, match_json = NULL, matched_by = NULL, matched_at = NULL WHERE id = ?", l.id);
  b.audit("recon.unmatch", "bank_line", l.id, { status: l.status, kind: l.match_kind, id: l.match_id }, { status: "unmatched" });
  await b.run();
  return c.json({ ok: true });
});

r.delete("/runs/:runId", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const b = new Batch(c.env.DB, actor);
  b.add("DELETE FROM bank_statement_lines WHERE property_id = ? AND run_id = ? AND status != 'matched'", p.id, c.req.param("runId"));
  b.audit("recon.clear", "recon_run", c.req.param("runId"), null, { cleared_unmatched: true });
  await b.run();
  return c.json({ ok: true });
});

export default r;
export { optStr as _s, StatementLine as _t };
