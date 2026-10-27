import { describe, it, expect } from "vitest";
import { formatINR, splitInclusive, applyBp, rupeesToPaise } from "../src/domain/money";
import { fyOf, nightsOf, periodRange, parseLooseDate, todayIn } from "../src/domain/dates";
import { computeRoomLine, slabBpForRoomNight, gstinFormatValid, type GstPolicy } from "../src/domain/gst";
import { tariffFor, compareToTariff, decideApproval } from "../src/domain/tariff";
import { computeSettlement } from "../src/domain/settlement";
import { parseStatement, proposeMatch } from "../src/domain/recon";

describe("money", () => {
  it("formats Indian grouping", () => {
    expect(formatINR(19510556)).toBe("₹ 1,95,105.56");
    expect(formatINR(3150000)).toBe("₹ 31,500.00");
    expect(formatINR(46000)).toBe("₹ 460.00");
    expect(formatINR(-80631)).toBe("−₹ 806.31");
  });
  it("splits inclusive amounts", () => {
    expect(splitInclusive(120000, 1800)).toEqual({ ex: 101695, gst: 18305 });
    expect(splitInclusive(630000, 500)).toEqual({ ex: 600000, gst: 30000 });
  });
  it("rounds half away from zero", () => {
    expect(applyBp(858850, 500)).toBe(42943); // 4294.25 → 4294.3? no: 8588.50*5% = 429.425 → 429.43
    expect(rupeesToPaise("₹ 1,95,105.56")).toBe(19510556);
  });
});

