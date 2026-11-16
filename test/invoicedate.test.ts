import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { seed, ok, sql } from "./helpers";
import { runAutoInvoices } from "../src/services/invoices";

/**
 * Guest invoices are dated the check-out date (the CA's rule), and every checked-out stay gets one without anyone
 * pressing Issue invoice: OTA-collected stays at once, stays paid at the property once settled or a day after.
 */
describe("Guest invoices: dated at check-out, issued without being asked", () => {
  beforeAll(seed);
  const prop = async () => (await sql("SELECT * FROM properties WHERE id = 'prop_meadows'"))[0];
  const stay = async (guest: string, phone: string, channel: string, room: string, ci: string, co: string, checkedOutAt: string) => {
    const b = await ok("prachi", "POST", "/api/bookings", { guest_name: guest, guest_phone: phone, channel_code: channel, ...(channel === "booking_com" ? { external_ref: `BK-${phone}` } : {}), check_in: ci, check_out: co, rooms: [{ room_id: room, nightly_rate_paise: 500000 }] });
    await sql("UPDATE bookings SET status = 'checked_out', checked_out_at = ? WHERE id = ?", checkedOutAt, b.booking.id);
    return b.booking.id as string;
  };
  const invoiceOf = async (bookingId: string) => (await sql("SELECT number, issued_on, received_paise, balance_paise FROM invoices WHERE booking_id = ?", bookingId))[0];

  it("an invoice issued weeks later is dated the stay's check-out date", async () => {
    const id = await stay("September Guest", "9400000201", "direct", "loc_r1", "2026-09-07", "2026-09-09", "2026-09-09T05:00:00Z");
    const inv = await ok("sindhu", "POST", `/api/invoices/bookings/${id}`);
    expect(inv.issued_on).toBe("2026-09-09");
    expect((await invoiceOf(id)).issued_on).toBe("2026-09-09");
    expect((await ok("sindhu", "GET", "/api/invoices?period=2026-09")).invoices.some((i: any) => i.booking_id === id)).toBe(true);
  });

  it("the cron issues an OTA stay's invoice at once, shown as paid through the OTA", async () => {
    const id = await stay("Ota Guest", "9400000202", "booking_com", "loc_r2", "2026-11-10", "2026-11-12", "2026-11-12T05:00:00Z");
    await runAutoInvoices(env.DB, await prop(), "2026-11-12T05:10:00Z");
    const inv = await invoiceOf(id);
    expect(inv.issued_on).toBe("2026-11-12");
    expect(inv.balance_paise).toBe(0);
  });

  it("a direct stay still owing waits for the desk's Collect, then is issued a day after check-out at the latest", async () => {
    const id = await stay("Owing Guest", "9400000203", "direct", "loc_r3", "2026-11-10", "2026-11-12", "2026-11-12T05:00:00Z");
    await runAutoInvoices(env.DB, await prop(), "2026-11-12T06:00:00Z");
    expect(await invoiceOf(id)).toBeUndefined();
    await runAutoInvoices(env.DB, await prop(), "2026-11-13T06:00:00Z");
    expect((await invoiceOf(id)).issued_on).toBe("2026-11-12");
  });

  it("a stay in a locked month is left alone; the cron never issues twice", async () => {
    const id = await stay("Locked Guest", "9400000204", "booking_com", "loc_r4", "2026-08-10", "2026-08-12", "2026-08-12T05:00:00Z");
    await sql("INSERT INTO period_locks (property_id, period, status) VALUES ('prop_meadows', '2026-08', 'locked')");
    await runAutoInvoices(env.DB, await prop(), "2026-11-14T06:00:00Z");
    expect(await invoiceOf(id)).toBeUndefined();
    const before = (await sql("SELECT COUNT(*) AS n FROM invoices"))[0].n;
    await runAutoInvoices(env.DB, await prop(), "2026-11-14T06:05:00Z");
    expect((await sql("SELECT COUNT(*) AS n FROM invoices"))[0].n).toBe(before);
  });
});
