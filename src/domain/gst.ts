import { applyBp, type Paise } from "./money";

export interface GstPolicy {
  /** NULL/empty GSTIN means the property may not charge GST at all (F2). */
  gstin: string | null;
  /** Declared tariff per room-night at or below which no GST is charged (nil band). */
  nilUptoPaise: Paise;
  /** Declared tariff per room-night at or below which the lower slab applies. */
  thresholdPaise: Paise;
  belowBp: number;   // 500  = 5% without input credit
  aboveBp: number;   // 1800 = 18% with input credit
}

export const DEFAULT_GST_POLICY: GstPolicy = { gstin: null, nilUptoPaise: 100_000, thresholdPaise: 750_000, belowBp: 500, aboveBp: 1800 };

export function gstApplicable(p: GstPolicy): boolean {
  return !!p.gstin && p.gstin.trim().length > 0;
}

/**
 * Slab for one room-night. The slab is decided by the declared tariff for that room-night
 * (ex-GST), not by what was collected. Bands are inclusive at the top:
 * up to ₹1,000 nil, up to ₹7,500 the lower slab (5%), above that the upper slab (18%).
 */
export function slabBpForRoomNight(p: GstPolicy, declaredTariffPaise: Paise): number {
  if (!gstApplicable(p)) return 0;
  if (declaredTariffPaise <= p.nilUptoPaise) return 0;
  return declaredTariffPaise <= p.thresholdPaise ? p.belowBp : p.aboveBp;
}

/** True when input tax credit may be claimed on purchases for this room-night's supply. */
export function itcAllowed(p: GstPolicy, declaredTariffPaise: Paise): boolean {
  return gstApplicable(p) && declaredTariffPaise > p.thresholdPaise;
}

export interface RoomLineInput {
  roomId: string;
  nights: number;
  nightlyRatePaise: Paise;        // ex-GST, as sold
  declaredTariffPaise?: Paise;    // rate-card rate; defaults to nightlyRatePaise
}
export interface RoomLine extends RoomLineInput {
  gstRateBp: number;
  roomTotalPaise: Paise;
  gstPaise: Paise;
  grossPaise: Paise;
}

export function computeRoomLine(p: GstPolicy, line: RoomLineInput): RoomLine {
  const declared = line.declaredTariffPaise ?? line.nightlyRatePaise;
  const gstRateBp = slabBpForRoomNight(p, declared);
  const roomTotalPaise = line.nightlyRatePaise * line.nights;
  const gstPaise = applyBp(roomTotalPaise, gstRateBp);
  return { ...line, declaredTariffPaise: declared, gstRateBp, roomTotalPaise, gstPaise, grossPaise: roomTotalPaise + gstPaise };
}

export function totals(lines: RoomLine[]) {
  const roomTotalPaise = lines.reduce((a, l) => a + l.roomTotalPaise, 0);
  const gstPaise = lines.reduce((a, l) => a + l.gstPaise, 0);
  return { roomTotalPaise, gstPaise, grossPaise: roomTotalPaise + gstPaise };
}

/** 15-character GSTIN format check: 2-digit state, PAN, entity code, Z, checksum char. */
export function gstinFormatValid(gstin: string): boolean {
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin.trim().toUpperCase());
}
