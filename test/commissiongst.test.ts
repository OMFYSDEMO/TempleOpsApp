import { describe, it, expect, beforeAll } from "vitest";
import { seed, api, ok, sql } from "./helpers";

// OTAs charge 18% GST on their commission. It is a channel term, comes off the expected payout, and is booked
// with the commission as input GST so the payout and the books match the OTA statement.
describe("GST on OTA commission", () => {
  beforeAll(seed);

  it("the owner sets it per channel; the payout and the commission expense carry it", async () => {
    const ref = await ok("shaji", "GET", "/api/ref");
    const agoda = ref.channels.find((c: any) => c.code === "agoda");
    await ok("shaji", "PATCH", `/api/admin/channels/${agoda.id}`, { commission_bp: 1800, commission_gst_bp: 1800 });
    expect((await api("trupti", "PATCH", `/api/admin/channels/${agoda.id}`, { commission_gst_bp: 0 })).status).toBe(403);
    // The desks never see OTA terms.
    expect((await ok("prachi", "GET", "/api/ref")).channels.some((c: any) => "commission_gst_bp" in c)).toBe(false);

    const b = await ok("prachi", "POST", "/api/bookings", { guest_name: "Agoda Guest", guest_phone: "9500000081", channel_code: "agoda", external_ref: "AG-777001", check_in: "2027-08-01", check_out: "2027-08-02", rooms: [{ room_id: "loc_r4", nightly_rate_paise: 1000000 }] });
    const prev = await ok("trupti", "POST", "/api/settlements", { channel_code: "agoda", booking_ids: [b.booking.id], preview: true });
    const commission = prev.preview.commissionPaise;
    expect(commission).toBe(180000); // 18% of ₹10,000 ex-GST
    expect(prev.preview.commissionGstPaise).toBe(32400); // 18% of ₹1,800
    expect(prev.preview.expectedPaise).toBe(prev.preview.grossPaise - 180000 - 32400 - prev.preview.paymentFeePaise - prev.preview.tcsPaise - prev.preview.tdsPaise);

    const s = await ok("trupti", "POST", "/api/settlements", { channel_code: "agoda", booking_ids: [b.booking.id], payout_ref: "AGODA-PAY-1", payout_on: "2027-08-05" });
    await ok("trupti", "POST", `/api/settlements/${s.id}/settle`, {});
    const exp = (await sql("SELECT amount_paise, gst_rate_bp, gst_paise FROM expenses WHERE settlement_id = ? AND kind = 'ota_commission'", s.id))[0];
    expect(exp).toEqual({ amount_paise: 212400, gst_rate_bp: 1800, gst_paise: 32400 });
  });

  it("refuses a payout received before the bank's opening balance, which already holds it", async () => {
    await sql("UPDATE money_accounts SET opening_date = '2027-08-15' WHERE id = 'acc_bank'");
    const b = await ok("prachi", "POST", "/api/bookings", { guest_name: "Old Payout Guest", guest_phone: "9500000083", channel_code: "agoda", external_ref: "AG-777003", check_in: "2027-08-01", check_out: "2027-08-02", rooms: [{ room_id: "loc_r1", nightly_rate_paise: 1000000 }] });
    const s = await ok("trupti", "POST", "/api/settlements", { channel_code: "agoda", booking_ids: [b.booking.id], payout_ref: "AGODA-OLD-2", payout_on: "2027-08-10" });
    const r = await api("trupti", "POST", `/api/settlements/${s.id}/settle`, { account_id: "acc_bank" });
    expect(r.status).toBe(409);
    expect((await sql("SELECT status FROM settlements WHERE id = ?", s.id))[0].status).toBe("draft");
    // Only the owner may close it against the opening balance.
    expect((await api("trupti", "POST", `/api/settlements/${s.id}/settle`, { account_id: "acc_bank", before_opening: true })).status).toBe(403);
    const balance = async () => (await ok("shaji", "GET", "/api/payments/accounts?as_of=2027-12-31")).accounts.find((a: any) => a.id === "acc_bank").balance_paise;
    const openingOf = async () => (await sql("SELECT opening_paise FROM money_accounts WHERE id = 'acc_bank'"))[0].opening_paise;
    const before = await balance(), opening = await openingOf();
    await ok("shaji", "POST", `/api/settlements/${s.id}/settle`, { account_id: "acc_bank", before_opening: true });
    const st = (await sql("SELECT status, received_paise, opening_adjusted_paise FROM settlements WHERE id = ?", s.id))[0];
    expect(st.status).toBe("settled"); expect(st.opening_adjusted_paise).toBe(st.received_paise);
    // The bank balance is unchanged: the amount moved out of the opening into the payout record.
    expect(await balance()).toBe(before);
    expect(await openingOf()).toBe(opening - st.received_paise);
    // The commission is booked and the stay is settled.
    expect((await sql("SELECT COUNT(*) AS n FROM expenses WHERE settlement_id = ? AND kind = 'ota_commission' AND voided_at IS NULL", s.id))[0].n).toBe(1);
    expect((await ok("trupti", "GET", "/api/settlements/unsettled?channel=agoda")).stays.some((x: any) => x.id === b.booking.id)).toBe(false);
    // Undo puts the amount back into the opening.
    await ok("shaji", "POST", `/api/settlements/${s.id}/undo`, { reason: "test" });
    expect(await openingOf()).toBe(opening);
    expect(await balance()).toBe(before);
    await sql("UPDATE money_accounts SET opening_date = '2026-09-01' WHERE id = 'acc_bank'");
  });

  it("refuses a payout dated before a stay it is said to cover", async () => {
    const b = await ok("prachi", "POST", "/api/bookings", { guest_name: "Later Guest", guest_phone: "9500000082", channel_code: "agoda", external_ref: "AG-777002", check_in: "2027-09-10", check_out: "2027-09-11", rooms: [{ room_id: "loc_r4", nightly_rate_paise: 1000000 }] });
    const r = await api("trupti", "POST", "/api/settlements", { channel_code: "agoda", booking_ids: [b.booking.id], payout_ref: "AGODA-OLD-1", payout_on: "2027-08-29" });
    expect(r.status).toBe(409);
    expect((await sql("SELECT COUNT(*) AS n FROM settlements WHERE payout_ref = 'AGODA-OLD-1'"))[0].n).toBe(0);
  });
});
