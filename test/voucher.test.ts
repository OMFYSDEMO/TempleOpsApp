import { describe, it, expect, beforeAll } from "vitest";
import { seed, ok, api } from "./helpers";

/** A booking made in AVOS (STAAH down, phone booking) gets a confirmation voucher the desk can send the guest. */
describe("Booking confirmation voucher", () => {
  beforeAll(seed);

  it("shows the stay, rooms, total, what was paid and the balance; not for a cancelled booking", async () => {
    const b = await ok("prachi", "POST", "/api/bookings", { guest_name: "Voucher Guest", guest_phone: "9400000301", channel_code: "direct", check_in: "2026-12-04", check_out: "2026-12-06", adults: 2, rooms: [{ room_id: "loc_r1", nightly_rate_paise: 550000 }] });
    const id = b.booking.id;
    await ok("prachi", "POST", "/api/payments", { booking_id: id, method: "upi", amount_paise: 500000, reference: "UPI123" });
    const r = await api("prachi", "GET", `/api/bookings/${id}/voucher`);
    expect(r.status).toBe(200);
    const html = String((r.json as any).raw);
    expect(html).toContain("Booking confirmation");
    expect(html).toContain("Voucher Guest");
    expect(html).toContain("from 2:00 pm");
    expect(html).toContain("2 adults");
    expect(html).toContain("Balance payable at the property");
    expect(html).toContain("not a tax invoice");
    expect((await api("sindhu", "GET", `/api/bookings/${id}/voucher`)).status).toBe(200);
    await ok("prachi", "POST", `/api/bookings/${id}/cancel`, { reason: "test", refund: { reason_code: "guest_cancelled", refund_paise: 0 } });
    expect((await api("prachi", "GET", `/api/bookings/${id}/voucher`)).status).toBe(409);
  });
});

describe("Booking confirmation voucher: AVOS direct bookings only", () => {
  beforeAll(seed);
  it("an OTA booking, or one that came in from a STAAH email, gets no AVOS voucher", async () => {
    const ota = await ok("prachi", "POST", "/api/bookings", { guest_name: "Ota Voucher", guest_phone: "9400000302", channel_code: "booking_com", external_ref: "BK-V302", check_in: "2026-12-10", check_out: "2026-12-11", rooms: [{ room_id: "loc_r2", nightly_rate_paise: 550000 }] });
    expect((await api("prachi", "GET", `/api/bookings/${ota.booking.id}/voucher`)).status).toBe(409);
    const staah = await ok("prachi", "POST", "/api/bookings", { guest_name: "Engine Voucher", guest_phone: "9400000303", channel_code: "direct", check_in: "2026-12-12", check_out: "2026-12-13", rooms: [{ room_id: "loc_r3", nightly_rate_paise: 550000 }] });
    const { sql } = await import("./helpers");
    await sql("UPDATE bookings SET inbox_item_id = 'inb_test' WHERE id = ?", staah.booking.id);
    expect((await api("prachi", "GET", `/api/bookings/${staah.booking.id}/voucher`)).status).toBe(409);
  });
});
