import { newRouter, requireCap, body, str, optStr } from "../app";
import { Batch, HttpError, all, one, id } from "../db";
import { nowIso, periodRange } from "../domain/dates";
import { expenseSummary, gstSheet, precloseExceptions, revenueSummary } from "../services/reports";
import { notifyRole } from "../services/notify";

const r = newRouter();

function per(c: any) { const p = c.req.param("period"); if (!/^\d{4}-\d{2}$/.test(p)) throw new HttpError(400, "period must be YYYY-MM"); return p; }

r.get("/:period", requireCap("revenue_reports"), async (c) => {
  const p = c.get("property"); const period = per(c);
  const lock = await one<any>(c.env.DB, "SELECT * FROM period_locks WHERE property_id = ? AND period = ?", p.id, period);
  const packs = await all(c.env.DB, "SELECT id, version, revised, created_at, keys_json FROM statement_packs WHERE property_id = ? AND period = ? ORDER BY version", p.id, period);
  const ex = await precloseExceptions(c.env.DB, p.id, period);
  const counts = Object.fromEntries(Object.entries(ex).filter(([k]) => k !== "period").map(([k, v]) => [k, (v as unknown[]).length]));
  return c.json({ period, lock: lock ?? { property_id: p.id, period, status: "open", version: 0 }, packs, exception_counts: counts, clear: Object.values(counts).every((n) => n === 0) });
});

/** Trupti clears the pre-close: every exception must be empty or explicitly acknowledged. */
r.post("/:period/preclear", requireCap("approvals"), async (c) => {
  const p = c.get("property"); const actor = c.get("actor"); const period = per(c);
  const ex = await precloseExceptions(c.env.DB, p.id, period);
  const x = await body(c).catch(() => ({} as Record<string, unknown>));
  const blocking = ["pending_approvals", "stays_not_checked_out", "uninvoiced_direct_stays"] as const;
  for (const k of blocking) if ((ex as any)[k].length) throw new HttpError(409, `cannot pre-clear: ${k} has ${(ex as any)[k].length} item(s)`);
  const soft = ["unreconciled_bank_lines", "part_paid_stays", "expenses_missing_bill_details", "unsettled_ota_stays"] as const;
  const open = soft.filter((k) => (ex as any)[k].length);
  if (open.length && !x.acknowledge) throw new HttpError(409, `exceptions remain: ${open.join(", ")} — pass acknowledge: true with a note to carry them`, { open: Object.fromEntries(open.map((k) => [k, (ex as any)[k].length])) });
  const lock = await one<any>(c.env.DB, "SELECT status FROM period_locks WHERE property_id = ? AND period = ?", p.id, period);
  if (lock && lock.status !== "open") throw new HttpError(409, `period is ${lock.status}`);
  const b = new Batch(c.env.DB, actor);
  const apId = id("apr");
  b.add("INSERT INTO period_locks (property_id, period, status, precleared_by, precleared_at) VALUES (?,?,'precleared',?,?) ON CONFLICT(property_id, period) DO UPDATE SET status = 'precleared', precleared_by = excluded.precleared_by, precleared_at = excluded.precleared_at", p.id, period, actor.id, nowIso());
  b.add("INSERT INTO approvals (id, property_id, kind, ref_id, summary, status, requested_by, decided_by, decided_at, note) VALUES (?,?,?,?,?,'approved',?,?,?,?)", apId, p.id, "preclose", period, `Pre-close ${period} cleared`, actor.id, actor.id, nowIso(), optStr(x.note, "note"));
  await notifyRole(b, p.id, "accountant", "preclose_ready", `${period} pre-close cleared by ${actor.name}; ready to lock`, { kind: "period", id: period });
  b.audit("period.preclear", "period", period, { status: lock?.status ?? "open" }, { status: "precleared", carried: open, note: x.note ?? null });
  await b.run();
  return c.json({ ok: true, carried: open });
});

