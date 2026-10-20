import { newRouter, requireCap, int } from "../app";
import { slips, queueForRole } from "../services/work";
import { allowed } from "../auth";
import { HttpError } from "../db";

const r = newRouter();
r.use("*", requireCap("work"));

/** My work: the jobs on the signed-in role right now, plus what has been raised to it. */
r.get("/", async (c) => c.json(await queueForRole(c.env.DB, c.get("property"), c.get("actor").role)));

/** Slip report (owner): items that went overdue in the last N days, who had them, how long they waited. */
r.get("/slips", async (c) => {
  if (!allowed(c.get("actor"), "pnl_reports")) throw new HttpError(403, "owner only");
  return c.json({ slips: await slips(c.env.DB, c.get("property"), int(c.req.query("days") ?? 14, "days", { min: 1, max: 90 })) });
});

export default r;
