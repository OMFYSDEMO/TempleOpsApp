import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { seed, ok, sql } from "./helpers";
import { candidatesFor } from "../src/routes/recon";

/**
 * A short IDFC credit alert (no payer, no reference) must not be paired with an OTA payout settled weeks earlier.
 * Seen live: a ₹20,000 guest payment on 14 Nov was proposed as two stays of a Booking.com payout settled on 2 Oct.
 */
describe("Reconcile: which OTA payouts a bank credit may be matched to", () => {
  beforeAll(seed);
  const settlement = async (ref: string, payoutOn: string, guest: string, phone: string, settle: boolean, room: string) => {
    const b = await ok("prachi", "POST", "/api/bookings", { guest_name: guest, guest_phone: phone, channel_code: "booking_com", external_ref: `BK-${ref}`, check_in: "2026-09-14", check_out: "2026-09-16", rooms: [{ room_id: room, nightly_rate_paise: 1000000 }] });
    await sql("UPDATE bookings SET status = 'checked_out', checked_out_at = '2026-09-16T05:00:00Z' WHERE id = ?", b.booking.id);
    const s = await ok("trupti", "POST", "/api/settlements", { channel_code: "booking_com", booking_ids: [b.booking.id], payout_ref: ref, payout_on: payoutOn });
    if (settle) await ok("trupti", "POST", `/api/settlements/${s.id}/settle`, { account_id: "acc_bank" });
    return s.id as string;
  };
  const ids = (c: any[]) => c.filter((x) => x.kind === "settlement").map((x) => x.id);

  it("a payout settled six weeks before the credit is not offered; near its own date it still is", async () => {
    const old = await settlement("BCOM-OLD-1002", "2026-10-02", "Old Payout Guest", "9400000101", true, "loc_r2");
    // The alert window for a 14 Nov credit: the 1st of the month to three days after.
    expect(ids(await candidatesFor(env.DB, "prop_meadows", "acc_bank", "2026-11-01", "2026-11-17"))).not.toContain(old);
    // A statement covering early October still pairs it with its own credit.
    expect(ids(await candidatesFor(env.DB, "prop_meadows", "acc_bank", "2026-10-01", "2026-10-05"))).toContain(old);
    // A posting lag of a few days before the window is allowed.
    expect(ids(await candidatesFor(env.DB, "prop_meadows", "acc_bank", "2026-10-08", "2026-10-11"))).toContain(old);
  });

  it("a payout still waiting for its money stays a candidate however old it is", async () => {
    const waiting = await settlement("BCOM-WAIT-0920", "2026-09-20", "Waiting Payout Guest", "9400000102", false, "loc_r3");
    expect(ids(await candidatesFor(env.DB, "prop_meadows", "acc_bank", "2026-11-01", "2026-11-17"))).toContain(waiting);
  });
});
