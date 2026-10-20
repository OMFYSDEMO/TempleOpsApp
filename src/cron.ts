import type { Env } from "./env";
import { Batch, all } from "./db";
import { nowIso } from "./domain/dates";
import { notifyRole, notifyUser } from "./services/notify";
import { PARSER_VERSION } from "./email/parsers";
import { reparseItem } from "./routes/inbox";

/**
 * Every few minutes: release expired holds and quotes, nudge the salesperson at 15 minutes,
 * escalate to the revenue desk at 60, and remind approvers of what waits.
 */
export async function runCron(env: Env) {
  const now = nowIso();
  const properties = await all<any>(env.DB, "SELECT * FROM properties");
  for (const p of properties) {
    const b = new Batch(env.DB, null);
    // Expired holds → inventory released, lead back to quoted with its quote intact.
    const expiredHolds = await all<any>(env.DB, "SELECT id FROM leads WHERE property_id = ? AND status = 'hold' AND hold_expires_at < ?", p.id, now);
    for (const l of expiredHolds) {
      b.add("DELETE FROM room_nights WHERE property_id = ? AND lead_id = ?", p.id, l.id);
      b.add("UPDATE leads SET status = 'quoted', hold_expires_at = NULL, updated_at = ? WHERE id = ?", now, l.id);
      b.audit("lead.hold_expired", "lead", l.id, { status: "hold" }, { status: "quoted" });
    }
    b.add("DELETE FROM room_nights WHERE property_id = ? AND kind = 'hold' AND expires_at < ?", p.id, now);
    // Expired quotes → lost with reason 'expired' (a reason chip, not a sixth status).
    const expiredQuotes = await all<any>(env.DB, "SELECT id FROM leads WHERE property_id = ? AND status = 'quoted' AND quote_expires_at < ?", p.id, now);
    for (const l of expiredQuotes) {
      b.add("UPDATE leads SET status = 'lost', lost_reason = 'expired', updated_at = ? WHERE id = ?", now, l.id);
      b.audit("lead.quote_expired", "lead", l.id, { status: "quoted" }, { status: "lost", reason: "expired" });
    }
    // Unanswered leads: nudge at N minutes, escalate at M.
    const nudgeAt = new Date(Date.now() - p.lead_nudge_minutes * 60_000).toISOString();
    const escalateAt = new Date(Date.now() - p.lead_escalate_minutes * 60_000).toISOString();
    const toNudge = await all<any>(env.DB, "SELECT l.id, l.assigned_to, g.name FROM leads l LEFT JOIN guests g ON g.id = l.guest_id WHERE l.property_id = ? AND l.status = 'new' AND l.nudged_at IS NULL AND replace(l.created_at,' ','T') < ?", p.id, nudgeAt);
    for (const l of toNudge) {
      if (l.assigned_to) notifyUser(b, p.id, l.assigned_to, "lead_nudge", `${l.name ?? "A lead"} has waited ${p.lead_nudge_minutes} min with no reply`, { kind: "lead", id: l.id });
      b.add("UPDATE leads SET nudged_at = ? WHERE id = ?", now, l.id);
    }
    const toEscalate = await all<any>(env.DB, "SELECT l.id, g.name FROM leads l LEFT JOIN guests g ON g.id = l.guest_id WHERE l.property_id = ? AND l.status = 'new' AND l.escalated_at IS NULL AND replace(l.created_at,' ','T') < ?", p.id, escalateAt);
    for (const l of toEscalate) {
      await notifyRole(b, p.id, "revenue", "lead_escalation", `${l.name ?? "A lead"} unanswered for ${p.lead_escalate_minutes} min`, { kind: "lead", id: l.id });
      b.add("UPDATE leads SET escalated_at = ? WHERE id = ?", now, l.id);
    }
    // Inbox items still waiting that were read by an older parser: read them again, so a template fix reaches old cards.
    const stale = await all<any>(env.DB, "SELECT id FROM inbox_items WHERE property_id = ? AND status IN ('pending','routed') AND auto_applied = 0 AND raw_key IS NOT NULL AND (parser_version IS NULL OR parser_version != ?) ORDER BY received_at LIMIT 20", p.id, PARSER_VERSION);
    for (const it of stale) { try { await reparseItem(env, p.id, it.id, null); } catch (e) { console.error("inbox re-read failed", it.id, e); } }
    if (b.size) await b.run();
  }
}
