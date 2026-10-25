import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { seed, api, ok, sql } from "./helpers";

/** Card payments at the front desk settle into the bank the card machine belongs to, never the Airpay clearing account. */
describe("Card machine (POS) bank", () => {
  let bookingId: string;
  beforeAll(async () => {
    await seed();
    await env.DB.prepare("INSERT INTO money_accounts (id, property_id, kind, name, holder_role, opening_paise, opening_date, is_default) VALUES ('acc_new','prop_meadows','bank','New default bank','owner',0,'2026-10-01',1)").run();
    await env.DB.prepare("UPDATE money_accounts SET is_default = 0 WHERE id = 'acc_bank'").run();
    const bk = await ok("shaji", "POST", "/api/bookings", { guest_name: "Card Guest", guest_phone: "9500000222", channel_code: "direct", check_in: "2027-08-01", check_out: "2027-08-02", rooms: [{ room_id: "loc_r3", nightly_rate_paise: 550000 }] });
    bookingId = bk.booking.id;
  });

  it("without a setting, a card payment lands in the default bank, with the 1.77% charge", async () => {
    const r = await ok("sindhu", "POST", "/api/payments", { booking_id: bookingId, method: "card", amount_paise: 100000 });
    const [p] = await sql("SELECT p.account_id, e.amount_paise AS fee, e.paid_from_account_id FROM payments p JOIN expenses e ON e.id = p.fee_expense_id WHERE p.id = ?", r.id);
    expect(p.account_id).toBe("acc_new"); expect(p.fee).toBe(1770); expect(p.paid_from_account_id).toBe("acc_new");
  });

  it("with the card machine set to another bank, card payments land there; UPI still goes to the default", async () => {
    expect((await api("sindhu", "PATCH", "/api/admin/property", { pos_account_id: "acc_bank" })).status).toBe(403);
    expect((await api("shaji", "PATCH", "/api/admin/property", { pos_account_id: "acc_cash" })).status).toBe(400);
    await ok("shaji", "PATCH", "/api/admin/property", { pos_account_id: "acc_bank" });
    const card = await ok("sindhu", "POST", "/api/payments", { booking_id: bookingId, method: "card", amount_paise: 200000 });
    const upi = await ok("sindhu", "POST", "/api/payments", { booking_id: bookingId, method: "upi", amount_paise: 1000 });
    const rows = await sql("SELECT id, account_id FROM payments WHERE id IN (?, ?)", card.id, upi.id);
    expect(rows.find((x: any) => x.id === card.id).account_id).toBe("acc_bank");
    expect(rows.find((x: any) => x.id === upi.id).account_id).toBe("acc_new");
    const [a] = await sql("SELECT after_json FROM audit_log WHERE action = 'property.update' ORDER BY id DESC LIMIT 1");
    expect(JSON.parse(a.after_json).pos_account_id).toBe("acc_bank");
  });
});
