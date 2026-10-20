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

  it("reads a Gmail-forwarded STAAH notification in the real label-above-value layout and books it", async () => {
    // The forwarder's signature comes first; the STAAH sender and the table follow the "Forwarded message" marker.
    const text = `Kind Regards,\n\nShaji Anandan\nDirector - Sales & Marketing\nThe Meadows | Varkala\nGST - 32AARCM3606J1ZD\n\n============ Forwarded message ============\nFrom:  <noreply@staah.com>\nTo: <bookings@meadowsvarkala.com>\nDate: Mon, 19 Oct 2026 19:46:18 +0100\nSubject: New Reservation Goibibo for kumar Reservation No:0190589681 (1060900000001400) - The Meadows Varkala\n============ Forwarded message ============\nReservation Confirmation\nChannel Name: Goibibo\nBookings Status: Confirmed\nBooking Id#: 1060900000001400 (0190589681)\nGuest Details\nCONTACT NAME\nsaurav kumar\nCONTACT NUMBER\nALTERNATIVE NUMBER\nEMAIL\nBooking Details\nHOTEL\nThe Meadows Varkala\nBOOKING REFERENCE\n1060900000001400 (0190589681)\nADDRESS\n133/B, Marakkadamukku, Palachira PO.\nROOM TYPE\nPremium - Premium Room_CP\nNO OF ROOMS\n1\nCHECK-IN\n20 Jan 2027\nCHECK-OUT\n22 Jan 2027\nNO OF NIGHTS\n2\nDATE\n20 Jan 2027\nGUEST NAME\nsaurav kumar\nADULTS\n2\nCHILDREN\n1\nBEDDING\n--\nAMOUNT\nINR5,852.25\n21 Jan 2027\nsaurav kumar\n2\n1\n--\nINR5,852.25\n(Age of child 1:3)\nAdditional Information:\nChannel collect, Inclusions : Breakfast included , VendorName:: MakeMyTrip, Vendor BookingId:: NH7201234,\nPayment Type: Channel Collect\nCommission : INR 2,437.29\nRoom Total : INR 11,704.50\nTotal Taxes : INR 688.50\nTotal (All Inclusive): INR 12,393.00`;
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", { from: "bookings@meadowsvarkala.com", subject: "Fwd: New Reservation Goibibo for kumar Reservation No:0190589681 (1060900000001400) - The Meadows Varkala", text });
    expect(ing.parsed.source).toBe("staah"); expect(ing.parsed.kind).toBe("new_reservation");
    expect(ing.parsed.external_ref).toBe("1060900000001400"); expect(ing.parsed.data.ota_ref).toBe("0190589681");
    expect(ing.parsed.data).toMatchObject({ channel: "Goibibo", guest_name: "saurav kumar", room_name: "Premium", rooms: 1, nights: 2, adults: 2, children: 1, check_in: "2027-01-20", check_out: "2027-01-22", room_total_paise: 1170450, taxes_paise: 68850, total_incl_gst_paise: 1239300, commission_paise: 243729, collection_type: "channel_collect" });
    expect(ing.parsed.confidence).toBe("high");
    expect(ing.status).toBe("approved"); expect(ing.auto.what).toBe("booked");
    const bk = (await sql("SELECT channel_id, room_total_paise, external_ref FROM bookings WHERE id = ?", ing.booking_id))[0] as any;
    expect(bk.channel_id).toBe("ch_goibibo"); expect(bk.room_total_paise).toBe(1170450); expect(bk.external_ref).toBe("1060900000001400");
    expect((await sql("SELECT room_id FROM room_nights WHERE booking_id = ?", ing.booking_id))[0].room_id).toBe("loc_r2");
    // Re-reading a waiting card re-runs the parser and automation; a done card is left alone.
    expect((await api("prachi", "POST", `/api/inbox/${ing.id}/reparse`)).status).toBe(409);
    const unknown = await ok("prachi", "POST", "/api/inbox/ingest", { from: "someone@example.com", subject: "hello", text: "nothing to see" });
    expect(unknown.status).toBe("pending");
    const re = await ok("prachi", "POST", `/api/inbox/${unknown.id}/reparse`);
    expect(re.status).toBe("pending"); expect(re.parsed.source).toBe("unknown");
  });

  it("matches a cancellation to a stay that carries the migrated 'STAAH id (OTA ref)' reference", async () => {
    const r = await ok("prachi", "POST", "/api/bookings", { guest_name: "Migrated Guest", guest_phone: "9222222222", channel_code: "agoda", external_ref: "1060900000001308 (2049201329)", check_in: "2027-02-10", check_out: "2027-02-11", rooms: [{ room_id: "loc_r4", nightly_rate_paise: 500000 }] });
    const canc = await ok("prachi", "POST", "/api/inbox/ingest", { from: "noreply@staah.com", subject: "Cancelled Reservation Agoda for Migrated Reservation No:2049201329 (1060900000001308) - The Meadows Varkala", text: "Channel Name: Agoda\nBookings Status: Cancelled\nBooking Id#: 1060900000001308 (2049201329)\nGUEST NAME\nMigrated Guest\nCHECK-IN\n10 Feb 2027\nCHECK-OUT\n11 Feb 2027" });
    expect(canc.status).toBe("approved"); expect(canc.auto.what).toBe("cancelled");
    expect((await sql("SELECT status FROM bookings WHERE id = ?", r.booking.id))[0].status).toBe("cancelled");
  });

  it("does nothing on its own when the owner switches automation off", async () => {
    await ok("shaji", "PATCH", "/api/admin/property", { inbox_automation: false });
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", { from: "noreply@staah.com", subject: "STAAH · New reservation · Agoda", text: "Channel: Agoda\nRef: 7000000000000009\nGuest: Lina P\nRoom: Executive ×1\nCheck-in: 05/01/2027\nCheck-out: 06/01/2027\nRoom Total: ₹5,000.00 (ex-GST)" });
    expect(ing.status).toBe("pending"); expect(ing.auto).toBeNull();
    await ok("shaji", "PATCH", "/api/admin/property", { inbox_automation: true });
    expect((await api("prachi", "PATCH", "/api/admin/property", { inbox_automation: false })).status).toBe(403);
  });
});
