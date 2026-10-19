/** Date helpers. Workers run in UTC; the books live in the property's timezone (Asia/Kolkata). */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDate(s: string, label = "date"): string {
  if (!ISO_DATE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new Error(`Invalid ${label}: ${s}`);
  return s;
}

/** Today's date (YYYY-MM-DD) in a timezone. */
export function todayIn(tz: string, now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(now); // en-CA yields YYYY-MM-DD
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addHours(isoDateTime: string, hours: number): string {
  return new Date(new Date(isoDateTime).getTime() + hours * 3_600_000).toISOString();
}

/** Number of nights between check-in and check-out. */
export function nightsBetween(checkIn: string, checkOut: string): number {
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  const n = Math.round((b - a) / 86_400_000);
  if (n < 1) throw new Error("check_out must be after check_in");
  return n;
}

/** Each night of a stay: check-in date through the day before check-out. */
export function nightsOf(checkIn: string, checkOut: string): string[] {
  const n = nightsBetween(checkIn, checkOut);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(addDays(checkIn, i));
  return out;
}

/** Indian financial year code for a date: 2026-09-14 → "26-27"; 2027-02-01 → "26-27". */
export function fyOf(iso: string, fyStartMonth = 4): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const startYear = m >= fyStartMonth ? y : y - 1;
  const a = String(startYear).slice(-2);
  const b = String(startYear + 1).slice(-2);
  return `${a}-${b}`;
}

/** Accounting period of a date: YYYY-MM. */
export function periodOf(iso: string): string {
  return iso.slice(0, 7);
}

export function periodRange(period: string): { from: string; to: string } {
  const [y, m] = period.split("-").map(Number);
  const from = `${period}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from, to: `${period}-${String(last).padStart(2, "0")}` };
}

export function previousPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

/** Parse "14 Oct", "14/10/2026", "2026-10-14", "03→04 Oct" fragments found in emails and pasted statements. */
const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
export function parseLooseDate(s: string, defaultYear: number): string | null {
  const t = s.trim().toLowerCase();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = t.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/))) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  if ((m = t.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2})$/))) return `20${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  if ((m = t.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s*(\d{4})?$/))) {
    const mi = MONTHS.indexOf(m[2]);
    if (mi < 0) return null;
    const y = m[3] ? Number(m[3]) : defaultYear;
    return `${y}-${String(mi + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  if ((m = t.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s*(\d{4})?$/))) {
    const mi = MONTHS.indexOf(m[1]);
    if (mi < 0) return null;
    const y = m[3] ? Number(m[3]) : defaultYear;
    return `${y}-${String(mi + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}
