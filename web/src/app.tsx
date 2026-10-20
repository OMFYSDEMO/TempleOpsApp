import { useEffect, useState } from "react";
import { get, post, devUser, setDevUser } from "./api";
import { Toaster, Empty, fmtDateTime, fmtDate, toast, Btn } from "./ui";
import { readQueue, onQueueChange, flush } from "./offline";
import { Leads, Inbox, Reservations, Availability } from "./screens/sales";
import { FrontDesk, Payments, Invoices, Tasks, Expenses, QuickCapture } from "./screens/property";
import { Approvals, Payouts, Reconcile, RevenueOverview, OwnerDashboard, BankExpenses, Admin, MonthClose, GstSheet, AuditLog } from "./screens/management";
import { Login, ResetPassword, ChangePassword } from "./screens/auth";
import { Icon } from "./icons";

export interface Me { actor: { id: string; name: string; role: string; email: string; via?: string }; property: { id: string; name: string; gstin: string | null; today: string; auto_approve_on_tariff: boolean }; capabilities: string[]; unread_notifications: number; must_change_password?: boolean; has_password?: boolean; }
export interface Ref { locations: any[]; channels: any[]; accounts: any[]; users: any[]; rate_cards: any[]; }

type Screen = { key: string; label: string; cap: string; group: string; comp: (p: { me: Me; refs: Ref }) => any; mobile?: boolean; icon: string };
const SCREENS: Screen[] = [
  { key: "leads", label: "Leads", cap: "leads", group: "Sales", comp: Leads, mobile: true, icon: "leads" },
  { key: "inbox", label: "Inbox — bookings", cap: "inbox", group: "Sales", comp: Inbox, mobile: true, icon: "inbox" },
  { key: "resv", label: "Reservations", cap: "bookings_write", group: "Sales", comp: Reservations, mobile: true, icon: "calendar" },
  { key: "avail", label: "Availability", cap: "bookings_read", group: "Sales", comp: Availability, icon: "grid" },
  { key: "desk", label: "Front desk", cap: "frontdesk", group: "Property", comp: FrontDesk, mobile: true, icon: "key" },
  { key: "pay", label: "Payments", cap: "payments", group: "Property", comp: Payments, mobile: true, icon: "banknote" },
  { key: "invoice", label: "Guest invoices", cap: "invoices", group: "Property", comp: Invoices, icon: "file" },
  { key: "tasks", label: "Tasks", cap: "tasks", group: "Property", comp: Tasks, mobile: true, icon: "tasks" },
  { key: "pexp", label: "Expenses & petty cash", cap: "petty_expenses", group: "Property", comp: Expenses, icon: "receipt" },
  { key: "appr", label: "Approvals", cap: "approvals", group: "Revenue", comp: Approvals, mobile: true, icon: "check" },
  { key: "payouts", label: "OTA payouts", cap: "settlements", group: "Revenue", comp: Payouts, icon: "swap" },
  { key: "recon", label: "Smart Reconcile", cap: "recon", group: "Revenue", comp: Reconcile, icon: "reconcile" },
  { key: "revdash", label: "Revenue overview", cap: "revenue_reports", group: "Revenue", comp: RevenueOverview, icon: "chart" },
  { key: "dash", label: "Dashboard", cap: "pnl_reports", group: "Owner", comp: OwnerDashboard, mobile: true, icon: "dashboard" },
  { key: "bankexp", label: "Bank expenses", cap: "bank_expenses", group: "Owner", comp: BankExpenses, icon: "bank" },
  { key: "admin", label: "Settings & users", cap: "admin", group: "Owner", comp: Admin, icon: "settings" },
  { key: "close", label: "Month close", cap: "close", group: "Close & file", comp: MonthClose, icon: "lock" },
  { key: "gst", label: "GST filing sheet", cap: "gst", group: "Close & file", comp: GstSheet, icon: "percent" },
  { key: "audit", label: "Change log", cap: "audit", group: "Close & file", comp: AuditLog, icon: "history" },
];
const LOCK: Record<string, string> = { sales: "Bookings & reservations only. Own unapproved entries editable. No P&L.", property: "Check-in/out, collections, tasks, petty cash. No P&L, no settings.", revenue: "Approves exceptions, payouts, reconciliation, pre-close. Revenue — not expense P&L.", owner: "Oversight + bank-paid expenses. Holds users, backups, final say.", accountant: "Locks months, files GST, reads the change log. No user admin." };
const DEV_USERS = ["shajianandan@gmail.com", "bookings@meadowsvarkala.com", "meadowsvarkala@gmail.com", "trupti@truvic.co.in", "shubham.kandalkar@gmail.com"];

