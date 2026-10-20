import { describe, it, expect, beforeAll } from "vitest";
import { seed, api, ok, sql } from "./helpers";

/** Two banks: each its own ledger; the default bank receives money unless a screen picks another; transfers move money between them. */
describe("Bank accounts", () => {
  beforeAll(seed);
  let idfc: string;

  it("owner adds IDFC as the default bank; Yes Bank keeps its history", async () => {
    await ok("shaji", "PATCH", "/api/admin/accounts/acc_bank", { name: "Yes Bank", account_no: "4411" });
    expect((await api("trupti", "POST", "/api/admin/accounts", { name: "IDFC First" })).status).toBe(403);
    const r = await ok("shaji", "POST", "/api/admin/accounts", { name: "IDFC First", account_no: "0917", opening_paise: 1000000, opening_date: "2026-10-21", is_default: true });
    idfc = r.id;
    const accts = (await ok("shaji", "GET", "/api/admin/accounts")).accounts;
    expect(accts.find((a: any) => a.id === "acc_bank")).toMatchObject({ name: "Yes Bank", is_default: 0, account_no: "4411" });
    expect(accts.find((a: any) => a.id === idfc)).toMatchObject({ kind: "bank", is_default: 1, opening_paise: 1000000 });
    const ref = await ok("prachi", "GET", "/api/ref");
    expect(ref.accounts.filter((a: any) => a.kind === "bank")).toHaveLength(2);
    // Cannot close the default bank; can after moving the default.
    expect((await api("shaji", "PATCH", `/api/admin/accounts/${idfc}`, { active: false })).status).toBe(409);
  });

  it("money lands in the default bank unless the caller picks one", async () => {
    const b = await ok("prachi", "POST", "/api/bookings", { guest_name: "Bank Guest", guest_phone: "9400000001", check_in: "2027-02-01", check_out: "2027-02-02", rooms: [{ room_id: "loc_r1", nightly_rate_paise: 600000 }] });
    const p1 = await ok("sindhu", "POST", "/api/payments", { booking_id: b.booking.id, method: "upi", amount_paise: 100000, reference: "UPI1" });
    const p2 = await ok("sindhu", "POST", "/api/payments", { booking_id: b.booking.id, method: "bank", amount_paise: 100000, reference: "NEFT2", account_id: "acc_bank" });
    const rows = await sql("SELECT id, account_id FROM payments WHERE id IN (?, ?)", p1.id, p2.id);
    expect(rows.find((r: any) => r.id === p1.id).account_id).toBe(idfc);
    expect(rows.find((r: any) => r.id === p2.id).account_id).toBe("acc_bank");
    // Other income by bank → default bank; bank expense names its account.
    const inc = await ok("sindhu", "POST", "/api/income", { category: "dining", description: "Lunch", amount_paise: 50000, method: "bank" });
    expect((await sql("SELECT account_id FROM other_income WHERE id = ?", inc.id))[0].account_id).toBe(idfc);
    expect((await api("shaji", "POST", "/api/payments", { booking_id: b.booking.id, method: "bank", amount_paise: 100, account_id: "acc_nope" })).status).toBe(400);
  });

  it("an OTA payout can be pointed at a named bank", async () => {
    const b = await ok("prachi", "POST", "/api/bookings", { guest_name: "OTA Bank Guest", guest_phone: "9400000002", channel_code: "booking_com", external_ref: "BK-9001", check_in: "2026-10-01", check_out: "2026-10-02", rooms: [{ room_id: "loc_r2", nightly_rate_paise: 600000 }] });
    await sql("UPDATE bookings SET status = 'checked_out', checked_out_at = '2026-10-02T05:00:00Z' WHERE id = ?", b.booking.id);
    const s = await ok("trupti", "POST", "/api/settlements", { channel_code: "booking_com", booking_ids: [b.booking.id], payout_ref: "YESBANK-001", payout_on: "2026-10-12" });
    await ok("trupti", "POST", `/api/settlements/${s.id}/settle`, { account_id: "acc_bank" });
    const pays = await sql("SELECT account_id FROM payments WHERE booking_id = ? AND method = 'ota'", b.booking.id);
    expect(pays).toHaveLength(1); expect(pays[0].account_id).toBe("acc_bank");
  });

  it("a Yes Bank → IDFC transfer moves the balance and shows on both ledgers", async () => {
    const before = (await ok("shaji", "GET", "/api/payments/accounts")).accounts;
    const yesBefore = before.find((a: any) => a.id === "acc_bank").balance_paise; const idfcBefore = before.find((a: any) => a.id === idfc).balance_paise;
    await ok("shaji", "POST", "/api/payments/transfers", { from_account_id: "acc_bank", to_account_id: idfc, amount_paise: 250000, reference: "IMPS-7788", note: "moving the float" });
    const after = (await ok("shaji", "GET", "/api/payments/accounts")).accounts;
    expect(after.find((a: any) => a.id === "acc_bank").balance_paise).toBe(yesBefore - 250000);
    expect(after.find((a: any) => a.id === idfc).balance_paise).toBe(idfcBefore + 250000);
    // Each side reconciles against its own statement: the debit on Yes Bank, the credit on IDFC.
    const yes = await ok("shaji", "POST", "/api/recon/paste", { account_id: "acc_bank", text: "21/10/2026\tIMPS TO IDFC IMPS-7788\t2500.00\t" });
    expect(yes.inserted).toBe(1);
    const yesLine = (await sql("SELECT status, match_kind FROM bank_statement_lines WHERE account_id = 'acc_bank' AND reference LIKE '%7788%' OR description LIKE '%IMPS-7788%' ORDER BY id DESC LIMIT 1"))[0];
    expect(yesLine.match_kind).toBe("transfer");
    const idf = await ok("shaji", "POST", "/api/recon/paste", { account_id: idfc, text: "21/10/2026\tIMPS FROM YES BANK IMPS-7788\t\t2500.00" });
    expect(idf.inserted).toBe(1);
    const idfLine = (await sql("SELECT status, match_kind FROM bank_statement_lines WHERE account_id = ? ORDER BY id DESC LIMIT 1", idfc))[0];
    expect(idfLine.match_kind).toBe("transfer");
  });

  it("Yes Bank can be closed once IDFC is the default; closed banks leave the pickers but keep history", async () => {
    await ok("shaji", "PATCH", "/api/admin/accounts/acc_bank", { active: false });
    const ref = await ok("shaji", "GET", "/api/ref");
    expect(ref.accounts.find((a: any) => a.id === "acc_bank")).toBeUndefined();
    expect((await api("shaji", "POST", "/api/payments", { method: "bank", amount_paise: 100, account_id: "acc_bank" })).status).toBe(400);
    expect((await sql("SELECT COUNT(*) AS n FROM payments WHERE account_id = 'acc_bank'"))[0].n).toBeGreaterThan(0);
    await ok("shaji", "PATCH", "/api/admin/accounts/acc_bank", { active: true });
  });
});
