import { newRouter, requireCap, body, str, optStr, oneOf, paise } from "../app";
import { Batch, HttpError, all, one, id, assertPeriodOpen } from "../db";
import { nowIso, todayIn } from "../domain/dates";
import { splitInclusive } from "../domain/money";

const r = newRouter();
r.use("*", requireCap("tasks"));
const KINDS = ["housekeeping", "maintenance", "repair", "note"] as const;
const STATUSES = ["open", "in_progress", "done", "noted"] as const;

r.get("/", async (c) => {
  const p = c.get("property");
  const status = c.req.query("status");
  const rows = await all(c.env.DB, `SELECT t.*, l.name AS location_name, l.code AS location_code, u.name AS assigned_name FROM tasks t JOIN locations l ON l.id = t.location_id LEFT JOIN users u ON u.id = t.assigned_to
    WHERE t.property_id = ? ${status ? "AND t.status = ?" : "AND t.status IN ('open','in_progress')"} ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.due_on, t.created_at DESC LIMIT 200`,
    ...(status ? [p.id, status] : [p.id]));
  const notes = await all(c.env.DB, "SELECT t.*, l.name AS location_name FROM tasks t JOIN locations l ON l.id = t.location_id WHERE t.property_id = ? AND t.kind = 'note' ORDER BY t.created_at DESC LIMIT 50", p.id);
  return c.json({ tasks: rows, notes });
});

r.post("/", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const x = await body(c);
  const idem = optStr(x.idempotency_key, "idempotency_key");
  if (idem) { const ex = await one<{ id: string }>(c.env.DB, "SELECT id FROM tasks WHERE property_id = ? AND idempotency_key = ?", p.id, idem); if (ex) return c.json({ id: ex.id, duplicate: true }); }
  const kind = oneOf(x.kind, "kind", KINDS);
  const loc = await one<{ id: string; name: string }>(c.env.DB, "SELECT id, name FROM locations WHERE id = ? AND property_id = ? AND active = 1", str(x.location_id, "location_id"), p.id);
  if (!loc) throw new HttpError(400, "unknown location");
  const tid = id("tsk");
  const status = kind === "note" ? "noted" : "open";
  const b = new Batch(c.env.DB, actor);
  b.add("INSERT INTO tasks (id, property_id, location_id, kind, title, priority, status, due_on, photo_key, assigned_to, created_by, idempotency_key, done_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    tid, p.id, loc.id, kind, str(x.title ?? `${kind} · ${loc.name}`, "title", { max: 300 }), oneOf(x.priority ?? "normal", "priority", ["low", "normal", "high"] as const), status,
    optStr(x.due_on, "due_on"), optStr(x.photo_key, "photo_key"), optStr(x.assigned_to, "assigned_to"), actor.id, idem, kind === "note" ? nowIso() : null);
  b.audit("task.create", "task", tid, null, { kind, location: loc.name, status });
  await b.run();
  return c.json({ id: tid, status }, 201);
});

/**
 * Status flow with audit (who/when). Done may attach the repair bill, which posts the expense from
 * petty cash in the same batch, linked both ways (W8).
 */
r.post("/:id/status", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const t: any = await one(c.env.DB, "SELECT * FROM tasks WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!t) throw new HttpError(404, "task not found");
  const x = await body(c);
  const to = oneOf(x.status, "status", STATUSES);
  const allowedNext: Record<string, string[]> = { open: ["in_progress", "done"], in_progress: ["done", "open"], done: [], noted: [] };
  if (!allowedNext[t.status].includes(to)) throw new HttpError(409, `cannot move ${t.status} → ${to}`);
  const b = new Batch(c.env.DB, actor);
  let expenseId: string | null = null;
  if (to === "done" && x.expense) {
    const e = x.expense as Record<string, unknown>;
    const amount = paise(e.amount_paise, "expense.amount_paise");
    const onDate = optStr(e.on_date, "expense.on_date") ?? todayIn(p.timezone);
    await assertPeriodOpen(c.env.DB, p.id, onDate);
    const acct = await one<{ id: string }>(c.env.DB, "SELECT id FROM money_accounts WHERE property_id = ? AND id = ? AND active = 1", p.id, String(e.account_id ?? ""))
      ?? await one<{ id: string }>(c.env.DB, "SELECT id FROM money_accounts WHERE property_id = ? AND kind = 'petty_cash' AND active = 1 LIMIT 1", p.id);
    if (!acct) throw new HttpError(400, "no petty cash account");
    const gstBp = Number(e.gst_rate_bp ?? 0);
    const { gst } = splitInclusive(amount, gstBp);
    expenseId = id("exp");
    b.add(`INSERT INTO expenses (id, property_id, kind, category, description, vendor_name, vendor_gstin, bill_no, bill_date, amount_paise, gst_rate_bp, gst_paise, paid_from_account_id, on_date, bill_photo_key, task_id, recorded_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      expenseId, p.id, "normal", String(e.category ?? "repairs"), String(e.description ?? t.title), optStr(e.vendor_name, "vendor_name"), optStr(e.vendor_gstin, "vendor_gstin"), optStr(e.bill_no, "bill_no"), optStr(e.bill_date, "bill_date"),
      amount, gstBp, gst, acct.id, onDate, optStr(e.bill_photo_key, "bill_photo_key"), t.id, actor.id);
    b.audit("expense.create", "expense", expenseId, null, { amount_paise: amount, task_id: t.id, from: "task.done" });
  }
  b.add("UPDATE tasks SET status = ?, done_at = CASE WHEN ? = 'done' THEN ? ELSE done_at END, expense_id = COALESCE(?, expense_id), updated_at = ? WHERE id = ?", to, to, nowIso(), expenseId, nowIso(), t.id);
  b.audit("task.status", "task", t.id, { status: t.status }, { status: to, expense_id: expenseId });
  await b.run();
  return c.json({ ok: true, expense_id: expenseId });
});

export default r;
