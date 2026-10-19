/** Short, sortable-enough ids: prefix + time36 + random. */
export function newId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = crypto.getRandomValues(new Uint8Array(6));
  let s = "";
  for (const b of r) s += (b % 36).toString(36);
  return `${prefix}_${t}${s}`;
}

/** Digits only, last 10 kept with country code where present. */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D/g, "");
  if (d.length < 8) return null;
  if (d.length === 10) return `91${d}`;
  return d;
}
