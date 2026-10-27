import { applyBp, type Paise } from "./money";

/** Everything the payout formula needs lives on the channel row (F5). */
export interface ChannelTerms {
  commission_bp: number;
  commission_base: "ex_gst" | "gross";
  /** GST the OTA adds on its commission (1800 = 18%); 0 when the commission already includes it. */
  commission_gst_bp?: number;
  payment_fee_bp: number;
  payment_fee_base: "ex_gst" | "gross";
  tcs_bp: number;
  tcs_base: "ex_gst" | "gross";
  tds_bp: number;
  tds_base: "ex_gst" | "gross";
}

export interface StayForSettlement {
  bookingId: string;
  roomTotalPaise: Paise; // ex-GST
  gstPaise: Paise;
}

export interface SettlementItem {
  bookingId: string;
  grossPaise: Paise;
  commissionPaise: Paise;
  commissionGstPaise: Paise;
  paymentFeePaise: Paise;
  tcsPaise: Paise;
  tdsPaise: Paise;
  netPaise: Paise;
}

export interface SettlementTotals {
  items: SettlementItem[];
  grossPaise: Paise;
  commissionPaise: Paise;
  commissionGstPaise: Paise;
  paymentFeePaise: Paise;
  tcsPaise: Paise;
  tdsPaise: Paise;
  expectedPaise: Paise;
}

function base(kind: "ex_gst" | "gross", s: StayForSettlement): Paise {
  return kind === "ex_gst" ? s.roomTotalPaise : s.roomTotalPaise + s.gstPaise;
}

/**
 * received = gross − commission − GST on commission − payment fee − TCS − TDS, computed per stay so each stay
 * carries its own share of every deduction, then summed. Per-stay rounding is deliberate:
 * it is what the OTA statements do, and it is what the acceptance test checks to the paisa.
 */
export function computeSettlement(terms: ChannelTerms, stays: StayForSettlement[]): SettlementTotals {
  const items = stays.map((s): SettlementItem => {
    const grossPaise = s.roomTotalPaise + s.gstPaise;
    const commissionPaise = applyBp(base(terms.commission_base, s), terms.commission_bp);
    const commissionGstPaise = applyBp(commissionPaise, terms.commission_gst_bp ?? 0);
    const paymentFeePaise = applyBp(base(terms.payment_fee_base, s), terms.payment_fee_bp);
    const tcsPaise = applyBp(base(terms.tcs_base, s), terms.tcs_bp);
    const tdsPaise = applyBp(base(terms.tds_base, s), terms.tds_bp);
    return { bookingId: s.bookingId, grossPaise, commissionPaise, commissionGstPaise, paymentFeePaise, tcsPaise, tdsPaise,
      netPaise: grossPaise - commissionPaise - commissionGstPaise - paymentFeePaise - tcsPaise - tdsPaise };
  });
  const t = (k: keyof SettlementItem) => items.reduce((a, i) => a + (i[k] as number), 0);
  return {
    items,
    grossPaise: t("grossPaise"),
    commissionPaise: t("commissionPaise"),
    commissionGstPaise: t("commissionGstPaise"),
    paymentFeePaise: t("paymentFeePaise"),
    tcsPaise: t("tcsPaise"),
    tdsPaise: t("tdsPaise"),
    expectedPaise: t("netPaise"),
  };
}