describe("dates", () => {
  it("financial year", () => {
    expect(fyOf("2026-09-14")).toBe("26-27");
    expect(fyOf("2027-03-31")).toBe("26-27");
    expect(fyOf("2027-04-01")).toBe("27-28");
  });
  it("nights", () => {
    expect(nightsOf("2026-12-24", "2026-12-26")).toEqual(["2026-12-24", "2026-12-25"]);
    expect(periodRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });
  it("loose dates", () => {
    expect(parseLooseDate("14 Oct", 2026)).toBe("2026-10-14");
    expect(parseLooseDate("14/10/2026", 2026)).toBe("2026-10-14");
    expect(parseLooseDate("Oct 3, 2026", 2026)).toBe("2026-10-03");
  });
  it("today in IST", () => {
    expect(todayIn("Asia/Kolkata", new Date("2026-10-14T19:30:00Z"))).toBe("2026-10-15");
  });
});

describe("gst", () => {
  const registered: GstPolicy = { gstin: "32AAACX1234A1Z5", nilUptoPaise: 100000, thresholdPaise: 750000, belowBp: 500, aboveBp: 1800 };
  const unregistered: GstPolicy = { ...registered, gstin: null };
  it("slab is per room-night, threshold inclusive", () => {
    expect(slabBpForRoomNight(registered, 750000)).toBe(500);
    expect(slabBpForRoomNight(registered, 750001)).toBe(1800);
    expect(slabBpForRoomNight(registered, 600000)).toBe(500);
  });
  it("up to ₹1,000 per room-night is nil-rated", () => {
    expect(slabBpForRoomNight(registered, 100000)).toBe(0);
    expect(slabBpForRoomNight(registered, 100001)).toBe(500);
    const l = computeRoomLine(registered, { roomId: "r", nights: 3, nightlyRatePaise: 90000 });
    expect(l.gstPaise).toBe(0);
    expect(l.grossPaise).toBe(270000);
  });
  it("no GST without a GSTIN", () => {
    expect(slabBpForRoomNight(unregistered, 600000)).toBe(0);
    const l = computeRoomLine(unregistered, { roomId: "r", nights: 2, nightlyRatePaise: 750000 });
    expect(l.gstPaise).toBe(0);
    expect(l.grossPaise).toBe(1500000);
  });
  it("slab follows the price charged per night, not the rate card", () => {
    // Discounted below ₹7,500 from an ₹8,000 card: 5% on what was charged.
    const down = computeRoomLine(registered, { roomId: "r", nights: 1, nightlyRatePaise: 700000, declaredTariffPaise: 800000 });
    expect(down.gstRateBp).toBe(500);
    expect(down.gstPaise).toBe(35000);
    // Sold above ₹7,500 from a ₹7,000 card (peak, OTA price): 18%.
    const up = computeRoomLine(registered, { roomId: "r", nights: 1, nightlyRatePaise: 800000, declaredTariffPaise: 700000 });
    expect(up.gstRateBp).toBe(1800);
    expect(up.gstPaise).toBe(144000);
  });
  it("peak uplift above ₹7,500 flips the slab", () => {
    expect(computeRoomLine(registered, { roomId: "r", nights: 1, nightlyRatePaise: 790000 }).gstRateBp).toBe(1800);
  });
  it("gstin format", () => {
    expect(gstinFormatValid("32AAACX1234A1Z5")).toBe(true);
    expect(gstinFormatValid("32AAACx…")).toBe(false);
  });
});

describe("tariff and approval", () => {
  const cards = [
    { room_id: "r2", rate_paise: 650000, from_date: null, to_date: null, priority: 0 },
    { room_id: "r2", rate_paise: 750000, from_date: "2026-12-20", to_date: "2027-01-05", priority: 10 },
  ];
  it("peak card wins inside its window", () => {
    expect(tariffFor(cards, "r2", "2026-12-24")).toBe(750000);
    expect(tariffFor(cards, "r2", "2026-11-01")).toBe(650000);
    expect(tariffFor(cards, "r9", "2026-11-01")).toBeNull();
  });
  it("compares sold rate to tariff", () => {
    expect(compareToTariff(750000, 750000)).toBe("on");
    expect(compareToTariff(700000, 750000)).toBe("below");
    expect(compareToTariff(800000, 750000)).toBe("above");
  });
  it("auto-approves on tariff, routes exceptions to the revenue desk", () => {
    const p = { autoApproveOnTariff: true, autoApproveMaxRooms: 4 };
    expect(decideApproval(p, [{ rateVsTariff: "on" }, { rateVsTariff: "on" }], { isOta: false }).mode).toBe("auto_on_tariff");
    const d = decideApproval(p, [{ rateVsTariff: "on" }, { rateVsTariff: "below" }], { isOta: false });
    expect(d.mode).toBe("manual");
    expect(d.reasons).toEqual(["rate_below"]);
    expect(decideApproval({ ...p, autoApproveOnTariff: false }, [{ rateVsTariff: "on" }], { isOta: false }).mode).toBe("manual");
  });
});

describe("settlement — the acceptance test", () => {
  const bookingCom = {
    commission_bp: 2300, commission_base: "ex_gst" as const,
    payment_fee_bp: 199, payment_fee_base: "gross" as const,
    tcs_bp: 0, tcs_base: "ex_gst" as const, tds_bp: 0, tds_base: "gross" as const,
  };
  it("payout 010649992418 computes ₹30,836.26 to the paisa with the fee split per stay", () => {
    const stays = [
      { bookingId: "a", roomTotalPaise: 1200000, gstPaise: 60000 },
      { bookingId: "b", roomTotalPaise: 950000, gstPaise: 47500 },
      { bookingId: "c", roomTotalPaise: 858850, gstPaise: 42943 },
      { bookingId: "d", roomTotalPaise: 850000, gstPaise: 42500 },
    ];
    const s = computeSettlement(bookingCom, stays);
    expect(s.grossPaise).toBe(4051793);
    expect(s.commissionPaise).toBe(887536);
    expect(s.paymentFeePaise).toBe(80631);
    expect(s.expectedPaise).toBe(3083626);
    expect(s.items.map((i) => i.paymentFeePaise)).toEqual([25074, 19850, 17946, 17761]);
  });
  it("TCS and TDS reduce the expected payout and are tracked per stay", () => {
    const terms = { ...bookingCom, tcs_bp: 50, tds_bp: 10 };
    const s = computeSettlement(terms, [{ bookingId: "a", roomTotalPaise: 1000000, gstPaise: 50000 }]);
    expect(s.tcsPaise).toBe(5000);  // 0.5% of ex-GST
    expect(s.tdsPaise).toBe(1050);  // 0.1% of gross
    expect(s.expectedPaise).toBe(1050000 - 230000 - 20895 - 5000 - 1050);
  });
});

describe("GST on OTA commission", () => {
  it("comes off the payout on top of the commission, per stay", () => {
    const terms = { commission_bp: 2300, commission_base: "ex_gst" as const, commission_gst_bp: 1800, payment_fee_bp: 0, payment_fee_base: "gross" as const, tcs_bp: 0, tcs_base: "ex_gst" as const, tds_bp: 0, tds_base: "gross" as const };
    const s = computeSettlement(terms, [{ bookingId: "a", roomTotalPaise: 1000000, gstPaise: 50000 }, { bookingId: "b", roomTotalPaise: 333333, gstPaise: 16667 }]);
    expect(s.items.map((i) => i.commissionGstPaise)).toEqual([41400, 13800]); // 18% of 2,300.00 and of 766.67
    expect(s.commissionGstPaise).toBe(55200);
    expect(s.expectedPaise).toBe(1400000 - s.commissionPaise - 55200);
    // Without the setting nothing changes.
    expect(computeSettlement({ ...terms, commission_gst_bp: 0 }, [{ bookingId: "a", roomTotalPaise: 1000000, gstPaise: 50000 }]).commissionGstPaise).toBe(0);
  });
});

describe("reconcile", () => {
  it("parses a pasted statement in debit/credit and single-amount forms", () => {
    const text = [
      "14/10/2026\tNEFT BOOKING.COM 010649992418\t\t30836.26",
      "14 Oct\tAIRPAY SETTLEMENT 14 OCT\t\t61,513.00",
      "15/10/2026\tKSEB ELECTRICITY\t4765.00\t",
      "16/10/2026,UPI CR 7738 RAMESH,3075.00,Cr",
      "garbage line",
    ].join("\n");
    const { lines, rejected } = parseStatement(text, 2026);
    expect(lines.map((l) => l.amount_paise)).toEqual([3083626, 6151300, -476500, 307500]);
    expect(lines[0].reference).toBe("010649992418");
    expect(rejected).toHaveLength(1);
  });
  it("matches in tiers and never writes", () => {
    const tol = { feeBp: 300, subsetBp: 150 };
    const cands = [
      { kind: "settlement" as const, id: "s1", amount_paise: 3083626, reference: "010649992418", on_date: "2026-10-12", label: "B.com payout", stays: [{ bookingId: "a", netPaise: 1000000 }, { bookingId: "b", netPaise: 2083626 }] },
      { kind: "payment" as const, id: "p1", amount_paise: 6300000, reference: "10609000001012399437", on_date: "2026-10-14", label: "Airpay Rashmi", gateway_fee_bp: 200 },
      { kind: "payment" as const, id: "p2", amount_paise: 307500, reference: "7738", on_date: "2026-10-16", label: "UPI Sanjeev" },
      { kind: "transfer" as const, id: "t1", amount_paise: 1750000, reference: null, on_date: "2026-10-17", label: "Cash deposit" },
    ];
    const { lines } = parseStatement([
      "14/10/2026\tNEFT BOOKING.COM 010649992418\t\t30836.26",
      "14/10/2026\tAIRPAY SETTLEMENT\t\t61513.00",
      "16/10/2026\tUPI CR 7738 RAMESH\t\t3075.00",
      "17/10/2026\tCASH DEP VARKALA BR\t\t17500.00",
      "18/10/2026\tUNKNOWN CREDIT\t\t999.00",
    ].join("\n"), 2026);
    expect(proposeMatch(lines[0], cands, tol)?.tier).toBe(1);
    const t3 = proposeMatch(lines[1], cands, tol);
    expect(t3?.tier).toBe(3);
    expect(t3?.detail.implied_fee_bp).toBe(236);
    expect(t3?.detail.variance_paise).toBe(148700 - 126000);
    expect(proposeMatch(lines[2], cands, tol)?.tier).toBe(1);
    expect(proposeMatch(lines[3], cands, tol)?.tier).toBe(2);
    expect(proposeMatch(lines[4], cands, tol)).toBeNull();
  });
});
