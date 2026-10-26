import { type ReactNode as ComponentChildren } from "react";
import { useEffect, useRef, useState } from "react";

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
  return <section className={`card ${p.tone ?? ""} ${p.class ?? ""}`}>{(p.title || p.sub) && <header><div><h2>{p.title}</h2>{p.sub && <div className="sub">{p.sub}</div>}</div>{p.actions && <div className="actions">{p.actions}</div>}</header>}{p.children}</section>;
}
export function Row(p: { label: ComponentChildren; value: ComponentChildren; strong?: boolean; sub?: ComponentChildren }) {
  return <div className={`row ${p.strong ? "strong" : ""}`}><div><div>{p.label}</div>{p.sub && <div className="sub">{p.sub}</div>}</div><div className="num">{p.value}</div></div>;
}
export function Btn(p: { onClick?: () => unknown | Promise<unknown>; children?: ComponentChildren; kind?: "primary" | "ghost" | "danger" | "gold"; disabled?: boolean; small?: boolean; type?: "button" | "submit"; title?: string }) {
  const [busy, setBusy] = useState(false);
  return <button type={p.type ?? "button"} title={p.title} className={`btn ${p.kind ?? ""} ${p.small ? "small" : ""}`} disabled={p.disabled || busy} aria-busy={busy || undefined} onClick={async () => { if (!p.onClick) return; setBusy(true); try { await p.onClick(); } finally { setBusy(false); } }}>{busy ? "…" : p.children}</button>;
}
export function Chip(p: { on?: boolean; onClick?: () => void; children?: ComponentChildren; tone?: "ok" | "amb" | "bad" | "muted" }) {
  return <button type="button" aria-pressed={!!p.on} className={`chip ${p.on ? "on" : ""} ${p.tone ?? ""}`} onClick={p.onClick}>{p.children}</button>;
}
export function Chips<T extends string>(p: { value: T | null; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return <div className="chips">{p.options.map((o) => <Chip key={o.value} on={p.value === o.value} onClick={() => p.onChange(o.value)}>{o.label}</Chip>)}</div>;
}
/** Which bank: hidden when there is only one; the default bank is preselected. */
export function BankPick({ accounts, value, onChange, label = "Bank" }: { accounts: any[]; value: string; onChange: (id: string) => void; label?: ComponentChildren }) {
  const banks = accounts.filter((a) => a.kind === "bank");
  if (banks.length < 2) return null;
  return <label className="field"><span>{label}</span><select value={value} onChange={(e: any) => onChange(e.currentTarget.value)}>{banks.map((b) => <option key={b.id} value={b.id}>{b.name}{b.account_no ? ` · ${b.account_no}` : ""}{b.is_default ? " (default)" : ""}</option>)}</select></label>;
}
export const defaultBankId = (accounts: any[]) => { const banks = accounts.filter((a) => a.kind === "bank"); return (banks.find((b) => b.is_default) ?? banks[0])?.id ?? ""; };

export function Field(p: { label: ComponentChildren; children?: ComponentChildren; hint?: ComponentChildren }) { return <label className="field"><span>{p.label}</span>{p.children}{p.hint && <small>{p.hint}</small>}</label>; }
export function Status(p: { s: string }) {
  const tone: Record<string, string> = { "left owing": "bad", "due today": "amb", new: "amb", contacted: "", quoted: "", hold: "amb", won: "ok", lost: "bad", provisional: "amb", approved: "ok", checked_in: "ok", checked_out: "", cancelled: "bad", no_show: "bad", pending: "amb", returned: "bad", auto: "ok", open: "amb", in_progress: "", done: "ok", noted: "muted", matched: "ok", proposed: "amb", unmatched: "bad", carried: "muted", locked: "ok", filed: "ok", precleared: "amb", settled: "ok", draft: "amb", undone: "bad", duplicate: "muted", routed: "muted", dismissed: "muted", void: "bad", issued: "ok", credited: "muted", overdue: "bad", waiting: "amb", inactive: "muted", below: "amb", above: "", due: "amb", none: "muted", default: "ok" };
  return <span className={`status ${tone[p.s] ?? ""}`}>{p.s.replace(/_/g, " ")}</span>;
}
/**
 * A box that scrolls sideways when its content is wider than the screen (tables, the availability grid). Once it
 * actually scrolls it becomes a named, focusable region so keyboard users can scroll it too (WCAG 2.1.1).
 */
export function ScrollX(p: { className?: string; label?: string; children?: ComponentChildren }) {
  const r = useRef<HTMLDivElement>(null);
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    const el = r.current; if (!el) return;
    const f = () => setName(el.scrollWidth > el.clientWidth + 1 ? p.label ?? el.closest(".card")?.querySelector("h2")?.textContent ?? "Table" : null);
    f(); const o = new ResizeObserver(f); o.observe(el); return () => o.disconnect();
  }, [p.label]);
  return <div ref={r} className={p.className ?? "table-wrap"} {...(name ? { tabIndex: 0, role: "region", "aria-label": `${name} (scrolls sideways)` } : {})}>{p.children}</div>;
}
export function Empty(p: { children?: ComponentChildren }) { return <div className="empty">{p.children ?? "Nothing here."}</div>; }

let toastFn: ((m: string, tone?: "ok" | "bad") => void) | null = null;
export function toast(m: string, tone: "ok" | "bad" = "ok") { toastFn?.(m, tone); }
/** Toasts are announced to screen readers; the same host renders the in-app dialogs below. */
export function Toaster() {
  const [t, setT] = useState<{ m: string; tone: string } | null>(null);
  useEffect(() => { toastFn = (m, tone = "ok") => { setT({ m, tone }); setTimeout(() => setT(null), tone === "bad" ? 6000 : 3200); }; return () => { toastFn = null; }; }, []);
  return <>
    <div className="toastzone" role="status" aria-live="polite">{t?.tone !== "bad" && t && <div className="toast">{t.m}</div>}</div>
    <div className="toastzone" role="alert">{t?.tone === "bad" && <div className="toast bad">{t.m}</div>}</div>
    <DialogHost />
  </>;
}

