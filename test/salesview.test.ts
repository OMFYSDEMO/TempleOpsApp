import { describe, it, expect, beforeAll } from "vitest";
import { seed, ok, sql } from "./helpers";

/** Sales see every stay, whoever booked it (in-house guests above all); ?mine=1 still narrows to their own. */
describe("Reservations: sales see every booking", () => {
  beforeAll(seed);
  it("a stay the owner entered is on the sales list, in house included; mine=1 leaves it out", async () => {
    const b = await ok("shaji", "POST", "/api/bookings", { guest_name: "Owner Booked Guest", guest_phone: "9400000401", channel_code: "direct", check_in: "2026-11-15", check_out: "2026-11-18", rooms: [{ room_id: "loc_r4", nightly_rate_paise: 500000 }] });
    await sql("UPDATE bookings SET status = 'checked_in', checked_in_at = '2026-11-15T09:00:00Z' WHERE id = ?", b.booking.id);
    const all = (await ok("prachi", "GET", "/api/bookings")).bookings;
    expect(all.find((x: any) => x.id === b.booking.id)?.status).toBe("checked_in");
    expect((await ok("prachi", "GET", `/api/bookings/${b.booking.id}`)).booking.id).toBe(b.booking.id);
    const mine = (await ok("prachi", "GET", "/api/bookings?mine=1")).bookings;
    expect(mine.find((x: any) => x.id === b.booking.id)).toBeUndefined();
  });
});
