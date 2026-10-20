import { describe, it, expect, beforeAll } from "vitest";
import { seed, api, ok, sql } from "./helpers";

// Inbox automation (W1): emails apply themselves when the facts line up, and wait with a reason when they do not.
describe("Inbox automation", () => {
  beforeAll(async () => { await seed(); });

  const staah = (ref: string, extra = "") => ({ from: "noreply@staah.com", subject: "STAAH · New reservation · Booking.com", text: `Channel: Booking.com\nRef: ${ref}\nGuest: Meera Nair\nRoom: Premium ×1\nCheck-in: 12/12/2026\nCheck-out: 14/12/2026\nRoom Total: ₹14,000.00 (ex-GST)\nCommission: 23%\nChannel Collect${extra}` });

  it("books a STAAH reservation into a free room of the named type, then cancels it from the cancellation email", async () => {
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", staah("7000000000000001"));
    expect(ing.status).toBe("approved"); expect(ing.auto.applied).toBe(true); expect(ing.auto.what).toBe("booked");
    const nights = await sql("SELECT room_id, night FROM room_nights WHERE booking_id = ? ORDER BY night", ing.booking_id);
    expect(nights.map((n: any) => n.room_id)).toEqual(["loc_r2", "loc_r2"]);
    const notes = await sql("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'inbox_auto_booked'");
    expect(notes[0].n).toBeGreaterThan(0);
    const audit = await sql("SELECT actor_email FROM audit_log WHERE action = 'inbox.auto_book' AND entity_id = ?", ing.id);
    expect(audit[0].actor_email).toBe("inbox-automation");
    // The cancellation email releases the room without anyone touching it.
    const canc = await ok("prachi", "POST", "/api/inbox/ingest", { from: "noreply@staah.com", subject: "STAAH · Cancelled reservation · Booking.com", text: "Channel: Booking.com\nRef: 7000000000000001\nGuest: Meera Nair\nRoom: Premium ×1\nCheck-in: 12/12/2026\nCheck-out: 14/12/2026" });
    expect(canc.status).toBe("approved"); expect(canc.auto.what).toBe("cancelled");
    expect((await sql("SELECT status FROM bookings WHERE id = ?", ing.booking_id))[0].status).toBe("cancelled");
    expect((await sql("SELECT COUNT(*) AS n FROM room_nights WHERE booking_id = ?", ing.booking_id))[0].n).toBe(0);
  });

  it("leaves a card with the reason when the room type is taken or the channel is unknown", async () => {
    // Premium is the only Premium room: a second reservation for the same nights waits for a person.
    await ok("prachi", "POST", "/api/inbox/ingest", staah("7000000000000002"));
    const clash = await ok("prachi", "POST", "/api/inbox/ingest", staah("7000000000000003"));
    expect(clash.status).toBe("pending");
    expect(clash.auto.note).toMatch(/only 0 of 1 Premium/);
    const unknown = await ok("prachi", "POST", "/api/inbox/ingest", { from: "noreply@staah.com", subject: "STAAH · New reservation · Trivago", text: "Channel: Trivago\nRef: 7000000000000004\nGuest: Arun K\nRoom: Deluxe ×1\nCheck-in: 20/12/2026\nCheck-out: 21/12/2026\nRoom Total: ₹6,000.00 (ex-GST)" });
    expect(unknown.status).toBe("pending");
    expect(unknown.auto.note).toMatch(/channel "Trivago" is not set up/);
    const list = await ok("prachi", "GET", "/api/inbox?status=pending");
    expect(list.items.find((i: any) => i.id === unknown.id).auto_note).toMatch(/Trivago/);
    // A person can still approve it the old way, picking the channel and room.
    const appr = await ok("prachi", "POST", `/api/inbox/${unknown.id}/approve`, { room_ids: ["loc_r1"], channel_code: "booking_com" });
    expect(appr.booking.status).toBe("approved");
  });

  it("books a SwiftBook direct stay and records the Airpay payment for it, once", async () => {
    const sb = await ok("prachi", "POST", "/api/inbox/ingest", { from: "bookings@swiftbook.io", subject: "SwiftBook · New booking confirmed", text: "Guest: Rashmi Shah\nItinerary No: 10609000001012\n1 room · 2 nights\nRoom: Deluxe ×1\nCheck-in: 2026-12-26\nCheck-out: 2026-12-28\nTotal: ₹14,700.00\nPaid online" });
    expect(sb.status).toBe("approved"); expect(sb.auto.what).toBe("booked");
    const bk = (await sql("SELECT channel_id, gross_paise FROM bookings WHERE id = ?", sb.booking_id))[0] as any;
    expect(bk.channel_id).toBe("ch_swiftbook");
    const pay = await ok("prachi", "POST", "/api/inbox/ingest", { from: "alerts@airpay.co.in", subject: "Airpay · transaction successful", text: "Order: 10609000001012399437\nAmount: ₹14,700.00\nPayer: Rashmi Shah\nStatus: success" });
    expect(pay.status).toBe("approved"); expect(pay.auto.what).toBe("paid");
    const p = (await sql("SELECT booking_id, amount_paise, status, fee_expense_id, account_id FROM payments WHERE id = ?", pay.payment_id))[0] as any;
    expect(p.booking_id).toBe(sb.booking_id); expect(p.amount_paise).toBe(1470000); expect(p.status).toBe("confirmed"); expect(p.fee_expense_id).toBeTruthy(); expect(p.account_id).toBe("acc_gw");
    // The same receipt again is a duplicate, not a second payment.
    const again = await ok("prachi", "POST", "/api/inbox/ingest", { from: "alerts@airpay.co.in", subject: "Airpay · transaction successful", text: "Order: 10609000001012399437\nAmount: ₹14,700.00\nPayer: Rashmi Shah\nStatus: success", message_id: "<second@airpay>" });
    expect(again.status).toBe("duplicate");
    expect((await sql("SELECT COUNT(*) AS n FROM payments WHERE reference = '10609000001012399437' AND status != 'void'"))[0].n).toBe(1);
    // A receipt for no stay we hold routes to the Payments screen for a person.
    const stray = await ok("prachi", "POST", "/api/inbox/ingest", { from: "alerts@airpay.co.in", subject: "Airpay · transaction successful", text: "Order: 99990000000000001\nAmount: ₹500.00\nPayer: Someone\nStatus: success" });
    expect(stray.status).toBe("routed"); expect(stray.auto.note).toMatch(/no stay matches/);
    const gw = await ok("sindhu", "GET", "/api/payments/gateway-inbox");
    expect(gw.items.find((i: any) => i.id === stray.id)).toBeTruthy();
  });

  it("does nothing on its own when the owner switches automation off", async () => {
    await ok("shaji", "PATCH", "/api/admin/property", { inbox_automation: false });
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", { from: "noreply@staah.com", subject: "STAAH · New reservation · Agoda", text: "Channel: Agoda\nRef: 7000000000000009\nGuest: Lina P\nRoom: Executive ×1\nCheck-in: 05/01/2027\nCheck-out: 06/01/2027\nRoom Total: ₹5,000.00 (ex-GST)" });
    expect(ing.status).toBe("pending"); expect(ing.auto).toBeNull();
    await ok("shaji", "PATCH", "/api/admin/property", { inbox_automation: true });
    expect((await api("prachi", "PATCH", "/api/admin/property", { inbox_automation: false })).status).toBe(403);
  });
});