function useHash() { const [h, setH] = useState(location.hash.slice(1) || ""); useEffect(() => { const f = () => setH(location.hash.slice(1) || ""); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []); return h; }

export function App() {
  const [me, setMe] = useState<Me | null>(null); const [ref, setRef] = useState<Ref | null>(null); const [signedOut, setSignedOut] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [appEnv, setAppEnv] = useState<string>("");
  const [notifOpen, setNotifOpen] = useState(false); const [notifs, setNotifs] = useState<any[]>([]);
  const [queued, setQueued] = useState(readQueue().length);
  const [changePw, setChangePw] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const hash = useHash();
  useEffect(() => { setNavOpen(false); }, [hash]);
  const load = async () => {
    try { const [m, r] = await Promise.all([get<Me>("/me"), get<Ref>("/ref")]); setMe(m); setRef(r); setErr(null); setSignedOut(false); }
    catch (e: any) { setMe(null); if (e?.status === 401) setSignedOut(true); else setErr(e?.message ?? String(e)); }
  };
  useEffect(() => { load(); get("/health").then((h) => setAppEnv(h.env)).catch(() => {}); }, []);
  useEffect(() => onQueueChange(() => setQueued(readQueue().length)), []);
  useEffect(() => { if (navigator.onLine && readQueue().length) flush().then((n) => { if (n) toast(`${n} queued entr${n === 1 ? "y" : "ies"} synced`); }); }, [me?.actor.id]);
  const signOut = async () => { try { await post("/auth/logout"); } catch {} setDevUser(null); setMe(null); setSignedOut(true); location.hash = ""; };

  const resetToken = hash.startsWith("reset?") ? new URLSearchParams(hash.slice(6)).get("token") : null;
  if (resetToken) return <><ResetPassword token={resetToken} onDone={() => { location.hash = ""; load(); }} /><Toaster /></>;
  if (err) return <div style={{ padding: "24px" }}><h2>AVOS</h2><p className="muted">{err}</p><Btn onClick={load}>Retry</Btn></div>;
  if (signedOut) return <><Login onSignedIn={load} devUsers={appEnv && appEnv !== "production" ? DEV_USERS : undefined} onDevUser={(u) => { setDevUser(u || null); load(); }} /><Toaster /></>;
  if (!me || !ref) return <div className="empty">Loading…</div>;
  if (me.must_change_password || changePw) return <><ChangePassword forced={!!me.must_change_password} hasPassword={!!me.has_password} onDone={() => { setChangePw(false); load(); }} /><Toaster /></>;
  const visible = SCREENS.filter((s) => me.capabilities.includes(s.cap));
  const current = visible.find((s) => s.key === hash) ?? visible[0];
  const groups = [...new Set(visible.map((s) => s.group))];
  const openNotifs = async () => { setNotifOpen(true); const r = await get("/notifications"); setNotifs(r.notifications); await post("/notifications/read"); setMe({ ...me, unread_notifications: 0 }); };
  const Comp = current.comp;
  const initials = me.actor.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const roleNote = LOCK[me.actor.role];
  return <>
    <div className="topbar">
      <button type="button" className="btn menu-toggle" aria-controls="avos-navigation" aria-expanded={navOpen} onClick={() => setNavOpen(!navOpen)}>☰ Menu</button>
      <a className="mbrand" href="#"><span className="mark">A</span><span className="txt">AVOS</span></a>
      <div className="where"><Icon name="house" size={16} /><b>{me.property.name}</b><span>· {fmtDate(me.property.today)}</span></div>
      <div className="spacer" />
      {queued > 0 && <span className="queue">{queued} pending sync</span>}
      <button className="iconbtn" onClick={openNotifs} title="Notifications"><Icon name="bell" />{me.unread_notifications > 0 && <b>{me.unread_notifications}</b>}</button>
      <details className="usermenu"><summary><span className="avatar">{initials}</span><span>{me.actor.name}</span><span className="role">· {me.actor.role}</span><Icon name="chevron" size={14} /></summary><div>
        <div className="sub">{me.actor.email}</div>
        {me.actor.via !== "access" && <button onClick={() => setChangePw(true)}><Icon name="lock" size={16} />Change password</button>}
        <button onClick={signOut}><Icon name="logout" size={16} />Sign out</button>
        {devUser() && appEnv !== "production" && <div className="sub"><label>Dev user <select value={devUser() ?? ""} onChange={(e: any) => { setDevUser(e.currentTarget.value); location.hash = ""; load(); }}>{DEV_USERS.map((u) => <option value={u}>{u.split("@")[0]}</option>)}</select></label></div>}
      </div></details>
    </div>
    <div className="shell">
      <nav className={`side ${navOpen ? "is-open" : ""}`} id="avos-navigation" aria-label="AVOS navigation">
        <a className="brand" href="#"><span className="mark">A</span><span><b>AVOS</b><small>{me.property.name}</small></span><button type="button" className="btn menu-close" aria-label="Close navigation" onClick={() => setNavOpen(false)}>×</button></a>
        {groups.map((g) => <div key={g}><div className="grp">{g}</div>{visible.filter((s) => s.group === g).map((s) => <a key={s.key} href={`#${s.key}`} className={`item ${s.key === current.key ? "on" : ""}`}><Icon name={s.icon} />{s.label}</a>)}</div>)}
        <div className="foot"><b>{me.actor.role.charAt(0).toUpperCase() + me.actor.role.slice(1)} access</b>{roleNote}</div>
      </nav>
      {navOpen && <button type="button" className="menu-backdrop" aria-label="Close navigation" onClick={() => setNavOpen(false)} />}
      <div className="content">
        <main id="content"><Comp me={me} refs={ref} /></main>
      </div>
    </div>
    {me.capabilities.includes("tasks") && <QuickCapture me={me} refs={ref} />}
    {notifOpen && <div className="sheet" onClick={() => setNotifOpen(false)}><div onClick={(e) => e.stopPropagation()}><h3>Notifications</h3>{notifs.length === 0 ? <Empty>No notifications.</Empty> : notifs.map((n) => <div className="row" key={n.id}><div><div>{n.message}</div><div className="sub">{fmtDateTime(n.created_at)}</div></div></div>)}</div></div>}
    <Toaster />
  </>;
}
