import { describe, it, expect, beforeAll } from "vitest";
import { seed, ok, sql } from "./helpers";
import { parseInboundEmail } from "../src/email/parsers";

/** IDFC FIRST transaction alerts: Airpay credits settle the gateway float into the bank; everything else lands on Smart Reconcile. */
describe("Bank transaction alerts", () => {
  beforeAll(seed);
  const alert = (amount: string, from: string, ref: string, balance: string, when = "21-10-2026 17:02:09", dir = "credited") =>
    `<table><tr><td><strong>Dear Midhurst Hospitality Pvt Ltd,</strong><br><br>Greetings from IDFC FIRST Bank.<br><br>Your A/C XXXXXXX3390 has been ${dir} with INR ${amount} on ${when} vide NEFT payment reference ${ref} ${dir === "credited" ? "received from" : "towards"} ${from} .<br><br>New balance is INR ${balance}.</td></tr></table>`;

  it("reads the alert: account digits, direction, amount, date, reference, counterparty, balance", () => {
    const r = parseInboundEmail("transaction.alerts@idfcfirstbank.com", "Transaction alert from IDFC FIRST Bank", alert("32,729.33", "AIRPAY PAYMENT SERVICES PRIVATE", "CMS2942643026507", "503,881.33"));
    expect(r.source).toBe("bank"); expect(r.kind).toBe("bank_alert"); expect(r.confidence).toBe("high");
    expect(r.data).toMatchObject({ bank: "IDFC FIRST", account_last: "3390", direction: "credited", amount_paise: 3272933, on_date: "2026-10-21", at_time: "17:02:09", method: "NEFT", reference: "CMS2942643026507", counterparty: "AIRPAY PAYMENT SERVICES PRIVATE", balance_paise: 50388133 });
    // Forwarded from Gmail keeps working.
    const f = parseInboundEmail("bookings@meadowsvarkala.com", "Fwd: Transaction alert from IDFC FIRST Bank", undefined, "---------- Forwarded message ---------\nFrom: IDFC FIRST Bank <transaction.alerts@idfcfirstbank.com>\nSubject: Transaction alert\n\nYour A/C XXXXXXX3390 has been debited with INR 4,765.00 on 22-10-2026 10:00:01 vide NEFT payment reference N296260012 towards KSEB LTD .\n\nNew balance is INR 499,116.33.");
    expect(f.kind).toBe("bank_alert"); expect(f.data).toMatchObject({ direction: "debited", amount_paise: 476500, counterparty: "KSEB LTD", reference: "N296260012" });
  });

  it("an Airpay credit moves the money from Airpay clearing into the bank and is matched on the statement; the bank's balance is kept", async () => {
    await ok("shaji", "PATCH", "/api/admin/accounts/acc_bank", { name: "IDFC First", account_no: "3390" });
    const before = (await ok("shaji", "GET", "/api/payments/accounts")).accounts;
    const gwBefore = before.find((a: any) => a.id === "acc_gw").balance_paise, bankBefore = before.find((a: any) => a.id === "acc_bank").balance_paise;
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", { from: "transaction.alerts@idfcfirstbank.com", subject: "Transaction alert from IDFC FIRST Bank", html: alert("32,729.33", "AIRPAY PAYMENT SERVICES PRIVATE", "CMS2942643026507", "503,881.33") });
    expect(ing.status).toBe("approved"); expect(ing.auto.what).toBe("settled");
    const after = (await ok("shaji", "GET", "/api/payments/accounts")).accounts;
    const bank = after.find((a: any) => a.id === "acc_bank");
    expect(after.find((a: any) => a.id === "acc_gw").balance_paise).toBe(gwBefore - 3272933);
    expect(bank.balance_paise).toBe(bankBefore + 3272933);
    expect(bank.reported_balance_paise).toBe(50388133); expect(bank.reported_at).toMatch(/^2026-10-21T17:02:09/);
    const trf = (await sql("SELECT from_account_id, to_account_id, amount_paise, reference FROM transfers WHERE reference = 'CMS2942643026507'"))[0];
    expect(trf).toMatchObject({ from_account_id: "acc_gw", to_account_id: "acc_bank", amount_paise: 3272933 });
    const line = (await sql("SELECT status, match_kind, amount_paise FROM bank_statement_lines WHERE reference = 'CMS2942643026507'"))[0];
    expect(line).toMatchObject({ status: "matched", match_kind: "transfer", amount_paise: 3272933 });
    // The same alert again (the bank often sends twice, or it is forwarded twice) changes nothing.
    const again = await ok("prachi", "POST", "/api/inbox/ingest", { from: "transaction.alerts@idfcfirstbank.com", subject: "Transaction alert from IDFC FIRST Bank", html: alert("32,729.33", "AIRPAY PAYMENT SERVICES PRIVATE", "CMS2942643026507", "503,881.33") });
    expect(again.status).toBe("duplicate");
    expect((await sql("SELECT COUNT(*) AS n FROM transfers WHERE reference = 'CMS2942643026507'"))[0].n).toBe(1);
    // Revenue was told.
    expect((await sql("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'bank_alert'"))[0].n).toBeGreaterThan(0);
  });

  it("any other credit or debit becomes a statement line with the usual proposal for Smart Reconcile", async () => {
    await ok("shaji", "POST", "/api/expenses", { category: "utilities", amount_paise: 476500, account_id: "acc_bank", description: "KSEB", reference: "N296260012", on_date: "2026-10-22" });
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", { from: "transaction.alerts@idfcfirstbank.com", subject: "Transaction alert from IDFC FIRST Bank", html: alert("4,765.00", "KSEB LTD", "N296260012", "499,116.33", "22-10-2026 10:00:01", "debited") });
    expect(ing.status).toBe("approved"); expect(ing.auto.what).toBe("statement line");
    const line = (await sql("SELECT status, tier, match_kind, amount_paise FROM bank_statement_lines WHERE reference = 'N296260012'"))[0];
    expect(line).toMatchObject({ status: "proposed", tier: 1, match_kind: "expense", amount_paise: -476500 });
    expect((await ok("shaji", "GET", "/api/recon?period=2026-10")).lines.find((l: any) => l.reference === "N296260012").match.via).toBe("bank alert");
  });

  it("an alert for an account AVOS cannot place waits with the reason", async () => {
    await ok("shaji", "POST", "/api/admin/accounts", { name: "Yes Bank", account_no: "4411" });
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", { from: "transaction.alerts@idfcfirstbank.com", subject: "Transaction alert from IDFC FIRST Bank", html: alert("100.00", "SOMEONE", "REF77777777", "1.00").replace("XXXXXXX3390", "XXXXXXX9999") });
    expect(ing.status).toBe("routed"); expect(ing.auto.note).toMatch(/which bank is A\/C/);
  });
});
