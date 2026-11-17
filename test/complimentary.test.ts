import { describe, it, expect, beforeAll } from "vitest";
import { seed, ok, api, sql } from "./helpers";

/** A complimentary stay (influencer collaboration): every room at ₹0 whatever rate was typed, the reason recorded. */
describe("Complimentary stays", () => {
  beforeAll(seed);
  const booking = (id: string) => sql("SELECT gross_paise, gst_paise, complimentary, comp_reason, status FROM bookings WHERE id = ?", id).then((r) => r[0]);

  it("sales book a complimentary stay: rooms at ₹0, no GST, the reason kept, and it goes to the revenue desk", async () => {
    const r = await ok("prachi", "POST", "/api/bookings", { guest_name: "Collab Guest", guest_phone: "9400000501", channel_code: "direct", check_in: "2026-11-24", check_out: "2026-11-25", rooms: [{ room_id: "loc_r1", nightly_rate_paise: 600000 }], complimentary: true, comp_reason: "Influencer collaboration" });
    const b = await booking(r.booking.id);
    expect(b).toMatchObject({ gross_paise: 0, gst_paise: 0, complimentary: 1, comp_reason: "Influencer collaboration", status: "provisional" });
    expect((await sql("SELECT nightly_rate_paise FROM booking_rooms WHERE booking_id = ?", r.booking.id))[0].nightly_rate_paise).toBe(0);
    expect((await sql("SELECT summary FROM approvals WHERE ref_id = ? AND status = 'pending'", r.booking.id))[0].summary).toContain("complimentary: Influencer collaboration");
    const v = await api("prachi", "GET", `/api/bookings/${r.booking.id}/voucher`);
    expect(String((v.json as any).raw)).toContain("Complimentary stay");
  });

  it("needs a reason, and only a direct stay can be complimentary", async () => {
    const base = { guest_phone: "9400000502", check_in: "2026-11-26", check_out: "2026-11-27", rooms: [{ room_id: "loc_r2", nightly_rate_paise: 500000 }], complimentary: true };
    expect((await api("prachi", "POST", "/api/bookings", { ...base, guest_name: "No Reason", channel_code: "direct" })).status).toBe(400);
    expect((await api("prachi", "POST", "/api/bookings", { ...base, guest_name: "Ota Comp", channel_code: "booking_com", external_ref: "BK-C502", comp_reason: "collab" })).status).toBe(400);
  });

  it("the owner turns a ₹90 booking into a complimentary one by amending it, approved on the spot; it can be charged again", async () => {
    const r = await ok("prachi", "POST", "/api/bookings", { guest_name: "Ninety Rupees", guest_phone: "9400000503", channel_code: "direct", check_in: "2026-11-28", check_out: "2026-11-29", rooms: [{ room_id: "loc_r3", nightly_rate_paise: 9000 }] });
    await ok("shaji", "POST", `/api/bookings/${r.booking.id}/amend`, { complimentary: true, comp_reason: "Influencer collaboration", remark: "Collab stay, ₹90 entered by mistake" });
    expect(await booking(r.booking.id)).toMatchObject({ gross_paise: 0, complimentary: 1, status: "approved" });
    await ok("shaji", "POST", `/api/bookings/${r.booking.id}/amend`, { complimentary: false, rooms: [{ room_id: "loc_r3", nightly_rate_paise: 500000 }], remark: "Collab cancelled, paying guest" });
    const after = await booking(r.booking.id);
    expect(after.complimentary).toBe(0);
    expect(after.gross_paise).toBeGreaterThanOrEqual(500000);
  });
});
