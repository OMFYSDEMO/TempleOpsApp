import { describe, it, expect, beforeAll } from "vitest";
import { seed, ok, api, sql } from "./helpers";

/** The accountant sees every credit note in full and can open each one as a document. */
describe("Credit notes for the accountant", () => {
  beforeAll(seed);
  it("lists the credit note with its invoice, guest, GST and reason, and prints it", async () => {
    const b = await ok("prachi", "POST", "/api/bookings", { guest_name: "Credit Guest", guest_phone: "9400000901", channel_code: "direct", check_in: "2026-10-05", check_out: "2026-10-07", rooms: [{ room_id: "loc_r1", nightly_rate_paise: 500000 }] });
    await sql("UPDATE bookings SET status = 'checked_out', checked_out_at = '2026-10-07T05:00:00Z' WHERE id = ?", b.booking.id);
    const inv = await ok("sindhu", "POST", `/api/invoices/bookings/${b.booking.id}`);
    const cn = await ok("shaji", "POST", `/api/invoices/${inv.id}/credit-notes`, { reason: "amount corrected", issued_on: "2026-10-07" });
    const list = (await ok("ca", "GET", "/api/invoices/credit-notes?period=2026-10")).credit_notes;
    const row = list.find((x: any) => x.id === cn.id);
    expect(row).toMatchObject({ number: cn.number, invoice_number: inv.number, guest_name: "Credit Guest", reason: "amount corrected", issued_by_name: "Shaji", total_paise: cn.total_paise });
    const html = await api("ca", "GET", `/api/invoices/credit-notes/${cn.id}/html`);
    expect(html.status).toBe(200);
    const text = String((html.json as any).raw);
    expect(text).toContain("Credit Note");
    expect(text).toContain(inv.number);
    expect(text).toContain("amount corrected");
    // The front desk and sales cannot open the credit-note register.
    expect((await api("prachi", "GET", "/api/invoices/credit-notes")).status).toBe(403);
  });
});
