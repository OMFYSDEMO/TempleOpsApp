import { describe, it, expect, beforeAll } from "vitest";
import { seed, ok, api, sql } from "./helpers";

/**
 * Refunds on cancellation (owner's rules, Nov 2026): never the invoice amount, only what Meadows received after gateway
 * and card-machine charges; free cancellation up to 7 days before arrival, the total price charged inside 7 days, no-shows
 * charged, the hotel's own cancellations refunded in full; bank transfer only, with the guest's account taken at cancel.
 */
describe("Cancellation refunds", () => {
  beforeAll(seed);
  const bank = { payee_name: "Priya Guest", account_no: "123456789012", account_no_confirm: "123456789012", ifsc: "HDFC0001234", bank_name: "HDFC" };
  const stay = (name: string, phone: string, room: string, ci: string, co: string) => ok("prachi", "POST", "/api/bookings", { guest_name: name, guest_phone: phone, channel_code: "direct", check_in: ci, check_out: co, rooms: [{ room_id: room, nightly_rate_paise: 500000 }] });
  const pay = (id: string, method: string, amount: number) => ok("shaji", "POST", "/api/payments", { booking_id: id, method, amount_paise: amount, reference: "R-" + method });
  const in_ = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  it("the quote takes the card-machine charge off: refund at most what Meadows received", async () => {
    const b = await stay("Card Guest", "9400000701", "loc_r1", in_(20), in_(21));
    await pay(b.booking.id, "card", 1000000);
    const q = await ok("prachi", "GET", `/api/bookings/${b.booking.id}/refund-quote?reason=guest_cancelled`);
    expect(q.paid_paise).toBe(1000000);
    expect(q.charges_paise).toBe(17700); // 1.77%
    expect(q.net_received_paise).toBe(982300);
    expect(q.policy_refund_paise).toBe(982300);
    // The invoice or gross amount is refused; the net is accepted.
    expect((await api("prachi", "POST", `/api/bookings/${b.booking.id}/cancel`, { reason: "x", refund: { reason_code: "guest_cancelled", refund_paise: 1000000, ...bank } })).status).toBe(400);
    const r = await ok("prachi", "POST", `/api/bookings/${b.booking.id}/cancel`, { reason: "Guest cancelled", refund: { reason_code: "guest_cancelled", refund_paise: 982300, ...bank } });
    const [apr] = await sql("SELECT amount_paise, status FROM approvals WHERE id = ?", r.refundApprovalId);
    expect(apr).toMatchObject({ amount_paise: 982300, status: "pending" });
    const rr = (await sql("SELECT payee_name, account_no, ifsc, net_received_paise FROM refund_requests WHERE booking_id = ?", b.booking.id))[0];
    expect(rr).toMatchObject({ payee_name: "Priya Guest", account_no: "123456789012", ifsc: "HDFC0001234", net_received_paise: 982300 });
    // The revenue desk sees the whole request on Approvals.
    const list = (await ok("trupti", "GET", "/api/approvals")).approvals.find((a: any) => a.id === r.refundApprovalId);
    expect(list).toMatchObject({ rf_net: 982300, rf_account: "123456789012", rf_ifsc: "HDFC0001234" });
  });

  it("a paid booking cannot be cancelled without the refund details; bank details are checked", async () => {
    const b = await stay("No Details", "9400000702", "loc_r2", in_(20), in_(21));
    await pay(b.booking.id, "upi", 500000);
    const bare = await api("prachi", "POST", `/api/bookings/${b.booking.id}/cancel`, { reason: "guest cancelled" });
    expect(bare.status).toBe(409);
    expect((bare.json as any).detail.needs_refund).toBe(true);
    expect((await api("prachi", "POST", `/api/bookings/${b.booking.id}/cancel`, { reason: "x", refund: { reason_code: "guest_cancelled", refund_paise: 500000, ...bank, account_no_confirm: "123456789013" } })).status).toBe(400);
    expect((await api("prachi", "POST", `/api/bookings/${b.booking.id}/cancel`, { reason: "x", refund: { reason_code: "guest_cancelled", refund_paise: 500000, ...bank, ifsc: "HDFC1234" } })).status).toBe(400);
  });

  it("inside 7 days the policy refunds nothing; more needs a reason; the hotel's own cancellation refunds in full", async () => {
    const b = await stay("Late Cancel", "9400000703", "loc_r3", in_(3), in_(4));
    await pay(b.booking.id, "upi", 500000);
    const q = await ok("prachi", "GET", `/api/bookings/${b.booking.id}/refund-quote?reason=guest_cancelled`);
    expect(q.policy_refund_paise).toBe(0);
    expect((await ok("prachi", "GET", `/api/bookings/${b.booking.id}/refund-quote?reason=overbooking`)).policy_refund_paise).toBe(500000);
    expect((await api("prachi", "POST", `/api/bookings/${b.booking.id}/cancel`, { reason: "x", refund: { reason_code: "guest_cancelled", refund_paise: 250000, ...bank } })).status).toBe(400);
    const r = await ok("prachi", "POST", `/api/bookings/${b.booking.id}/cancel`, { reason: "x", refund: { reason_code: "guest_cancelled", refund_paise: 250000, above_policy_reason: "goodwill, owner agreed", ...bank } });
    expect((await sql("SELECT note FROM approvals WHERE id = ?", r.refundApprovalId))[0].note).toContain("above policy: goodwill");
  });

  it("no refund means no approval; a no-show pays the fee and raises no refund", async () => {
    const b = await stay("Keeps Nothing", "9400000704", "loc_r4", in_(2), in_(3));
    await pay(b.booking.id, "upi", 300000);
    const r = await ok("prachi", "POST", `/api/bookings/${b.booking.id}/cancel`, { reason: "late cancel", refund: { reason_code: "guest_cancelled", refund_paise: 0 } });
    expect(r.refundApprovalId).toBeNull();
    const ns = await stay("No Show", "9400000705", "loc_r1", in_(40), in_(41));
    await pay(ns.booking.id, "upi", 300000);
    await sql("UPDATE bookings SET check_in = ? WHERE id = ?", in_(0), ns.booking.id);
    const n = await ok("sindhu", "POST", `/api/bookings/${ns.booking.id}/no-show`, {});
    expect(n.refundApprovalId).toBeNull();
  });
});

