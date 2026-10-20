import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { seed, ok, sql } from "./helpers";
import { runCron } from "../src/cron";

// The work queue: each role sees what is on it; past tolerance an item is raised once to the next desk.
describe("Work queue", () => {
  beforeAll(async () => { await seed(); });

  it("sales see a waiting email and an unanswered lead; revenue sees a pending approval; property sees a task", async () => {
    await ok("prachi", "POST", "/api/inbox/ingest", { from: "noreply@staah.com", subject: "STAAH · New reservation · Trivago", text: "Channel: Trivago\nRef: 8000000000000001\nGuest: Queue Guest\nRoom: Deluxe ×1\nCheck-in: 20/03/2027\nCheck-out: 21/03/2027\nRoom Total: ₹6,000.00" });
    await ok("prachi", "POST", "/api/leads", { name: "Lead Guest", phone: "9100000001", source: "whatsapp", check_in: "2027-03-01", check_out: "2027-03-03" });
    const bk = await ok("prachi", "POST", "/api/bookings", { guest_name: "Discount", guest_phone: "9100000002", check_in: "2027-04-01", check_out: "2027-04-02", rooms: [{ room_id: "loc_r1", nightly_rate_paise: 100000 }] });
    expect(bk.booking.status).toBe("provisional");
    await ok("sindhu", "POST", "/api/tasks", { kind: "housekeeping", location_id: "loc_r2", title: "Deep clean" });
    const sales = await ok("prachi", "GET", "/api/work");
    expect(sales.items.map((i: any) => i.kind).sort()).toEqual(expect.arrayContaining(["inbox", "lead"]));
    expect(sales.items.find((i: any) => i.kind === "inbox").title).toMatch(/Queue Guest/);
    expect(sales.overdue).toBe(0);
    const revenue = await ok("trupti", "GET", "/api/work");
    expect(revenue.items.find((i: any) => i.kind === "approval")).toBeTruthy();
    const property = await ok("sindhu", "GET", "/api/work");
    expect(property.items.find((i: any) => i.kind === "task" && i.title.startsWith("Deep clean"))).toBeTruthy();
    expect(property.items.find((i: any) => i.kind === "approval")).toBeUndefined();
  });

  it("past its tolerance an item is raised once to the next desk, the owner sees it, and it clears when done", async () => {
    const inbox = (await sql("SELECT id FROM inbox_items WHERE status = 'pending' ORDER BY received_at DESC LIMIT 1"))[0] as any;
    await sql("UPDATE inbox_items SET received_at = ? WHERE id = ?", new Date(Date.now() - 5 * 3_600_000).toISOString(), inbox.id);
    const sales = await ok("prachi", "GET", "/api/work");
    const it = sales.items.find((i: any) => i.key === `inbox:${inbox.id}`);
    expect(it.overdue).toBe(true); expect(it.escalated_to ?? null).toBeNull();
    await runCron(env as any);
    await runCron(env as any); // a second pass raises nothing new
    const rows = await sql("SELECT * FROM work_escalations WHERE item_key = ?", `inbox:${inbox.id}`);
    expect(rows.length).toBe(1); expect(rows[0].escalated_to).toBe("revenue"); expect(rows[0].cleared_at).toBeNull();
    expect((await sql("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'work_overdue' AND ref_id = ?", `inbox:${inbox.id}`))[0].n).toBe(1);
    const revenue = await ok("trupti", "GET", "/api/work");
    expect(revenue.raised.find((i: any) => i.key === `inbox:${inbox.id}`)).toBeTruthy();
    const owner = await ok("shaji", "GET", "/api/work");
    expect(owner.raised.find((i: any) => i.key === `inbox:${inbox.id}`)?.owner_role).toBe("sales");
    await ok("prachi", "POST", `/api/inbox/${inbox.id}/dismiss`, { reason: "handled" });
    await runCron(env as any);
    expect((await sql("SELECT cleared_at FROM work_escalations WHERE item_key = ?", `inbox:${inbox.id}`))[0].cleared_at).toBeTruthy();
    const slips = await ok("shaji", "GET", "/api/work/slips?days=7");
    expect(slips.slips.find((s: any) => s.item_key === `inbox:${inbox.id}`).waited_hours).toBeGreaterThan(4);
    expect((await ok("prachi", "GET", "/api/work")).items.find((i: any) => i.key === `inbox:${inbox.id}`)).toBeUndefined();
  });
});
