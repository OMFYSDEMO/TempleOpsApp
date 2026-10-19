import { useEffect, useState } from "preact/hooks";
import { get, post, devUser, setDevUser } from "./api";
import { Toaster, Empty, fmtDateTime, toast } from "./ui";
import { readQueue, onQueueChange, flush } from "./offline";
import { Leads, Inbox, Reservations, Availability } from "./screens/sales";
import { FrontDesk, Payments, Invoices, Tasks, Expenses, QuickCapture } from "./screens/property";
import { Approvals, Payouts, Reconcile, RevenueOverview, OwnerDashboard, BankExpenses, Admin, MonthClose, GstSheet, AuditLog } from "./screens/management";

export interface Me { actor: { id: string; name: string; role: string; email: string }; property: { id: string; name: string; gstin: string | null; today: string; auto_approve_on_tariff: boolean }; capabilities: string[]; unread_notifications: number; }
export interface Ref { locations: any[]; channels: any[]; accounts: any[]; users: any[]; rate_cards: any[]; }

type Screen = { key: string; label: string; cap: string; group: string; comp: (p: { me: Me; refs: Ref }) => any; mobile?: boolean };
const SCREENS: Screen[] = [
  { key: "leads", label: "Leads", cap: "leads", group: "Sales", comp: Leads, mobile: true },
  { key: "inbox", label: "Inbox — bookings", cap: "inbox", group: "Sales", comp: Inbox },
  { key: "resv", label: "Reservations", cap: "bookings_write", group: "Sales", comp: Reservations, mobile: true },
  { key: "avail", label: "Availability", cap: "bookings_read", group: "Sales", comp: Availability },
  { key: "desk", label: "Front desk", cap: "frontdesk", group: "Property", comp: FrontDesk, mobile: true },
  { key: "pay", label: "Payments", cap: "payments", group: "Property", comp: Payments, mobile: true },
  { key: "invoice", label: "Guest invoices", cap: "invoices", group: "Property", comp: Invoices },
  { key: "tasks", label: "Tasks", cap: "tasks", group: "Property", comp: Tasks, mobile: true },
  { key: "pexp", label: "Expenses & petty cash", cap: "petty_expenses", group: "Property", comp: Expenses },
  { key: "appr", label: "Approvals", cap: "approvals", group: "Revenue", comp: Approvals, mobile: true },
  { key: "payouts", label: "OTA payouts", cap: "settlements", group: "Revenue", comp: Payouts },
  { key: "recon", label: "Smart Reconcile", cap: "recon", group: "Revenue", comp: Reconcile },
  { key: "revdash", label: "Revenue overview", cap: "revenue_reports", group: "Revenue", comp: RevenueOverview },
  { key: "dash", label: "Dashboard", cap: "pnl_reports", group: "Owner", comp: OwnerDashboard, mobile: true },
  { key: "bankexp", label: "Bank expenses", cap: "bank_expenses", group: "Owner", comp: BankExpenses },
  { key: "admin", label: "Settings & users", cap: "admin", group: "Owner", comp: Admin },
  { key: "close", label: "Month close", cap: "close", group: "Close & file", comp: MonthClose },
  { key: "gst", label: "GST filing sheet", cap: "gst", group: "Close & file", comp: GstSheet },
  { key: "audit", label: "Change log", cap: "audit", group: "Close & file", comp: AuditLog },
];
const LOCK: Record<string, string> = { sales: "Bookings & reservations only. Own unapproved entries editable. No P&L.", property: "Check-in/out, collections, tasks, petty cash. No P&L, no settings.", revenue: "Approves exceptions, payouts, reconciliation, pre-close. Revenue — not expense P&L.", owner: "Oversight + bank-paid expenses. Holds users, backups, final say.", accountant: "Locks months, files GST, reads the change log. No user admin." };
const DEV_USERS = ["shajianandan@gmail.com", "bookings@meadowsvarkala.com", "meadowsvarkala@gmail.com", "trupti@truvic.co.in", "shubham.kandalkar@gmail.com"];

