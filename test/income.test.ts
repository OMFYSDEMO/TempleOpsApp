import { describe, it, expect, beforeAll } from "vitest";
import { seed, api, ok, sql } from "./helpers";

// Other income: meals, photoshoots, events. It must reach the cash ledger, revenue and the GST sheet.
describe("Other income", () => {
  beforeAll(async () => { await seed(); await sql("UPDATE properties SET gstin = '32AARCM3606J1ZD' WHERE id = 'prop_meadows'"); });

  it("records income with the GST split, lands in the account and in revenue", async () => {
    const before = await ok("sindhu", "GET", "/api/payments/accounts");
    const cashBefore = before.accounts.find((a: any) => a.id === "acc_cash").balance_paise;
    const r = await ok("sindhu", "POST", "/api/income", { on_date: "2026-09-05", category: "dining", description: "Lunch sadhya × 9", payer_name: "Anjita", amount_paise: 450000, gst_rate_bp: 500, method: "cash" });
    expect(r.taxable_paise + r.gst_paise).toBe(450000);
    expect(r.gst_paise).toBe(21429); // 4500 inclusive at 5% → 214.29 GST
    expect(r.account_id).toBe("acc_cash");
    const after = await ok("sindhu", "GET", "/api/payments/accounts");
    expect(after.accounts.find((a: any) => a.id === "acc_cash").balance_paise - cashBefore).toBe(450000);
    const rev = await ok("trupti", "GET", "/api/reports/revenue?period=2026-09");
    expect(rev.other_income.n).toBe(1);
    expect(rev.taxable_paise).toBe(rev.rooms_taxable_paise + r.taxable_paise);
    expect(rev.by_slab.find((s: any) => s.gst_rate_bp === 500).gst_paise).toBeGreaterThanOrEqual(21429);
    const gst = await ok("ca", "GET", "/api/close/2026-09/gst");
    expect(gst.output_gst_paise).toBeGreaterThanOrEqual(21429);
  });

  it("void follows the income out of the ledger and revenue; sales cannot record it", async () => {
    const r = await ok("sindhu", "POST", "/api/income", { on_date: "2026-09-04", category: "photo", description: "Wedding photoshoot", payer_name: "Febin", amount_paise: 200000, gst_rate_bp: 0, method: "cash" });
    expect(r.gst_paise).toBe(0);
    await ok("sindhu", "POST", `/api/income/${r.id}/void`, { reason: "entered twice" });
    const list = await ok("sindhu", "GET", "/api/income?period=2026-09");
    expect(list.income.find((i: any) => i.id === r.id).voided_at).toBeTruthy();
    const rev = await ok("trupti", "GET", "/api/reports/revenue?period=2026-09");
    expect(rev.other_income.n).toBe(1);
    expect((await api("prachi", "POST", "/api/income", { category: "other", description: "x", amount_paise: 100, method: "cash" })).status).toBe(403);
    expect((await api("sindhu", "POST", "/api/income", { category: "nope", description: "x", amount_paise: 100, method: "cash" })).status).toBe(400);
  });
});