/**
 * In-app dialogs in place of the browser's prompt/confirm/alert: labelled, keyboard-trapped, Esc cancels, focus
 * returns to the button that opened it. ask() resolves the typed text ("" for a plain confirmation) or null.
 */
type AskOpts = { title: string; body?: ComponentChildren; input?: { label: string; value?: string; type?: string; minLength?: number; readOnly?: boolean; multiline?: boolean }; ok?: string; cancel?: string | null; danger?: boolean };
let askFn: ((o: AskOpts) => Promise<string | null>) | null = null;
export const ask = (o: AskOpts): Promise<string | null> => askFn ? askFn(o) : Promise.resolve(null);
export const askConfirm = async (title: string, body?: ComponentChildren, o: { ok?: string; danger?: boolean } = {}) => (await ask({ title, body, ok: o.ok ?? "Confirm", danger: o.danger })) !== null;
export const askText = async (title: string, label = "Reason", o: Partial<AskOpts> & { minLength?: number } = {}) => { const v = await ask({ title, ok: "Save", ...o, input: { label, minLength: o.minLength, ...o.input } }); return v && v.trim() ? v.trim() : null; };
export const tell = (title: string, body?: ComponentChildren) => ask({ title, body, ok: "OK", cancel: null }).then(() => undefined);

function DialogHost() {
  const [d, setD] = useState<(AskOpts & { resolve: (v: string | null) => void; back: Element | null }) | null>(null);
  const [val, setVal] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { askFn = (o) => new Promise((resolve) => { setVal(o.input?.value ?? ""); setD({ ...o, resolve, back: document.activeElement }); }); return () => { askFn = null; }; }, []);
  useEffect(() => { if (!d) return; const el = box.current?.querySelector<HTMLElement>("input,textarea,.btn.primary,.btn.danger"); el?.focus(); if (el instanceof HTMLInputElement && el.readOnly) el.select(); }, [d]);
  if (!d) return null;
  const done = (v: string | null) => { const back = d.back as HTMLElement | null; d.resolve(v); setD(null); setTimeout(() => { if (back?.isConnected) back.focus(); }, 60); }; // after the opening button stops being busy
  const short = !!d.input && !d.input.readOnly && val.trim().length < Math.max(1, d.input.minLength ?? 1);
  const submit = (e?: { preventDefault(): void }) => { e?.preventDefault(); if (!short) done(d.input ? val : ""); };
  const keys = (e: any) => {
    if (e.key === "Escape") { e.preventDefault(); done(null); return; }
    if (e.key !== "Tab") return;
    const f = [...(box.current?.querySelectorAll<HTMLElement>("input,textarea,button:not([disabled])") ?? [])];
    if (!f.length) return;
    const i = f.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  };
  return <div className="dlg-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && d.cancel !== null) done(null); }}>
    <div className="dlg" ref={box} role={d.danger ? "alertdialog" : "dialog"} aria-modal="true" aria-labelledby="dlg-title" aria-describedby={d.body ? "dlg-body" : undefined} onKeyDown={keys}>
      <form onSubmit={submit}>
        <h2 id="dlg-title">{d.title}</h2>
        {d.body && <div id="dlg-body" className="dlg-body">{d.body}</div>}
        {d.input && <label className="field"><span>{d.input.label}</span>{d.input.multiline
          ? <textarea rows={3} value={val} readOnly={d.input.readOnly} onChange={(e: any) => setVal(e.currentTarget.value)} />
          : <input type={d.input.type ?? "text"} value={val} readOnly={d.input.readOnly} onChange={(e: any) => setVal(e.currentTarget.value)} />}
          {d.input.minLength && !d.input.readOnly ? <small>At least {d.input.minLength} characters</small> : null}</label>}
        <div className="actions end">
          {d.cancel !== null && <button type="button" className="btn" onClick={() => done(null)}>{d.cancel ?? "Cancel"}</button>}
          <button type="submit" className={`btn ${d.danger ? "danger" : "primary"}`} disabled={short}>{d.ok ?? "OK"}</button>
        </div>
      </form>
    </div>
  </div>;
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

/**
 * Category picker: the few categories a desk uses daily as one-tap chips, everything else in a dropdown grouped
 * by family. A choice made in the dropdown shows as the selected chip, so the picker never grows past one row.
 */
export function CategoryPicker(p: { value: string; onChange: (code: string) => void; categories: { code: string; label: string; family: string }[]; common: string[]; families: string[]; label?: string }) {
  const byCode = new Map(p.categories.map((c) => [c.code, c]));
  const chips = p.common.filter((c) => byCode.has(c));
  const extra = p.value && !chips.includes(p.value) ? byCode.get(p.value) : null;
  return <div className="catpick">
    {p.label && <div className="sub">{p.label}</div>}
    <div className="chips">
      {chips.map((code) => <Chip key={code} on={p.value === code} onClick={() => p.onChange(code)}>{byCode.get(code)!.label}</Chip>)}
      {extra && <Chip on onClick={() => {}}>{extra.label}</Chip>}
      <select className="catmore" value="" onChange={(e: any) => { if (e.currentTarget.value) p.onChange(e.currentTarget.value); }} aria-label="More categories">
        <option value="">More…</option>
        {p.families.map((f) => <optgroup key={f} label={f}>{p.categories.filter((c) => c.family === f).map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</optgroup>)}
      </select>
    </div>
  </div>;
}