function useHash() { const [h, setH] = useState(location.hash.slice(1) || ""); useEffect(() => { const f = () => setH(location.hash.slice(1) || ""); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []); return h; }

export function App() {
  const [me, setMe] = useState<Me | null>(null); const [ref, setRef] = useState<Ref | null>(null); const [err, setErr] = useState<string | null>(null);
  const [notifOpen, setNotifOpen] = useState(false); const [notifs, setNotifs] = useState<any[]>([]);
  const [queued, setQueued] = useState(readQueue().length);
  const hash = useHash();
  const load = async () => { try { const [m, r] = await Promise.all([get<Me>("/me"), get<Ref>("/ref")]); setMe(m); setRef(r); setErr(null); } catch (e: any) { setErr(e?.message ?? String(e)); setMe(null); } };
  useEffect(() => { load(); }, []);
  useEffect(() => onQueueChange(() => setQueued(readQueue().length)), []);
  useEffect(() => { if (navigator.onLine && readQueue().length) flush().then((n) => { if (n) toast(`${n} queued entr${n === 1 ? "y" : "ies"} synced`); }); }, [me?.actor.id]);
  if (err) return <div style="padding:24px"><h2>AVOS</h2><p class="muted">{err}</p>{!devUser() && <p>Sign in through Cloudflare Access, or (development only) pick a user:</p>}<select onChange={(e: any) => { setDevUser(e.currentTarget.value || null); load(); }}><option value="">— dev user —</option>{DEV_USERS.map((u) => <option value={u}>{u}</option>)}</select></div>;
  if (!me || !ref) return <div class="empty">Loading…</div>;
  const visible = SCREENS.filter((s) => me.capabilities.includes(s.cap));
  const current = visible.find((s) => s.key === hash) ?? visible[0];
  const groups = [...new Set(visible.map((s) => s.group))];
  const openNotifs = async () => { setNotifOpen(true); const r = await get("/notifications"); setNotifs(r.notifications); await post("/notifications/read"); setMe({ ...me, unread_notifications: 0 }); };
  const Comp = current.comp;
  return <>
    <div class="topbar"><div class="brand">AVOS<small>{me.property.name}</small></div><div class="spacer" />
      {queued > 0 && <span class="queue">{queued} pending sync</span>}
      <button class="bell" onClick={openNotifs} title="Notifications">🔔{me.unread_notifications > 0 && <b>{me.unread_notifications}</b>}</button>
      <span class="who">{me.actor.name} · {me.actor.role}</span>
      {devUser() && <select value={devUser() ?? ""} onChange={(e: any) => { setDevUser(e.currentTarget.value); location.hash = ""; load(); }}>{DEV_USERS.map((u) => <option value={u}>{u.split("@")[0]}</option>)}</select>}
    </div>
    <div class="layout">
      <nav class="side">{groups.map((g) => <div key={g}><div class="grp">{g}</div>{visible.filter((s) => s.group === g).map((s) => <a key={s.key} href={`#${s.key}`} class={s.key === current.key ? "on" : ""}>{s.label}</a>)}</div>)}<div class="lock">{LOCK[me.actor.role]}</div></nav>
      <main><Comp me={me} refs={ref} /></main>
    </div>
    <nav class="mobile-nav">{visible.filter((s) => s.mobile).slice(0, 5).map((s) => <a key={s.key} href={`#${s.key}`} class={s.key === current.key ? "on" : ""}>{s.label.split(" ")[0]}</a>)}</nav>
    {me.capabilities.includes("tasks") && <QuickCapture me={me} refs={ref} />}
    {notifOpen && <div class="sheet" onClick={() => setNotifOpen(false)}><div onClick={(e) => e.stopPropagation()}><h3>Notifications</h3>{notifs.length === 0 ? <Empty>No notifications.</Empty> : notifs.map((n) => <div class="row" key={n.id}><div><div>{n.message}</div><div class="sub">{fmtDateTime(n.created_at)}</div></div></div>)}</div></div>}
    <Toaster />
  </>;
}
