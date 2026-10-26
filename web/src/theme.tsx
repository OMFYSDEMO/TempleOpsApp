import { useEffect, useState } from "react";
import { Icon } from "./icons";

/** Theme settings, admin-template style: mode, accent colour, sidebar and header colour, text size, density.
 *  Every choice is a data-* attribute on <html> that styles.css reads; it is saved on this device only
 *  (index.html re-applies it before first paint so there is no flash). */
export type Theme = { theme: "light" | "dark" | "system"; accent: string; side: "light" | "dark" | "accent"; top: "light" | "accent"; size: "sm" | "md" | "lg" | "xl"; density: "comfortable" | "compact" };
export const DEFAULT_THEME: Theme = { theme: "light", accent: "violet", side: "light", top: "light", size: "md", density: "comfortable" };
const KEY = "avos.theme";

export const ACCENTS: { key: string; name: string; color: string }[] = [
  { key: "violet", name: "Violet", color: "#7c6cf2" },
  { key: "blue", name: "Blue", color: "#3b82f6" },
  { key: "teal", name: "Teal", color: "#14b8a6" },
  { key: "green", name: "Meadow green", color: "#2f9e6b" },
  { key: "orange", name: "Orange", color: "#f97316" },
  { key: "rose", name: "Rose", color: "#e8467c" },
  { key: "slate", name: "Slate", color: "#5b6478" },
];

export function loadTheme(): Theme {
  try { return { ...DEFAULT_THEME, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return { ...DEFAULT_THEME }; }
}

export function applyTheme(t: Theme) {
  const root = document.documentElement;
  (Object.keys(DEFAULT_THEME) as (keyof Theme)[]).forEach((k) => {
    if (t[k] === DEFAULT_THEME[k]) root.removeAttribute(`data-${k}`); else root.setAttribute(`data-${k}`, String(t[k]));
  });
  const accent = ACCENTS.find((a) => a.key === t.accent)?.color ?? ACCENTS[0].color;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t.top === "accent" ? accent : (t.theme === "dark" ? "#1b1b28" : "#ffffff"));
}

function saveTheme(t: Theme) {
  const diff: Partial<Theme> = {};
  (Object.keys(DEFAULT_THEME) as (keyof Theme)[]).forEach((k) => { if (t[k] !== DEFAULT_THEME[k]) (diff as any)[k] = t[k]; });
  try { if (Object.keys(diff).length) localStorage.setItem(KEY, JSON.stringify(diff)); else localStorage.removeItem(KEY); } catch {}
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; icon?: any }[]; onChange: (v: T) => void; label: string }) {
  return <div className="seg" role="radiogroup" aria-label={label}>{options.map((o) => <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>{o.icon}{o.label}</button>)}</div>;
}

export function ThemePanel({ onClose }: { onClose: () => void }) {
  const [t, setT] = useState<Theme>(loadTheme);
  const set = <K extends keyof Theme>(k: K, v: Theme[K]) => setT((cur) => ({ ...cur, [k]: v }));
  useEffect(() => { applyTheme(t); saveTheme(t); }, [t]);
  useEffect(() => { const f = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; addEventListener("keydown", f); return () => removeEventListener("keydown", f); }, [onClose]);
  const isDefault = (Object.keys(DEFAULT_THEME) as (keyof Theme)[]).every((k) => t[k] === DEFAULT_THEME[k]);
  return <>
    <button type="button" className="drawer-backdrop" aria-label="Close theme settings" onClick={onClose} />
    <aside className="drawer" role="dialog" aria-label="Theme settings">
      <header><div><h2>Theme settings</h2><div className="sub">Changes apply at once and are saved on this device</div></div><button type="button" className="btn small" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button></header>
      <div className="body">
        <div className="opt"><b>Mode</b>
          <Seg label="Mode" value={t.theme} onChange={(v) => set("theme", v)} options={[{ value: "light", label: "Light", icon: <Icon name="sun" /> }, { value: "dark", label: "Dark", icon: <Icon name="moon" /> }, { value: "system", label: "Device", icon: <Icon name="monitor" /> }]} />
        </div>
        <div className="opt"><b>Colour</b>
          <div className="swatches" role="radiogroup" aria-label="Colour">{ACCENTS.map((a) => <button key={a.key} type="button" role="radio" aria-checked={t.accent === a.key} aria-label={a.name} title={a.name} className={t.accent === a.key ? "on" : ""} style={{ background: a.color }} onClick={() => set("accent", a.key)}>{t.accent === a.key && <Icon name="tick" />}</button>)}</div>
        </div>
        <div className="opt"><b>Sidebar</b>
          <Seg label="Sidebar" value={t.side} onChange={(v) => set("side", v)} options={[{ value: "light", label: "Light", icon: <span className="mini"><i className="t" /><i className="s" /><i /></span> }, { value: "dark", label: "Dark", icon: <span className="mini side-dark"><i className="t" /><i className="s" /><i /></span> }, { value: "accent", label: "Coloured", icon: <span className="mini side-accent"><i className="t" /><i className="s" /><i /></span> }]} />
        </div>
        <div className="opt"><b>Header</b>
          <Seg label="Header" value={t.top} onChange={(v) => set("top", v)} options={[{ value: "light", label: "Light", icon: <span className="mini"><i className="t" /><i className="s" /><i /></span> }, { value: "accent", label: "Coloured", icon: <span className="mini top-accent"><i className="t" /><i className="s" /><i /></span> }]} />
        </div>
        <div className="opt"><b>Text size</b>
          <Seg label="Text size" value={t.size} onChange={(v) => set("size", v)} options={[{ value: "sm", label: "Small", icon: <span className="aa" style={{ fontSize: "13px" }}>Aa</span> }, { value: "md", label: "Normal", icon: <span className="aa" style={{ fontSize: "16px" }}>Aa</span> }, { value: "lg", label: "Large", icon: <span className="aa" style={{ fontSize: "19px" }}>Aa</span> }, { value: "xl", label: "Extra large", icon: <span className="aa" style={{ fontSize: "22px" }}>Aa</span> }]} />
        </div>
        <div className="opt"><b>Spacing</b>
          <Seg label="Spacing" value={t.density} onChange={(v) => set("density", v)} options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} />
        </div>
      </div>
      <footer><button type="button" className="btn" disabled={isDefault} onClick={() => setT({ ...DEFAULT_THEME })}>Reset to default</button><button type="button" className="btn primary" onClick={onClose}>Done</button></footer>
    </aside>
  </>;
}
