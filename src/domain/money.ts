/** All money is integer paise. These helpers keep rounding in one place. */

export type Paise = number;

/** Round half away from zero to the nearest paisa (what Indian invoices expect). */
export function roundPaise(value: number): Paise {
  return value >= 0 ? Math.floor(value + 0.5) : -Math.floor(-value + 0.5);
}

/** Apply a basis-point rate (500 = 5.00%) to an amount. */
export function applyBp(amount: Paise, bp: number): Paise {
  return roundPaise((amount * bp) / 10_000);
}

/** Split an inclusive amount into (ex, gst) at a rate. gst = incl − incl/(1+r). */
export function splitInclusive(inclusive: Paise, bp: number): { ex: Paise; gst: Paise } {
  if (bp === 0) return { ex: inclusive, gst: 0 };
  const ex = roundPaise((inclusive * 10_000) / (10_000 + bp));
  return { ex, gst: inclusive - ex };
}

export function rupeesToPaise(rupees: number | string): Paise {
  const n = typeof rupees === "string" ? Number(rupees.replace(/[₹,\s]/g, "")) : rupees;
  if (!Number.isFinite(n)) throw new Error(`Bad rupee amount: ${rupees}`);
  return roundPaise(n * 100);
}

export function paiseToRupees(p: Paise): number {
  return p / 100;
}

/** ₹ 1,95,105.56 — Indian digit grouping. */
export function formatINR(p: Paise, opts: { symbol?: boolean } = {}): string {
  const neg = p < 0;
  const abs = Math.abs(p);
  const rupees = Math.floor(abs / 100);
  const paise = abs % 100;
  const s = rupees.toString();
  let grouped: string;
  if (s.length <= 3) grouped = s;
  else {
    const last3 = s.slice(-3);
    const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
    grouped = `${rest},${last3}`;
  }
  const body = `${grouped}.${paise.toString().padStart(2, "0")}`;
  return `${neg ? "−" : ""}${opts.symbol === false ? "" : "₹ "}${body}`;
}

export function sum(values: Paise[]): Paise {
  return values.reduce((a, b) => a + b, 0);
}