describe("Refund asked after the booking was cancelled", () => {
  beforeAll(seed);
  const bank = { payee_name: "Late Request", account_no: "998877665544", account_no_confirm: "998877665544", ifsc: "SBIN0001234" };
  const in_ = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  it("an old refund is returned; the desk asks again with the reason, net received and bank account; one at a time", async () => {
    const b = await ok("prachi", "POST", "/api/bookings", { guest_name: "Overbooked Guest", guest_phone: "9400000801", channel_code: "direct", check_in: in_(17), check_out: in_(18), rooms: [{ room_id: "loc_r2", nightly_rate_paise: 500000 }] });
    await ok("shaji", "POST", "/api/payments", { booking_id: b.booking.id, method: "airpay", amount_paise: 1155000, reference: "AP-1" });
    // Cancelled the old way (an email cancellation): a refund to decide, without details.
    await sql("UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'Over Booking' WHERE id = ?", new Date().toISOString(), b.booking.id);
    await sql("INSERT INTO approvals (id, property_id, kind, ref_id, summary, amount_paise, status) VALUES ('apr_old_rf', 'prop_meadows', 'refund', ?, 'old refund', 1155000, 'approved')", b.booking.id);
    const blocked = await api("prachi", "POST", `/api/bookings/${b.booking.id}/refund-request`, { refund: { reason_code: "overbooking", refund_paise: 1000000, ...bank } });
    expect(blocked.status).toBe(409); // the old approved refund is still open
    await sql("UPDATE approvals SET status = 'returned' WHERE id = 'apr_old_rf'");
    const q = await ok("prachi", "GET", `/api/bookings/${b.booking.id}/refund-quote?reason=overbooking`);
    expect(q.charges_paise).toBeGreaterThan(0); // Airpay's charge comes off
    expect(q.policy_refund_paise).toBe(q.net_received_paise);
    const r = await ok("prachi", "POST", `/api/bookings/${b.booking.id}/refund-request`, { refund: { reason_code: "overbooking", refund_paise: q.net_received_paise, ...bank } });
    expect((await sql("SELECT amount_paise, status FROM approvals WHERE id = ?", r.refundApprovalId))[0]).toMatchObject({ amount_paise: q.net_received_paise, status: "pending" });
    expect((await api("prachi", "POST", `/api/bookings/${b.booking.id}/refund-request`, { refund: { reason_code: "overbooking", refund_paise: 100, ...bank } })).status).toBe(409);
  });

  it("the 7-day rule counts from the day it was cancelled, not the day the refund is asked", async () => {
    const b = await ok("prachi", "POST", "/api/bookings", { guest_name: "Early Canceller", guest_phone: "9400000802", channel_code: "direct", check_in: in_(5), check_out: in_(6), rooms: [{ room_id: "loc_r3", nightly_rate_paise: 500000 }] });
    await ok("shaji", "POST", "/api/payments", { booking_id: b.booking.id, method: "upi", amount_paise: 500000, reference: "U-1" });
    await sql("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?", new Date(Date.now() - 10 * 86_400_000).toISOString(), b.booking.id);
    const q = await ok("prachi", "GET", `/api/bookings/${b.booking.id}/refund-quote?reason=guest_cancelled`);
    expect(q.days_before_arrival).toBeGreaterThanOrEqual(7);
    expect(q.policy_refund_paise).toBe(500000);
  });
});
