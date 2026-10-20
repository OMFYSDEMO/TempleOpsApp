import { describe, it, expect, beforeAll } from "vitest";
import { seed, api, ok, sql } from "./helpers";

// Amendments: a wrong room, date or rate is corrected in place with a remark; inventory and audit follow.
describe("Booking amendments", () => {
  beforeAll(async () => { await seed(); });

  it("sales exchange the room with a remark; inventory moves, the audit and the notes carry the reason", async () => {
    const r = await ok("prachi", "POST", "/api/bookings", { guest_name: "Gaury P", guest_phone: "9666666666", channel_code: "direct", check_in: "2027-03-10", check_out: "2027-03-11", rooms: [{ room_id: "loc_r1", nightly_rate_paise: 600000 }] });
    expect(r.booking.status).toBe("approved");
    expect((await api("prachi", "POST", `/api/bookings/${r.booking.id}/amend`, { rooms: [{ room_id: "loc_r3", nightly_rate_paise: 550000 }] })).status).toBe(400); // remark required
    const am = await ok("prachi", "POST", `/api/bookings/${r.booking.id}/amend`, { rooms: [{ room_id: "loc_r3", nightly_rate_paise: 550000 }], remark: "Cleartrip mapped the room type wrongly; the stay is in Superior" });
    expect(am.booking.status).toBe("approved"); expect(am.booking.needsApproval).toBe(false); // on tariff for Superior
    const nights = await sql("SELECT room_id FROM room_nights WHERE booking_id = ?", r.booking.id);
    expect(nights.map((n: any) => n.room_id)).toEqual(["loc_r3"]);
    const bk = (await sql("SELECT gross_paise, notes FROM bookings WHERE id = ?", r.booking.id))[0] as any;
    expect(bk.gross_paise).toBe(am.booking.grossPaise); expect(bk.notes).toMatch(/Amended .* by Prachi: Cleartrip mapped/);
    const audit = await sql("SELECT after_json FROM audit_log WHERE action = 'booking.amend' AND entity_id = ?", r.booking.id);
    expect(JSON.parse(audit[0].after_json as string).remark).toMatch(/Superior/);
    expect((await sql("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'booking_amended' AND ref_id = ?", r.booking.id))[0].n).toBeGreaterThan(0);
    // The room it moved to must be free: a clash is refused and nothing changes.
    await ok("prachi", "POST", "/api/bookings", { guest_name: "Other", guest_phone: "9777777777", check_in: "2027-03-10", check_out: "2027-03-11", rooms: [{ room_id: "loc_r2", nightly_rate_paise: 650000 }] });
    const clash = await api("prachi", "POST", `/api/bookings/${r.booking.id}/amend`, { rooms: [{ room_id: "loc_r2", nightly_rate_paise: 650000 }], remark: "try" });
    expect(clash.status).toBe(409); expect(clash.json.error).toMatch(/Premium not free/);
    expect((await sql("SELECT room_id FROM room_nights WHERE booking_id = ?", r.booking.id))[0].room_id).toBe("loc_r3");
  });

  it("a sales rate cut goes back through approval; the owner's amendment approves on the spot; dates and guest can change", async () => {
    const r = await ok("prachi", "POST", "/api/bookings", { guest_name: "Ravi K", guest_phone: "9888888888", check_in: "2027-05-01", check_out: "2027-05-02", rooms: [{ room_id: "loc_r4", nightly_rate_paise: 700000 }] });
    const cut = await ok("prachi", "POST", `/api/bookings/${r.booking.id}/amend`, { rooms: [{ room_id: "loc_r4", nightly_rate_paise: 500000 }], remark: "agreed a discount on the phone" });
    expect(cut.booking.needsApproval).toBe(true); expect(cut.booking.status).toBe("provisional");
    expect((await sql("SELECT COUNT(*) AS n FROM approvals WHERE ref_id = ? AND status = 'pending'", r.booking.id))[0].n).toBe(1);
    const own = await ok("shaji", "POST", `/api/bookings/${r.booking.id}/amend`, { check_in: "2027-05-02", check_out: "2027-05-04", guest_name: "Ravi Kumar", guest_phone: "9888888888", remark: "guest moved the dates by a day and stays two nights" });
    expect(own.booking.status).toBe("approved");
    const bk = (await sql("SELECT b.check_in, b.check_out, b.nights, b.status, g.name FROM bookings b JOIN guests g ON g.id = b.guest_id WHERE b.id = ?", r.booking.id))[0] as any;
    expect(bk).toMatchObject({ check_in: "2027-05-02", check_out: "2027-05-04", nights: 2, status: "approved", name: "Ravi Kumar" });
    expect((await sql("SELECT COUNT(*) AS n FROM room_nights WHERE booking_id = ?", r.booking.id))[0].n).toBe(2);
    expect((await sql("SELECT COUNT(*) AS n FROM approvals WHERE ref_id = ? AND status = 'pending'", r.booking.id))[0].n).toBe(0);
    // Not for the front desk or the accountant, and never once a stay is over.
    expect((await api("sindhu", "POST", `/api/bookings/${r.booking.id}/amend`, { adults: 3, remark: "x" })).status).toBe(403);
    await ok("prachi", "POST", `/api/bookings/${r.booking.id}/cancel`, { reason: "test" });
    expect((await api("shaji", "POST", `/api/bookings/${r.booking.id}/amend`, { adults: 3, remark: "late" })).status).toBe(409);
  });
});
