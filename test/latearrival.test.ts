import { describe, it, expect, beforeAll } from "vitest";
import { seed, api, ok, sql } from "./helpers";
import { todayIn, addDays } from "../src/domain/dates";

/** A guest whose stay started yesterday but was never checked in must still be reachable from the front desk,
 *  and the desk records when they really arrived rather than "now". */
describe("Late arrivals at the front desk", () => {
  beforeAll(seed);
  const today = todayIn("Asia/Kolkata");
  const yesterday = addDays(today, -1);
  let id: string;

  it("lists a started stay that was never checked in", async () => {
    const r = await ok("shaji", "POST", "/api/bookings", { guest_name: "Late Guest", guest_phone: "9500000001", channel_code: "direct", check_in: yesterday, check_out: addDays(today, 1), rooms: [{ room_id: "loc_r4", nightly_rate_paise: 700000 }] });
    id = r.booking.id;
    const desk = await ok("sindhu", "GET", "/api/bookings/frontdesk/today");
    expect(desk.arrivals.find((b: any) => b.id === id)).toBeUndefined();
    expect(desk.late_arrivals.map((b: any) => b.id)).toContain(id);
  });

  it("rejects an arrival time before the booked check-in or in the future", async () => {
    expect((await api("sindhu", "POST", `/api/bookings/${id}/check-in`, { arrived_at: `${addDays(yesterday, -1)}T12:00:00+05:30` })).status).toBe(400);
    expect((await api("sindhu", "POST", `/api/bookings/${id}/check-in`, { arrived_at: new Date(Date.now() + 3600_000).toISOString() })).status).toBe(400);
  });

  it("checks in with the real arrival time and audits when it was recorded", async () => {
    const at = `${yesterday}T21:30:00+05:30`;
    const r = await ok("sindhu", "POST", `/api/bookings/${id}/check-in`, { arrived_at: at });
    expect(r.checked_in_at).toBe(new Date(at).toISOString());
    const [b] = await sql("SELECT status, checked_in_at FROM bookings WHERE id = ?", id);
    expect(b.status).toBe("checked_in"); expect(b.checked_in_at).toBe(new Date(at).toISOString());
    const [a] = await sql("SELECT after_json FROM audit_log WHERE entity_id = ? AND action = 'booking.check_in'", id);
    expect(JSON.parse(a.after_json).recorded_at).toBeTruthy();
    const desk = await ok("sindhu", "GET", "/api/bookings/frontdesk/today");
    expect(desk.late_arrivals.map((x: any) => x.id)).not.toContain(id);
    expect(desk.in_house.map((x: any) => x.id)).toContain(id);
  });
});