async function buildPack(c: any, period: string, version: number, revised: boolean) {
  const p = c.get("property"); const db = c.env.DB as D1Database;
  const { from, to } = periodRange(period);
  const [rev, exp, gst, ex] = await Promise.all([revenueSummary(db, p.id, period), expenseSummary(db, p.id, period), gstSheet(db, p.id, period), precloseExceptions(db, p.id, period)]);
  const csv = (rows: any[]) => { if (!rows.length) return ""; const cols = Object.keys(rows[0]); return [cols.join(","), ...rows.map((r) => cols.map((k) => { const v = r[k]; const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(","))].join("\n"); };
  const registers = {
    bookings: await all(db, `SELECT b.id, b.external_ref, ch.code AS channel, g.name AS guest, b.check_in, b.check_out, b.nights, b.status, b.room_total_paise, b.gst_paise, b.gross_paise, b.books_date FROM bookings b JOIN channels ch ON ch.id = b.channel_id JOIN guests g ON g.id = b.guest_id WHERE b.property_id = ? AND b.books_date BETWEEN ? AND ? ORDER BY b.books_date`, p.id, from, to),
    payments: await all(db, `SELECT p.id, p.booking_id, p.kind, p.method, p.amount_paise, a.name AS account, p.reference, p.received_on, p.status FROM payments p JOIN money_accounts a ON a.id = p.account_id WHERE p.property_id = ? AND p.received_on BETWEEN ? AND ? ORDER BY p.received_on`, p.id, from, to),
    expenses: await all(db, `SELECT e.id, e.kind, e.category, e.description, e.vendor_name, e.vendor_gstin, e.bill_no, e.amount_paise, e.gst_paise, a.name AS account, e.on_date, e.voided_at FROM expenses e LEFT JOIN money_accounts a ON a.id = e.paid_from_account_id WHERE e.property_id = ? AND e.on_date BETWEEN ? AND ? ORDER BY e.on_date`, p.id, from, to),
    invoices: await all(db, "SELECT number, issued_on, guest_name, taxable_paise, gst_paise, total_paise, status FROM invoices WHERE property_id = ? AND issued_on BETWEEN ? AND ? ORDER BY seq", p.id, from, to),
    credit_notes: await all(db, "SELECT number, issued_on, taxable_paise, gst_paise, total_paise, reason FROM credit_notes WHERE property_id = ? AND issued_on BETWEEN ? AND ? ORDER BY seq", p.id, from, to),
    bank: await all(db, "SELECT on_date, description, amount_paise, status, tier, match_kind, match_id, reason FROM bank_statement_lines WHERE property_id = ? AND on_date BETWEEN ? AND ? ORDER BY on_date", p.id, from, to),
    settlements: await all(db, "SELECT payout_ref, payout_on, gross_paise, commission_paise, payment_fee_paise, tcs_paise, tds_paise, expected_paise, received_paise, variance_paise, status FROM settlements WHERE property_id = ? AND payout_on BETWEEN ? AND ?", p.id, from, to),
  };
  const summary = { property: p.name, period, version, revised, generated_at: nowIso(), revenue: rev, expenses: exp, operating_result_paise: rev.taxable_paise - exp.total_paise, gst, exceptions_carried: Object.fromEntries(Object.entries(ex).filter(([k]) => k !== "period").map(([k, v]) => [k, (v as unknown[]).length])) };
  const base = `packs/${p.id}/${period}/v${version}`;
  const keys: Record<string, string> = { summary: `${base}/summary.json` };
  await c.env.FILES.put(keys.summary, JSON.stringify(summary, null, 2), { httpMetadata: { contentType: "application/json" } });
  for (const [name, rows] of Object.entries(registers)) { keys[name] = `${base}/${name}.csv`; await c.env.FILES.put(keys[name], csv(rows as any[]), { httpMetadata: { contentType: "text/csv" } }); }
  return { summary, keys };
}

/** The CA locks: pack stored immutably (new version each lock), binds every role including the owner. */
r.post("/:period/lock", requireCap("close"), async (c) => {
  const p = c.get("property"); const actor = c.get("actor"); const period = per(c);
  const lock = await one<any>(c.env.DB, "SELECT * FROM period_locks WHERE property_id = ? AND period = ?", p.id, period);
  if (!lock || lock.status !== "precleared") throw new HttpError(409, `period must be pre-cleared by the revenue desk first (currently ${lock?.status ?? "open"})`);
  const version = lock.version + 1;
  const { summary, keys } = await buildPack(c, period, version, version > 1);
  const b = new Batch(c.env.DB, actor);
  b.add("UPDATE period_locks SET status = 'locked', version = ?, locked_by = ?, locked_at = ? WHERE property_id = ? AND period = ?", version, actor.id, nowIso(), p.id, period);
  b.add("INSERT INTO statement_packs (id, property_id, period, version, revised, summary_json, keys_json, created_by) VALUES (?,?,?,?,?,?,?,?)", id("pck"), p.id, period, version, version > 1 ? 1 : 0, JSON.stringify(summary), JSON.stringify(keys), actor.id);
  b.audit("period.lock", "period", period, { status: "precleared", version: lock.version }, { status: "locked", version, pack: keys.summary });
  await notifyRole(b, p.id, "owner", "period_locked", `${period} locked by the CA (pack v${version}${version > 1 ? ", revised" : ""})`, { kind: "period", id: period });
  await b.run();
  return c.json({ ok: true, version, keys, summary: { operating_result_paise: summary.operating_result_paise, revenue_paise: summary.revenue.taxable_paise, expenses_paise: summary.expenses.total_paise } });
});

r.post("/:period/unlock", requireCap("close"), async (c) => {
  const p = c.get("property"); const actor = c.get("actor"); const period = per(c);
  const lock = await one<any>(c.env.DB, "SELECT * FROM period_locks WHERE property_id = ? AND period = ?", p.id, period);
  if (!lock || !["locked", "filed"].includes(lock.status)) throw new HttpError(409, "period is not locked");
  const x = await body(c);
  const reason = str(x.reason, "reason");
  const b = new Batch(c.env.DB, actor);
  b.add("UPDATE period_locks SET status = 'open', unlocked_by = ?, unlocked_at = ?, unlock_reason = ? WHERE property_id = ? AND period = ?", actor.id, nowIso(), reason, p.id, period);
  b.audit("period.unlock", "period", period, { status: lock.status, version: lock.version }, { status: "open", reason, warning: lock.status === "filed" ? "GST already filed for this period; a revised pack and amendment will be needed" : null });
  await notifyRole(b, p.id, "owner", "period_unlocked", `${period} unlocked by the CA: ${reason}${lock.status === "filed" ? " — GST WAS ALREADY FILED" : ""}`, { kind: "period", id: period });
  await b.run();
  return c.json({ ok: true, warning: lock.status === "filed" ? "period was filed" : null, next_version: lock.version + 1 });
});

r.get("/:period/gst", requireCap("gst"), async (c) => c.json(await gstSheet(c.env.DB, c.get("property").id, per(c))));

r.post("/:period/file", requireCap("gst"), async (c) => {
  const p = c.get("property"); const actor = c.get("actor"); const period = per(c);
  const lock = await one<any>(c.env.DB, "SELECT * FROM period_locks WHERE property_id = ? AND period = ?", p.id, period);
  if (!lock || lock.status !== "locked") throw new HttpError(409, "lock the period before marking it filed");
  const x = await body(c).catch(() => ({} as Record<string, unknown>));
  const b = new Batch(c.env.DB, actor);
  b.add("UPDATE period_locks SET status = 'filed', filed_by = ?, filed_at = ? WHERE property_id = ? AND period = ?", actor.id, nowIso(), p.id, period);
  b.add("UPDATE statutory_credits SET status = 'accepted' WHERE property_id = ? AND period = ? AND kind = 'tcs' AND status = 'pending'", p.id, period);
  b.audit("period.file", "period", period, { status: "locked" }, { status: "filed", arn: optStr(x.arn, "arn") });
  await b.run();
  return c.json({ ok: true });
});

r.get("/:period/pack/:version/:file", requireCap("close"), async (c) => {
  const p = c.get("property"); const period = per(c);
  const pack: any = await one(c.env.DB, "SELECT keys_json FROM statement_packs WHERE property_id = ? AND period = ? AND version = ?", p.id, period, Number(c.req.param("version")));
  if (!pack) throw new HttpError(404, "pack not found");
  const key = JSON.parse(pack.keys_json)[c.req.param("file")];
  if (!key) throw new HttpError(404, "file not in pack");
  const obj = await c.env.FILES.get(key);
  if (!obj) throw new HttpError(404, "stored file missing");
  return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream", "content-disposition": `attachment; filename="${period}-v${c.req.param("version")}-${c.req.param("file")}.${key.endsWith(".csv") ? "csv" : "json"}"` } });
});

export default r;
