import { describe, it, expect, beforeAll } from "vitest";
import { seed, ok, sql } from "./helpers";

/**
 * STAAH is the inventory master; AVOS only reads it. A direct booking made, cancelled or moved by hand in AVOS leaves a
 * "close out / reopen in STAAH" item on the sales desk until someone ticks it done. (Seen live: Priya Yadav's stay was
 * booked in AVOS only, Expedia sold the same rooms, and the booking had to be cancelled as an overbooking.)
 */
describe("Close out in STAAH reminders", () => {
  beforeAll(seed);
  const open = async (bookingId: string) => sql("SELECT action, check_in, check_out, rooms, status FROM staah_closeouts WHERE booking_id = ? ORDER BY created_at, rowid", bookingId);
  const book = (name: string, phone: string, room: string, ci: string, co: string, extra: Record<string, unknown> = {}) =>
    ok("prachi", "POST", "/api/bookings", { guest_name: name, guest_phone: phone, channel_code: "direct", check_in: ci, check_out: co, rooms: [{ room_id: room, nightly_rate_paise: 500000 }], ...extra });

  it("a direct booking made by hand asks sales to close it out in STAAH, on My work and on Reservations, until ticked done", async () => {
    const r = await book("Hand Made", "9400000601", "loc_r1", "2026-12-26", "2026-12-28");
    const rows = await open(r.booking.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "close", check_in: "2026-12-26", check_out: "2026-12-28", status: "open" });
    const items = (await ok("prachi", "GET", "/api/bookings/staah-closeouts")).items;
    const it1 = items.find((x: any) => x.booking_id === r.booking.id);
    expect(it1).toBeTruthy();
    const work = await ok("prachi", "GET", "/api/work");
    expect(JSON.stringify(work)).toContain(`staah:${it1.id}`);
    await ok("prachi", "POST", `/api/bookings/staah-closeouts/${it1.id}/done`);
    expect((await open(r.booking.id))[0].status).toBe("done");
    expect(JSON.stringify(await ok("prachi", "GET", "/api/work"))).not.toContain(`staah:${it1.id}`);
    // Cancelled after STAAH was closed: the nights must be opened again there.
    await ok("prachi", "POST", `/api/bookings/${r.booking.id}/cancel`, { reason: "guest changed plans" });
    expect((await open(r.booking.id)).at(-1)).toMatchObject({ action: "reopen", status: "open" });
  });

  it("cancelled before STAAH was closed: nothing to reopen, the close-out is dropped", async () => {
    const r = await book("Quick Cancel", "9400000602", "loc_r2", "2026-12-26", "2026-12-28");
    await ok("prachi", "POST", `/api/bookings/${r.booking.id}/cancel`, { reason: "duplicate" });
    const rows = await open(r.booking.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "close", status: "dropped" });
  });

  it("moving the dates: an open close-out follows; one already done becomes reopen old + close new", async () => {
    const r = await book("Mover", "9400000603", "loc_r3", "2026-12-10", "2026-12-12");
    await ok("prachi", "POST", `/api/bookings/${r.booking.id}/amend`, { check_in: "2026-12-11", check_out: "2026-12-13", remark: "guest moved a day" });
    let rows = await open(r.booking.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "close", check_in: "2026-12-11", check_out: "2026-12-13", status: "open" });
    const id = (await sql("SELECT id FROM staah_closeouts WHERE booking_id = ?", r.booking.id))[0].id;
    await ok("prachi", "POST", `/api/bookings/staah-closeouts/${id}/done`);
    await ok("prachi", "POST", `/api/bookings/${r.booking.id}/amend`, { check_in: "2026-12-14", check_out: "2026-12-16", remark: "moved again" });
    rows = (await open(r.booking.id)).filter((x: any) => x.status === "open");
    expect(rows.map((x: any) => `${x.action} ${x.check_in}`).sort()).toEqual(["close 2026-12-14", "reopen 2026-12-11"]);
  });

  it("an OTA booking, or one that came in from a STAAH email, needs nothing: STAAH already has it", async () => {
    const ota = await ok("prachi", "POST", "/api/bookings", { guest_name: "Ota Guest", guest_phone: "9400000604", channel_code: "booking_com", external_ref: "BK-S604", check_in: "2026-12-20", check_out: "2026-12-21", rooms: [{ room_id: "loc_r4", nightly_rate_paise: 500000 }] });
    expect(await open(ota.booking.id)).toHaveLength(0);
  });
});
