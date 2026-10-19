import type { Paise } from "./money";

export interface RateCardRow {
  room_id: string;
  rate_paise: Paise;
  from_date: string | null;
  to_date: string | null;
  priority: number;
}

/** The tariff for a room on a night: highest-priority card whose window covers the night. */
export function tariffFor(cards: RateCardRow[], roomId: string, night: string): Paise | null {
  let best: RateCardRow | null = null;
  for (const c of cards) {
    if (c.room_id !== roomId) continue;
    if (c.from_date && night < c.from_date) continue;
    if (c.to_date && night > c.to_date) continue;
    if (!best || c.priority > best.priority) best = c;
  }
  return best ? best.rate_paise : null;
}

export type RateVsTariff = "on" | "below" | "above" | "no_tariff";

/** Compare a sold nightly rate with the card. Within ₹1 counts as on-tariff (rounding). */
export function compareToTariff(soldPaise: Paise, tariffPaise: Paise | null): RateVsTariff {
  if (tariffPaise === null) return "no_tariff";
  const diff = soldPaise - tariffPaise;
  if (Math.abs(diff) <= 100) return "on";
  return diff < 0 ? "below" : "above";
}

export interface ApprovalPolicy {
  autoApproveOnTariff: boolean;
  autoApproveMaxRooms: number;
}

/**
 * Approval by exception (F3): a direct booking is auto-approved when every room is on tariff
 * and the booking is within the configured size. Everything else goes to the revenue desk.
 */
export function decideApproval(
  policy: ApprovalPolicy,
  lines: { rateVsTariff: RateVsTariff }[],
  opts: { isOta: boolean },
): { mode: "auto_on_tariff" | "manual"; reasons: string[] } {
  if (opts.isOta) return { mode: "auto_on_tariff", reasons: ["ota_parsed"] };
  const reasons: string[] = [];
  if (!policy.autoApproveOnTariff) reasons.push("policy_manual");
  if (lines.length > policy.autoApproveMaxRooms) reasons.push("rooms_exceed_limit");
  for (const l of lines) {
    if (l.rateVsTariff !== "on") reasons.push(`rate_${l.rateVsTariff}`);
  }
  return reasons.length ? { mode: "manual", reasons: [...new Set(reasons)] } : { mode: "auto_on_tariff", reasons: [] };
}
