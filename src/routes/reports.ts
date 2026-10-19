import { newRouter, requireCap } from "../app";
import { HttpError, all } from "../db";
import { todayIn } from "../domain/dates";
import { expenseSummary, precloseExceptions, revenueSummary } from "../services/reports";
import { allowed } from "../auth";

const r = newRouter();

function period(c: any) { const p = c.req.query("period") ?? todayIn(c.get("property").timezone).slice(0, 7); if (!/^\d{4}-\d{2}$/.test(p)) throw new HttpError(400, "period must be YYYY-MM"); return p; }

/** Revenue overview: Trupti sees revenue, direct share, OTA clearing, pending approvals — never expenses. */
r.get("/revenue", requireCap("revenue_reports"), async (c) => {
  const p = c.get("property");
  const per = period(c);
  const rev = await revenueSummary(c.env.DB, p.id, per);
  const pending = await all(c.env.DB, "SELECT COUNT(*) AS n FROM approvals WHERE property_id = ? AND status = 'pending'", p.id);
  return c.json({ ...rev, pending_approvals: (pending[0] as any).n });
});

r.get("/preclose", requireCap("revenue_reports"), async (c) => c.json(await precloseExceptions(c.env.DB, c.get("property").id, period(c))));

/** Full P&L: owner and CA only. The API returns 403 to everyone else, whatever the menu shows. */
r.get("/pnl", requireCap("pnl_reports"), async (c) => {
  const p = c.get("property"); const per = period(c);
  const [rev, exp] = await Promise.all([revenueSummary(c.env.DB, p.id, per), expenseSummary(c.env.DB, p.id, per)]);
  return c.json({ period: per, revenue: rev, expenses: exp, operating_result_paise: rev.taxable_paise - exp.total_paise });
});

/** Owner statement: result, cash position, month status, who-does-what. */
r.get("/owner", requireCap("pnl_reports"), async (c) => {
  const p = c.get("property"); const per = period(c);
  const [rev, exp] = await Promise.all([revenueSummary(c.env.DB, p.id, per), expenseSummary(c.env.DB, p.id, per)]);
  const lock = await all(c.env.DB, "SELECT status, version, locked_at, filed_at FROM period_locks WHERE property_id = ? AND period = ?", p.id, per);
  const users = await all(c.env.DB, "SELECT name, role FROM users WHERE property_id = ? AND active = 1 ORDER BY role", p.id);
  return c.json({ period: per, revenue_paise: rev.taxable_paise, expenses_paise: exp.total_paise, operating_result_paise: rev.taxable_paise - exp.total_paise, ota_clearing: rev.ota_clearing, direct_share_pct: rev.direct_share_pct, month: (lock[0] as any) ?? { status: "open", version: 0 }, who_does_what: users });
});

r.get("/audit", requireCap("audit"), async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const entity = c.req.query("entity"), entityId = c.req.query("id"), per = c.req.query("period");
  const where = ["property_id = ?"]; const params: unknown[] = [p.id];
  if (entity) { where.push("entity = ?"); params.push(entity); }
  if (entityId) { where.push("entity_id = ?"); params.push(entityId); }
  if (per) { where.push("substr(at,1,7) = ?"); params.push(per); }
  if (!allowed(actor, "pnl_reports")) where.push("entity NOT IN ('expense')"); // revenue desk never sees expense edits
  const rows = await all(c.env.DB, `SELECT * FROM audit_log WHERE ${where.join(" AND ")} ORDER BY at DESC LIMIT 500`, ...params);
  return c.json({ audit: rows });
});

export default r;
