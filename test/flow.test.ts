import { describe, it, expect, beforeAll } from "vitest";
import { seed, api, ok, sql } from "./helpers";

/**
 * The Lead → CA acceptance flow on the seeded pilot property, through the HTTP API with the role walls on.
 */
describe("Lead → CA", () => {
  beforeAll(seed);

  let leadId: string, bookingId: string, otaBookingId: string, invoiceId: string, settlementId: string;

  it("health and identity", async () => {
    expect((await api(null, "GET", "/api/health")).json.ok).toBe(true);
    const deep = await api(null, "GET", "/api/health?deep=1");
    expect(deep.json).toMatchObject({ ok: true, db: "ok", r2: "ok" });
    expect((await api(null, "GET", "/api/me")).status).toBe(401);
    const me = await ok("prachi", "GET", "/api/me");
    expect(me.actor.role).toBe("sales");
    expect(me.capabilities).toContain("leads");
    expect(me.capabilities).not.toContain("pnl_reports");
  });

  it("W13 · lead: new → contacted → quoted → hold → won", async () => {
    const created = await ok("prachi", "POST", "/api/leads", { source: "instagram", name: "Meera Pillai", phone: "98765 43210", check_in: "2026-12-24", check_out: "2026-12-26", rooms_wanted: 2, adults: 4 });
    leadId = created.id;
    await ok("prachi", "POST", `/api/leads/${leadId}/contacted`);
    const q = await ok("prachi", "POST", `/api/leads/${leadId}/quote`, { room_ids: ["loc_r2", "loc_r4"] });
    // Peak card: Premium ₹7,500 and Executive ₹7,500 × 2 nights = ₹30,000; property unregistered → no GST yet.
    expect(q.quote.room_total_paise).toBe(3000000);
    expect(q.quote.gst_paise).toBe(0);
    expect(q.quote.on_tariff).toBe(true);
    expect(q.whatsapp_url).toContain("wa.me/919876543210");
    const h = await ok("prachi", "POST", `/api/leads/${leadId}/hold`);
    expect(h.hold_expires_at).toBeTruthy();
    const nights = await sql("SELECT room_id, night, kind FROM room_nights WHERE lead_id = ? ORDER BY room_id, night", leadId);
    expect(nights).toHaveLength(4);
    // A second lead cannot hold the same room-night (F1).
    const l2 = await ok("prachi", "POST", "/api/leads", { source: "phone", name: "Arjun Nair", phone: "9000000001" });
    await ok("prachi", "POST", `/api/leads/${l2.id}/quote`, { check_in: "2026-12-25", check_out: "2026-12-26", room_ids: ["loc_r2"] });
    expect((await api("prachi", "POST", `/api/leads/${l2.id}/hold`)).status).toBe(409);
    await ok("prachi", "POST", `/api/leads/${l2.id}/lost`, { reason: "dates" });
    const won = await ok("prachi", "POST", `/api/leads/${leadId}/won`);
    bookingId = won.booking.id;
    expect(won.booking.status).toBe("approved");          // on tariff → auto-approved (F3)
    expect(won.booking.approval.mode).toBe("auto_on_tariff");
    const booked = await sql("SELECT kind, booking_id FROM room_nights WHERE booking_id = ?", bookingId);
    expect(booked).toHaveLength(4);
    expect(booked.every((n: any) => n.kind === "booked")).toBe(true);
    const funnel = await ok("prachi", "GET", "/api/leads/funnel");
    expect(funnel.funnel.find((f: any) => f.source === "instagram").won).toBe(1);
  });

  it("W2 · an off-tariff manual booking waits for the revenue desk; sales can only touch their own unapproved entry", async () => {
    const r = await ok("prachi", "POST", "/api/bookings", { guest_name: "Discount Guest", guest_phone: "9111111111", check_in: "2026-11-10", check_out: "2026-11-11", rooms: [{ room_id: "loc_r1", nightly_rate_paise: 500000 }] });
    expect(r.booking.status).toBe("provisional");
    expect(r.booking.approval.reasons).toContain("rate_below");
    expect((await api("sindhu", "POST", `/api/bookings/${r.booking.id}/check-in`)).status).toBe(409);
    const pending = await ok("trupti", "GET", "/api/approvals");
    const ap = pending.approvals.find((a: any) => a.ref_id === r.booking.id);
    expect(ap).toBeTruthy();
    await ok("trupti", "POST", `/api/approvals/${ap.id}/approve`, { note: "repeat guest" });
    expect((await ok("prachi", "GET", `/api/bookings/${r.booking.id}`)).booking.status).toBe("approved");
    expect((await api("prachi", "DELETE", `/api/bookings/${r.booking.id}`)).status).toBe(403); // approved → read-only to sales
    await ok("prachi", "POST", `/api/bookings/${r.booking.id}/cancel`, { reason: "guest changed plans" });
    expect(await sql("SELECT * FROM room_nights WHERE booking_id = ?", r.booking.id)).toHaveLength(0);
  });

  it("role walls are enforced at the API, not just the menu", async () => {
    expect((await api("prachi", "GET", "/api/reports/pnl")).status).toBe(403);
    expect((await api("sindhu", "GET", "/api/reports/revenue")).status).toBe(403);
    expect((await api("trupti", "GET", "/api/reports/pnl")).status).toBe(403);
    expect((await api("trupti", "GET", "/api/expenses?scope=bank")).status).toBe(403);
    expect((await api("sindhu", "POST", "/api/expenses", { category: "utilities", amount_paise: 476500, account_id: "acc_bank" })).status).toBe(403);
    expect((await api("prachi", "GET", "/api/approvals")).status).toBe(403);
    expect((await api("shaji", "GET", "/api/reports/pnl")).status).toBe(200);
    expect((await api("ca", "GET", "/api/reports/pnl")).status).toBe(200);
  });

  it("W1 · the inbox turns a STAAH email into an OTA booking and flags the duplicate", async () => {
    const email = { from: "noreply@staah.com", subject: "STAAH · New reservation · Booking.com", text: "Channel: Booking.com\nRef: 1060900000001336\nGuest: Astha Sharma\nRoom: Deluxe ×1\nCheck-in: 03/10/2026\nCheck-out: 04/10/2026\nRoom Total: ₹6,000.00 (ex-GST)\nCommission: 23%\nChannel Collect" };
    // This stay is already in the past, so automation leaves it for a person (test/inbox.test.ts covers the automatic path).
    const ing = await ok("prachi", "POST", "/api/inbox/ingest", email);
    expect(ing.status).toBe("pending");
    expect(ing.auto.note).toMatch(/in the past/);
    expect(ing.parsed.data.guest_name).toBe("Astha Sharma");
    expect(ing.parsed.data.check_out).toBe("2026-10-04");
    const appr = await ok("prachi", "POST", `/api/inbox/${ing.id}/approve`, { room_ids: ["loc_r1"] });
    otaBookingId = appr.booking.id;
    expect(appr.booking.status).toBe("approved");
    expect(appr.booking.roomTotalPaise).toBe(600000);
    const again = await ok("prachi", "POST", "/api/inbox/ingest", email);
    expect(again.status).toBe("duplicate");
    // Airpay payment emails route to the Payments screen, not the booking inbox.
    const pay = await ok("prachi", "POST", "/api/inbox/ingest", { from: "alerts@airpay.co.in", subject: "Airpay · transaction successful", text: "Order: 10609000001012399437\nAmount: ₹63,000.00\nPayer: Rashmi Shah\nStatus: success" });
    expect(pay.status).toBe("routed");
  });

  it("front desk · check-in, advance + balance, check-out chains to collect and invoice; fee booked once", async () => {
    // An advance before arrival (idempotent on retry).
    const adv = await ok("sindhu", "POST", "/api/payments", { booking_id: bookingId, method: "upi", amount_paise: 1000000, reference: "UTR7738", idempotency_key: "adv-1" });
    const retry = await ok("sindhu", "POST", "/api/payments", { booking_id: bookingId, method: "upi", amount_paise: 1000000, reference: "UTR7738", idempotency_key: "adv-1" });
    expect(retry.duplicate).toBe(true);
    expect(adv.kind).toBe("advance");
    expect(adv.balance_paise).toBe(2000000);
    await ok("sindhu", "POST", `/api/bookings/${bookingId}/check-in`);
    const out = await ok("sindhu", "POST", `/api/bookings/${bookingId}/check-out`);
    expect(out.balance_due_paise).toBe(2000000);
    expect(out.next).toBe("collect");
    expect(out.housekeeping_tasks).toHaveLength(2);
    const card = await ok("sindhu", "POST", "/api/payments", { booking_id: bookingId, method: "card", amount_paise: 2000000, reference: "POS1234" });
    expect(card.fee_expense_id).toBeTruthy();
    const fees = await sql("SELECT amount_paise, kind FROM expenses WHERE payment_id = ?", card.id);
    expect(fees).toEqual([{ amount_paise: 40000, kind: "gateway_fee" }]); // 2% once
    const inv = await ok("sindhu", "POST", `/api/invoices/bookings/${bookingId}`);
    invoiceId = inv.id;
    expect(inv.number).toBe("MV/26-27/001");
    expect(inv.gst_applicable).toBe(false);
    expect(inv.balance_paise).toBe(0);
    const dup = await ok("sindhu", "POST", `/api/invoices/bookings/${bookingId}`);
    expect(dup.duplicate).toBe(true);
    const html = await api("sindhu", "GET", `/api/invoices/${invoiceId}/html`);
    expect(html.json.raw).toContain("MV/26-27/001");
    // Voiding the card payment voids its fee in the same batch.
    await ok("sindhu", "POST", `/api/payments/${card.id}/void`, { reason: "wrong card" });
    expect((await sql("SELECT voided_at FROM expenses WHERE id = ?", card.fee_expense_id))[0].voided_at).toBeTruthy();
    await ok("sindhu", "POST", "/api/payments", { booking_id: bookingId, method: "cash", amount_paise: 2000000 });
    // OTA guest: check-in/out collects nothing (channel collect).
    await ok("sindhu", "POST", `/api/bookings/${otaBookingId}/check-in`);
    const otaOut = await ok("sindhu", "POST", `/api/bookings/${otaBookingId}/check-out`);
    expect(otaOut.balance_due_paise).toBe(0);
    expect(otaOut.next).toBe("done");
  });

  it("W8/W5 · task done attaches the bill and posts petty cash; cash ledger and transfers (F6)", async () => {
    const t = await ok("sindhu", "POST", "/api/tasks", { kind: "maintenance", location_id: "loc_r2", title: "Leaking tap behind the vanity", priority: "high", idempotency_key: "t1" });
    await ok("sindhu", "POST", `/api/tasks/${t.id}/status`, { status: "in_progress" });
    const done = await ok("sindhu", "POST", `/api/tasks/${t.id}/status`, { status: "done", expense: { amount_paise: 120000, category: "repairs", vendor_name: "Varkala Plumbing", vendor_gstin: "32AAACX1234A1Z5", gst_rate_bp: 1800 } });
    expect(done.expense_id).toBeTruthy();
    expect((await api("sindhu", "POST", "/api/expenses", { category: "misc", amount_paise: 100, vendor_gstin: "32AAACx…" })).status).toBe(400); // GSTIN format-validated
    await ok("shaji", "POST", "/api/expenses", { category: "utilities", amount_paise: 476500, account_id: "acc_bank", vendor_name: "KSEB", reference: "NEFT8841" });
    // Deposit desk cash to bank, top up petty cash: transfers, never expenses.
    await ok("shaji", "POST", "/api/payments/transfers", { from_account_id: "acc_cash", to_account_id: "acc_bank", amount_paise: 1750000, reference: "CASH DEP" });
    await ok("shaji", "POST", "/api/payments/transfers", { from_account_id: "acc_bank", to_account_id: "acc_petty", amount_paise: 300000 });
    const bal = await ok("sindhu", "GET", "/api/payments/accounts");
    const petty = bal.accounts.find((a: any) => a.id === "acc_petty");
    expect(petty.balance_paise).toBe(300000 - 120000);
    const cash = bal.accounts.find((a: any) => a.id === "acc_cash");
    expect(cash.balance_paise).toBe(2000000 - 1750000);
    const exp = await ok("shaji", "GET", "/api/expenses?scope=all&period=" + new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7));
    expect(exp.expenses.find((e: any) => e.kind === "normal" && e.amount_paise === 300000)).toBeUndefined(); // top-up is not an expense
    // The petty cash book: each month opens with what the previous month closed at — the float is never reset.
    const period = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
    const [y, m] = period.split("-").map(Number); const next = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}`;
    const book = await ok("sindhu", "GET", `/api/expenses/petty-statement?period=${period}`);
    expect(book.opening_paise).toBe(0);
    expect(book.topups_paise).toBe(300000);
    expect(book.spent_paise).toBe(120000);
    expect(book.closing_paise).toBe(180000);
    const after = await ok("shaji", "GET", `/api/expenses/petty-statement?period=${next}`);
    expect(after.opening_paise).toBe(180000);
    expect(after.closing_paise).toBe(180000);
    expect((await api("prachi", "GET", `/api/expenses/petty-statement?period=${period}`)).status).toBe(403);
  });

  it("W4 · OTA payout settles to the paisa, posts commission/fee once, undo removes everything", async () => {
    const un = await ok("trupti", "GET", "/api/settlements/unsettled?channel=booking_com");
    expect(un.stays.map((s: any) => s.id)).toContain(otaBookingId);
    const prev = await ok("trupti", "POST", "/api/settlements", { channel_code: "booking_com", booking_ids: [otaBookingId], preview: true });
    // ₹6,000 ex-GST, no GST (unregistered): commission 23% = 1,380; fee 1.99% of 6,000 = 119.40 → net 4,500.60
    expect(prev.preview.commissionPaise).toBe(138000);
    expect(prev.preview.paymentFeePaise).toBe(11940);
    expect(prev.preview.expectedPaise).toBe(450060);
    const s = await ok("trupti", "POST", "/api/settlements", { channel_code: "booking_com", booking_ids: [otaBookingId], payout_ref: "010649992418", payout_on: "2026-10-12" });
    settlementId = s.id;
    await ok("trupti", "POST", `/api/settlements/${settlementId}/settle`, { received_paise: 450060 });
    const exps = await sql("SELECT kind, amount_paise FROM expenses WHERE settlement_id = ? AND voided_at IS NULL ORDER BY kind", settlementId);
    expect(exps).toEqual([{ kind: "ota_commission", amount_paise: 138000 }, { kind: "ota_payment_fee", amount_paise: 11940 }]);
    expect((await api("trupti", "POST", "/api/settlements", { channel_code: "booking_com", booking_ids: [otaBookingId], payout_ref: "dup" })).status).toBe(409);
    await ok("trupti", "POST", `/api/settlements/${settlementId}/undo`, { reason: "test undo" });
    expect(await sql("SELECT id FROM expenses WHERE settlement_id = ? AND voided_at IS NULL", settlementId)).toHaveLength(0);
    const s2 = await ok("trupti", "POST", "/api/settlements", { channel_code: "booking_com", booking_ids: [otaBookingId], payout_ref: "010649992418-2", payout_on: "2026-10-12" });
    settlementId = s2.id;
    await ok("trupti", "POST", `/api/settlements/${settlementId}/settle`, { received_paise: 450060 });
  });

  it("W7 · Smart Reconcile proposes in tiers, writes only on accept, and hides debits from the revenue desk", async () => {
    const istToday = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10).split("-").reverse().join("/");
    const paste = await ok("trupti", "POST", "/api/recon/paste", { account_id: "acc_bank", text: [
      "12/10/2026\tNEFT BOOKING.COM 010649992418\t\t4500.60",
      `${istToday}\tUPI CR UTR7738 MEERA\t\t10000.00`,
      `${istToday}\tCASH DEP VARKALA BR\t\t17500.00`,
      `${istToday}\tKSEB NEFT8841\t4765.00\t`,
      "18/10/2026\tUNKNOWN CREDIT\t\t999.00",
    ].join("\n") });
    expect(paste.inserted).toBe(5);
    const forTrupti = await ok("trupti", "GET", "/api/recon");
    expect(forTrupti.lines.every((l: any) => l.amount_paise > 0)).toBe(true); // F7
    const forShaji = await ok("shaji", "GET", "/api/recon");
    expect(forShaji.lines).toHaveLength(5);
    const byDesc = (s: string) => forShaji.lines.find((l: any) => l.description.includes(s));
    expect(byDesc("BOOKING.COM").tier).toBe(1);
    expect(byDesc("UTR7738").tier).toBe(1);
    expect(byDesc("CASH DEP").tier).toBe(2);
    expect(byDesc("KSEB").tier).toBe(1);
    expect(byDesc("UNKNOWN").status).toBe("unmatched");
    expect(forShaji.stats.auto_rate).toBe(80);
    expect((await api("trupti", "POST", "/api/recon/accept", { line_ids: [byDesc("KSEB").id] })).status).toBe(403);
    await ok("shaji", "POST", "/api/recon/accept", { line_ids: forShaji.lines.filter((l: any) => l.status === "proposed").map((l: any) => l.id) });
    await ok("shaji", "POST", `/api/recon/${byDesc("UNKNOWN").id}/carry`, { reason: "ask bank" });
    expect((await sql("SELECT status FROM payments WHERE reference = 'UTR7738'"))[0].status).toBe("matched");
  });

  it("W9/W10 · pre-close → lock → GST sheet → filed; the lock binds every role including the owner", async () => {
    const period = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
    const pre = await ok("trupti", "GET", `/api/reports/preclose?period=${period}`);
    expect(pre.stays_not_checked_out).toHaveLength(0);
    // The September-dated OTA settlement is in a different month; this month's exceptions can be acknowledged.
    const first = await api("trupti", "POST", `/api/close/${period}/preclear`);
    if (first.status === 409) await ok("trupti", "POST", `/api/close/${period}/preclear`, { acknowledge: true, note: "carry" });
    expect((await api("trupti", "POST", `/api/close/${period}/lock`)).status).toBe(403); // CA locks, not Trupti
    const lock = await ok("ca", "POST", `/api/close/${period}/lock`);
    expect(lock.version).toBe(1);
    expect(lock.keys.bookings).toContain("packs/prop_meadows/");
    // Locked month refuses writes dated inside it, even from the owner.
    expect((await api("shaji", "POST", "/api/expenses", { category: "misc", amount_paise: 100, account_id: "acc_bank", on_date: `${period}-15` })).status).toBe(423);
    const gst = await ok("ca", "GET", `/api/close/${period}/gst`);
    expect(gst.output_gst_paise).toBe(0); // unregistered: nothing to file yet
    await ok("ca", "POST", `/api/close/${period}/file`);
    const un = await ok("ca", "POST", `/api/close/${period}/unlock`, { reason: "late bill" });
    expect(un.warning).toBe("period was filed");
    await ok("trupti", "POST", `/api/close/${period}/preclear`, { acknowledge: true, note: "relock" });
    const relock = await ok("ca", "POST", `/api/close/${period}/lock`);
    expect(relock.version).toBe(2);
    const packs = await ok("ca", "GET", `/api/close/${period}`);
    expect(packs.packs.map((p: any) => p.revised)).toEqual([0, 1]);
    const owner = await ok("shaji", "GET", `/api/reports/owner?period=${period}`);
    expect(owner.month.status).toBe("locked");
  });

  it("GST registration flips the invoice: slab per room-night, threshold inclusive", async () => {
    await ok("shaji", "PATCH", "/api/admin/property", { gstin: "32AAACX1234A1Z5" });
    const b = await ok("prachi", "POST", "/api/bookings", { guest_name: "Peak Guest", guest_phone: "9222222222", check_in: "2026-12-27", check_out: "2026-12-28", rooms: [{ room_id: "loc_r2", nightly_rate_paise: 750000 }, { room_id: "loc_r1", nightly_rate_paise: 790000 }] });
    // Premium at exactly ₹7,500 → 5%; Deluxe sold above its ₹7,000 peak tariff → above-tariff (manual approval) and slab decided by the declared tariff (5%).
    const lines = b.booking.lines;
    expect(lines.find((l: any) => l.roomId === "loc_r2").gstRateBp).toBe(500);
    expect(lines.find((l: any) => l.roomId === "loc_r1").rateVsTariff).toBe("above");
    expect(b.booking.status).toBe("provisional");
    const rev = await ok("trupti", "GET", "/api/reports/revenue?period=2026-12");
    expect(rev.period).toBe("2026-12");
  });
});
