import { rupeesToPaise, type Paise } from "./money";
import { parseLooseDate } from "./dates";

export interface StatementLine {
  on_date: string;
  description: string;
  amount_paise: Paise; // signed
  reference: string | null;
  line_hash: string;
}

/**
 * Parse a pasted bank statement. Accepts tab/comma/pipe separated rows of
 *   date, description, [debit], [credit] | date, description, amount[, Cr/Dr]
 * Lines that do not parse are returned in `rejected` with the reason.
 */
export function parseStatement(text: string, defaultYear: number): { lines: StatementLine[]; rejected: { line: string; reason: string }[] } {
  const lines: StatementLine[] = [];
  const rejected: { line: string; reason: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[ \r]+|[ \r]+$/g, "");
    if (!line.trim()) continue;
    // Separator is decided per line: tabs, then pipes, then commas (quote-aware). Never split a "61,513.00" on its own comma.
    const splitter = line.includes("\t") ? /\t/ : line.includes("|") ? /\s*\|\s*/ : /,(?=(?:[^"]*"[^"]*")*[^"]*$)/;
    const cells = line.split(splitter).map((c) => c.replace(/^"|"$/g, "").trim());
    if (cells.length < 3) { rejected.push({ line, reason: "needs date, description, amount" }); continue; }
    const date = parseLooseDate(cells[0], defaultYear);
    if (!date) { rejected.push({ line, reason: `unreadable date "${cells[0]}"` }); continue; }
    const description = cells[1];
    let amount: Paise | null = null;
    const nums = cells.slice(2).map((c) => c.replace(/[₹,\s]/g, ""));
    const crdr = cells.slice(2).find((c) => /^(cr|dr)\.?$/i.test(c));
    if (nums.length >= 2 && nums[0] !== "" && nums[1] !== "" && !crdr && /^-?\d/.test(nums[0]) && /^-?\d/.test(nums[1])) {
      // debit, credit columns
      const debit = Number(nums[0]) || 0;
      const credit = Number(nums[1]) || 0;
      amount = rupeesToPaise(credit) - rupeesToPaise(debit);
    } else {
      const first = nums.find((n) => /^-?\d/.test(n));
      if (first === undefined) { rejected.push({ line, reason: "no amount" }); continue; }
      amount = rupeesToPaise(first);
      if (crdr && /^dr/i.test(crdr) && amount > 0) amount = -amount;
      if (nums.length >= 2 && nums[0] !== "" && (nums[1] === "" || nums[1] === "0")) amount = -Math.abs(amount); // debit column only
    }
    // Long runs are UTRs / order ids; short runs are the UPI-style last digits the desk types in.
    const refMatch = description.match(/\b([A-Za-z]{0,6}\d{10,22})\b/) ?? description.match(/\b([A-Za-z]{0,6}\d{4,9})\b/) ?? description.match(/[·•]{2,}\s*(\d{3,6})\b/);
    const reference = refMatch ? refMatch[1] : null;
    lines.push({ on_date: date, description, amount_paise: amount, reference, line_hash: hashLine(date, description, amount) });
  }
  return { lines, rejected };
}

export function hashLine(date: string, description: string, amount: Paise): string {
  const s = `${date}|${description.toLowerCase().replace(/\s+/g, " ")}|${amount}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface Candidate {
  kind: "payment" | "transfer" | "settlement" | "expense";
  id: string;
  amount_paise: Paise;     // signed, same convention as statement lines
  reference: string | null;
  on_date: string;
  label: string;
  /** settlements: the net amount already includes the fee; stays for the OTA-subset tier */
  stays?: { bookingId: string; netPaise: Paise }[];
  /** payments through a gateway: the contracted fee bp so tier 3 can show implied vs contracted */
  gateway_fee_bp?: number;
}

export interface MatchProposal {
  tier: 1 | 2 | 3 | 4;
  kind: Candidate["kind"];
  id: string;
  label: string;
  detail: Record<string, unknown>;
}

const digits = (s: string | null) => (s ?? "").replace(/\D/g, "");

/**
 * Four tiers, in order: UTR/reference → exact amount → fee-tolerant (gateway) → OTA subset.
 * Nothing here writes; the caller stores proposals and only accepting them settles anything.
 */
export function proposeMatch(
  line: StatementLine,
  candidates: Candidate[],
  tol: { feeBp: number; subsetBp: number },
): MatchProposal | null {
  const sameSign = candidates.filter((c) => Math.sign(c.amount_paise) === Math.sign(line.amount_paise));

  // Tier 1: a reference on the statement line appears in a candidate's reference (or vice versa).
  const ld = digits(line.reference) || digits(line.description.match(/(\d{6,})/)?.[1] ?? null);
  if (ld.length >= 4) {
    for (const c of sameSign) {
      const cd = digits(c.reference);
      if (cd.length >= 4 && (cd.includes(ld) || ld.includes(cd) || cd.endsWith(ld.slice(-4)) && ld.length <= 6)) {
        if (Math.abs(c.amount_paise - line.amount_paise) <= Math.abs(Math.round(line.amount_paise * 0.05)))
          return { tier: 1, kind: c.kind, id: c.id, label: c.label, detail: { reference: c.reference } };
      }
    }
  }
  // Tier 2: exact amount, closest date.
  const exact = sameSign.filter((c) => c.amount_paise === line.amount_paise).sort((a, b) => dateDist(a.on_date, line.on_date) - dateDist(b.on_date, line.on_date));
  if (exact.length) return { tier: 2, kind: exact[0].kind, id: exact[0].id, label: exact[0].label, detail: {} };

  // Tier 3: fee-tolerant — a gateway payment whose amount less a fee of up to tol.feeBp equals the credit.
  if (line.amount_paise > 0) {
    let best: { c: Candidate; impliedBp: number } | null = null;
    for (const c of sameSign) {
      if (c.kind !== "payment" || c.gateway_fee_bp === undefined) continue;
      const fee = c.amount_paise - line.amount_paise;
      if (fee < 0) continue;
      const impliedBp = Math.round((fee * 10_000) / c.amount_paise);
      if (impliedBp <= tol.feeBp && (!best || impliedBp < best.impliedBp)) best = { c, impliedBp };
    }
    if (best) {
      const contractedFee = Math.round((best.c.amount_paise * (best.c.gateway_fee_bp ?? 0)) / 10_000);
      return { tier: 3, kind: "payment", id: best.c.id, label: best.c.label,
        detail: { implied_fee_bp: best.impliedBp, implied_fee_paise: best.c.amount_paise - line.amount_paise,
          contracted_fee_paise: contractedFee, variance_paise: (best.c.amount_paise - line.amount_paise) - contractedFee } };
    }
  }
  // Tier 4: OTA subset — a settlement whose expected net is within tol.subsetBp of the credit,
  // or a subset of its stays that sums within tolerance.
  if (line.amount_paise > 0) {
    for (const c of sameSign) {
      if (c.kind !== "settlement") continue;
      const within = (v: Paise) => Math.abs(v - line.amount_paise) * 10_000 <= line.amount_paise * tol.subsetBp;
      if (within(c.amount_paise)) return { tier: 4, kind: "settlement", id: c.id, label: c.label, detail: { stays: c.stays?.map((s) => s.bookingId) ?? [], variance_paise: line.amount_paise - c.amount_paise } };
      if (c.stays && c.stays.length <= 12) {
        const subset = findSubset(c.stays, line.amount_paise, tol.subsetBp);
        if (subset) return { tier: 4, kind: "settlement", id: c.id, label: c.label, detail: { stays: subset.map((s) => s.bookingId), partial: true, variance_paise: line.amount_paise - subset.reduce((a, s) => a + s.netPaise, 0) } };
      }
    }
  }
  return null;
}

function dateDist(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b));
}

function findSubset(stays: { bookingId: string; netPaise: Paise }[], target: Paise, tolBp: number) {
  const n = stays.length;
  let best: typeof stays | null = null;
  for (let mask = 1; mask < 1 << n; mask++) {
    let s = 0;
    const picked: typeof stays = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { s += stays[i].netPaise; picked.push(stays[i]); }
    if (Math.abs(s - target) * 10_000 <= target * tolBp && (!best || picked.length > best.length)) best = picked;
  }
  return best;
}
