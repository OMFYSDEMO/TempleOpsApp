import { describe, it, expect, beforeAll } from "vitest";
import { seed, api, ok, sql } from "./helpers";

/** A hand-typed booking can carry its booking-engine / OTA reference, so Airpay receipts and cancellations find it. */
describe("Booking-engine / OTA reference on hand-typed bookings", () => {
  beforeAll(seed);
  const stay = (name: string, phone: string, ref?: string, room = "loc_r1") => ({ guest_name: name, guest_phone: phone, channel_code: "direct", check_in: "2027-09-10", check_out: "2027-09-12", rooms: [{ room_id: room, nightly_rate_paise: 600000 }], ...(ref !== undefined ? { external_ref: ref } : {}) });
  let first: string, second: string;

  it("a new booking keeps the reference typed by hand, trimmed", async () => {
    const r = await ok("prachi", "POST", "/api/bookings", stay("Ref Guest", "9500000301", "  1060900000999001 "));
    first = r.booking.id;
    expect((await sql("SELECT external_ref FROM bookings WHERE id = ?", first))[0].external_ref).toBe("1060900000999001");
  });

  it("the same reference cannot go on a second live booking; a cancelled one frees it", async () => {
    const dup = await api("prachi", "POST", "/api/bookings", stay("Other Guest", "9500000302", "1060900000999001", "loc_r2"));
    expect(dup.status).toBe(409); expect(dup.json.error).toMatch(/already on Ref Guest's booking/);
    await ok("shaji", "POST", `/api/bookings/${first}/cancel`, { reason: "guest changed dates" });
    const again = await ok("prachi", "POST", "/api/bookings", stay("Ref Guest", "9500000301", "1060900000999001", "loc_r2"));
    second = again.booking.id;
  });

  it("Amend adds a reference, and an Airpay receipt is then recorded against that booking by itself", async () => {
    const plain = await ok("prachi", "POST", "/api/bookings", stay("Walk Guest", "9500000303", undefined, "loc_r3"));
    // Taken by another live booking: refused.
    expect((await api("prachi", "POST", `/api/bookings/${plain.booking.id}/amend`, { external_ref: "1060900000999001", remark: "add the engine reference" })).status).toBe(409);
    await ok("prachi", "POST", `/api/bookings/${plain.booking.id}/amend`, { external_ref: "1060900000999002", remark: "add the engine reference" });
    expect((await sql("SELECT external_ref FROM bookings WHERE id = ?", plain.booking.id))[0].external_ref).toBe("1060900000999002");
    const receipt = "PAYMENT DETAILS\nOrder ID\n10609000009990026676001\nCustomer Name\nWALK GUEST\nOrder Amount\nINR 5000.00\nAirpay Id\n2099999901\nhttps://nps.airpay.co.in/view.php?id=9";
    const ing = await ok("trupti", "POST", "/api/inbox/ingest", { from: "noreply@airpay.co.in", subject: "Congratulations! Order ID 10609000009990026676001 Transaction is Successful", text: receipt, message_id: "<ref-airpay@test>" });
    expect(ing.status).toBe("approved");
    const [p] = await sql("SELECT booking_id, amount_paise, method FROM payments WHERE id = ?", ing.payment_id);
    expect(p).toMatchObject({ booking_id: plain.booking.id, amount_paise: 500000, method: "airpay" });
    // Clearing the box removes the reference.
    await ok("prachi", "POST", `/api/bookings/${second}/amend`, { external_ref: "", remark: "reference was typed on the wrong booking" });
    expect((await sql("SELECT external_ref FROM bookings WHERE id = ?", second))[0].external_ref).toBeNull();
  });
});
