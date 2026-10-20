import { type ReactNode as ComponentChildren } from "react";
import { useEffect, useState } from "react";

export function inr(p: number | null | undefined, opts: { symbol?: boolean } = {}): string {
  if (p === null || p === undefined) return "—";
  const neg = p < 0; const abs = Math.abs(p);
  const r = Math.floor(abs / 100).toString(); const ps = (abs % 100).toString().padStart(2, "0");
  const g = r.length <= 3 ? r : r.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + r.slice(-3);
  return `${neg ? "−" : ""}${opts.symbol === false ? "" : "₹ "}${g}.${ps}`;
}
export function inrShort(p: number | null | undefined): string { if (p === null || p === undefined) return "—"; return `₹ ${Math.round(p / 100).toLocaleString("en-IN")}`; }
export const fmtDate = (s: string | null | undefined) => { if (!s) return "—"; const [y, m, d] = s.slice(0, 10).split("-"); return `${d} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(m) - 1]} ${y}`; };
export const fmtDateTime = (s: string | null | undefined) => { if (!s) return "—"; const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z"); return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); };
export const ago = (s: string) => { const ms = Date.now() - new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z").getTime(); const m = Math.floor(ms / 60000); if (m < 60) return `${m} min`; const h = Math.floor(m / 60); if (h < 48) return `${h} h`; return `${Math.floor(h / 24)} d`; };
export const todayIso = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
export const thisPeriod = () => todayIso().slice(0, 7);

export function Card(p: { title?: ComponentChildren; sub?: ComponentChildren; children?: ComponentChildren; actions?: ComponentChildren; tone?: "ok" | "amb" | "bad"; class?: string }) {
  return <section className={`card ${p.tone ?? ""} ${p.class ?? ""}`}>{(p.title || p.sub) && <header><div><h3>{p.title}</h3>{p.sub && <div className="sub">{p.sub}</div>}</div>{p.actions && <div className="actions">{p.actions}</div>}</header>}{p.children}</section>;
}
export function Row(p: { label: ComponentChildren; value: ComponentChildren; strong?: boolean; sub?: ComponentChildren }) {
  return <div className={`row ${p.strong ? "strong" : ""}`}><div><div>{p.label}</div>{p.sub && <div className="sub">{p.sub}</div>}</div><div className="num">{p.value}</div></div>;
}
export function Btn(p: { onClick?: () => unknown | Promise<unknown>; children?: ComponentChildren; kind?: "primary" | "ghost" | "danger" | "gold"; disabled?: boolean; small?: boolean; type?: "button" | "submit"; title?: string }) {
  const [busy, setBusy] = useState(false);
  return <button type={p.type ?? "button"} title={p.title} className={`btn ${p.kind ?? ""} ${p.small ? "small" : ""}`} disabled={p.disabled || busy} onClick={async () => { if (!p.onClick) return; setBusy(true); try { await p.onClick(); } finally { setBusy(false); } }}>{busy ? "…" : p.children}</button>;
}
export function Chip(p: { on?: boolean; onClick?: () => void; children?: ComponentChildren; tone?: "ok" | "amb" | "bad" | "muted" }) {
  return <button type="button" className={`chip ${p.on ? "on" : ""} ${p.tone ?? ""}`} onClick={p.onClick}>{p.children}</button>;
}
export function Chips<T extends string>(p: { value: T | null; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return <div className="chips">{p.options.map((o) => <Chip key={o.value} on={p.value === o.value} onClick={() => p.onChange(o.value)}>{o.label}</Chip>)}</div>;
}
export function Field(p: { label: ComponentChildren; children?: ComponentChildren; hint?: ComponentChildren }) { return <label className="field"><span>{p.label}</span>{p.children}{p.hint && <small>{p.hint}</small>}</label>; }
export function Status(p: { s: string }) {
  const tone: Record<string, string> = { new: "amb", contacted: "", quoted: "", hold: "amb", won: "ok", lost: "bad", provisional: "amb", approved: "ok", checked_in: "ok", checked_out: "", cancelled: "bad", no_show: "bad", pending: "amb", returned: "bad", auto: "ok", open: "amb", in_progress: "", done: "ok", noted: "muted", matched: "ok", proposed: "amb", unmatched: "bad", carried: "muted", locked: "ok", filed: "ok", precleared: "amb", settled: "ok", draft: "amb", undone: "bad", duplicate: "muted", routed: "muted", dismissed: "muted", void: "bad", issued: "ok", credited: "muted", overdue: "bad", waiting: "amb", inactive: "muted" };
  return <span className={`status ${tone[p.s] ?? ""}`}>{p.s.replace(/_/g, " ")}</span>;
}
export function Empty(p: { children?: ComponentChildren }) { return <div className="empty">{p.children ?? "Nothing here."}</div>; }

let toastFn: ((m: string, tone?: "ok" | "bad") => void) | null = null;
export function toast(m: string, tone: "ok" | "bad" = "ok") { toastFn?.(m, tone); }
export function Toaster() {
  const [t, setT] = useState<{ m: string; tone: string } | null>(null);
  useEffect(() => { toastFn = (m, tone = "ok") => { setT({ m, tone }); setTimeout(() => setT(null), 3200); }; return () => { toastFn = null; }; }, []);
  return t ? <div className={`toast ${t.tone}`}>{t.m}</div> : null;
}
export async function run(fn: () => Promise<unknown>, okMsg?: string) { try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e: any) { toast(e?.message ?? String(e), "bad"); throw e; } }

/** Rupee keypad: the amount is the only typed field (W5a). Value is paise. */
export function Keypad(p: { value: number; onChange: (paise: number) => void }) {
  const digits = Math.round(p.value / 100).toString();
  const press = (k: string) => { let v = digits === "0" ? "" : digits; if (k === "⌫") v = v.slice(0, -1); else if ((v + k).length <= 8) v += k; p.onChange(Number(v || "0") * 100); };
  return <div className="keypad"><div className="amt">₹ {Number(digits).toLocaleString("en-IN")}</div><div className="keys">{["1","2","3","4","5","6","7","8","9","00","0","⌫"].map((k) => <button type="button" key={k} onClick={() => press(k)}>{k}</button>)}</div></div>;
}
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []): { data: T | null; error: string | null; reload: () => Promise<void>; loading: boolean } {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(true);
  const reload = async () => { setLoading(true); try { setData(await fn()); setError(null); } catch (e: any) { setError(e?.message ?? String(e)); } finally { setLoading(false); } };
  useEffect(() => { reload(); }, deps);
  return { data, error, reload, loading };
}
export function Loading(p: { error?: string | null }) { return p.error ? <div className="empty bad">{p.error}</div> : <div className="empty">Loading…</div>; }
export function Money(p: { v: number | null | undefined }) { return <span className="num">{inr(p.v)}</span>; }
