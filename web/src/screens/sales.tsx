import { useState } from "react";
import { get, post, patch, del } from "../api";
import { Card, Row, Btn, Chips, Field, Status, Empty, Loading, inr, fmtDate, ago, useLoad, run, toast, todayIso } from "../ui";
import type { Me, Ref } from "../app";

const SOURCES = [["instagram", "Instagram"], ["facebook", "Facebook"], ["website", "Website"], ["whatsapp", "WhatsApp"], ["phone", "Phone"], ["walkin", "Walk-in"], ["other", "Other"]] as const;
const LOST = [["dates", "Dates"], ["price", "Price"], ["no_reply", "No reply"], ["expired", "Expired"], ["other", "Other"]] as const;

export function Leads({ me, refs }: { me: Me; refs: Ref }) {
  const [filter, setFilter] = useState<string | null>(null);
  const q = useLoad(() => get(`/leads${filter ? `?status=${filter}` : ""}`), [filter]);
  const funnel = useLoad(() => get("/leads/funnel"), []);
  const [newLead, setNewLead] = useState<any>({ source: "whatsapp", name: "", phone: "", check_in: "", check_out: "", rooms_wanted: 1, adults: 2 });
  const [showNew, setShowNew] = useState(false);
  const rooms = refs.locations.filter((l) => l.kind === "room");
  const [quoteRooms, setQuoteRooms] = useState<Record<string, string[]>>({});
  const create = () => run(async () => { await post("/leads", newLead); setShowNew(false); setNewLead({ ...newLead, name: "", phone: "" }); await q.reload(); }, "Lead captured");
  const act = (id: string, verb: string, body?: unknown, msg?: string) => run(async () => { const r = await post(`/leads/${id}/${verb}`, body); await q.reload(); return r; }, msg);
  return <>
    <h2>Leads <small>W13 · Stage 0 · five statuses, lost takes a reason</small></h2>
    <div className="actions" style={{ marginBottom: "10px" }}><Chips value={filter} options={[{ value: "", label: "Open" }, { value: "new", label: "New" }, { value: "quoted", label: "Quoted" }, { value: "hold", label: "Hold" }, { value: "won", label: "Won" }, { value: "lost", label: "Lost" }]} onChange={(v) => setFilter(v || null)} /><span className="spacer" /><Btn kind="primary" onClick={() => setShowNew(!showNew)}>+ Lead</Btn></div>
    {showNew && <Card title="New lead · 3 taps + a name"><Chips value={newLead.source} options={SOURCES.map(([v, l]) => ({ value: v, label: l }))} onChange={(v) => setNewLead({ ...newLead, source: v })} />
      <div className="grid two"><Field label="Name"><input value={newLead.name} onChange={(e: any) => setNewLead({ ...newLead, name: e.currentTarget.value })} /></Field><Field label="Phone"><input inputMode="tel" value={newLead.phone} onChange={(e: any) => setNewLead({ ...newLead, phone: e.currentTarget.value })} /></Field>
      <Field label="Check-in"><input type="date" value={newLead.check_in} onChange={(e: any) => setNewLead({ ...newLead, check_in: e.currentTarget.value })} /></Field><Field label="Check-out"><input type="date" value={newLead.check_out} onChange={(e: any) => setNewLead({ ...newLead, check_out: e.currentTarget.value })} /></Field>
      <Field label="Rooms"><input type="number" min="1" value={newLead.rooms_wanted} onChange={(e: any) => setNewLead({ ...newLead, rooms_wanted: Number(e.currentTarget.value) })} /></Field><Field label="Adults"><input type="number" min="1" value={newLead.adults} onChange={(e: any) => setNewLead({ ...newLead, adults: Number(e.currentTarget.value) })} /></Field></div>
      <div className="actions end"><Btn onClick={() => setShowNew(false)}>Cancel</Btn><Btn kind="primary" onClick={create}>Save lead</Btn></div></Card>}
    {!q.data ? <Loading error={q.error} /> : q.data.leads.length === 0 ? <Empty>No leads{filter ? ` in ${filter}` : " open"}.</Empty> : q.data.leads.map((l: any) => {
      const quote = l.quote_json ? JSON.parse(l.quote_json) : null;
      const overdue = l.status === "new" && Date.now() - new Date(l.created_at.replace(" ", "T") + "Z").getTime() > 15 * 60000;
      const sel = quoteRooms[l.id] ?? [];
      return <Card key={l.id} tone={overdue ? "bad" : undefined} title={<>{l.source} · {l.guest_name} <Status s={l.status} /></>} sub={<>age {ago(l.created_at)} · {l.assigned_name ?? "unassigned"}{overdue ? " · overdue" : ""} · {l.past_stays ? `${l.past_stays} past stay(s)` : "new guest (no stays yet)"}</>}>
        <div className="muted">{l.check_in ? `${fmtDate(l.check_in)} → ${fmtDate(l.check_out)}` : "dates not set"} · {l.rooms_wanted} room(s) · {l.adults} adults{l.guest_phone ? ` · +${l.guest_phone}` : ""}</div>
        {quote && <div style={{ marginTop: "8px" }}>{quote.lines.map((x: any) => <Row key={x.room_id} label={`${x.room_name} × ${x.nights} night(s) @ ${inr(x.nightly_rate_paise)}`} value={inr(x.room_total_paise)} />)}{quote.gst_paise > 0 && <Row label="GST" value={inr(quote.gst_paise)} />}<Row strong label={<>Total{quote.on_tariff ? " · on tariff" : " · OFF tariff"}{l.quote_expires_at ? ` · valid till ${new Date(l.quote_expires_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}</>} value={inr(quote.total_paise)} />{quote.availability_conflicts?.length > 0 && <div className="muted" style={{ color: "var(--bad)" }}>⚠ {quote.availability_conflicts.length} room-night(s) already taken</div>}</div>}
        {l.status === "hold" && <div className="muted">Hold expires {new Date(l.hold_expires_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} · rooms blocked in inventory</div>}
        {l.status === "lost" && <div className="muted">Lost · reason: {l.lost_reason}</div>}
        {["new", "contacted", "quoted"].includes(l.status) && l.check_in && <div style={{ marginTop: "8px" }}><div className="sub">Quote rooms</div><div className="chips">{rooms.map((r) => <button type="button" key={r.id} className={`chip ${sel.includes(r.id) ? "on" : ""}`} onClick={() => setQuoteRooms({ ...quoteRooms, [l.id]: sel.includes(r.id) ? sel.filter((x) => x !== r.id) : [...sel, r.id] })}>{r.name}</button>)}</div></div>}
        <div className="actions end">
          {l.status === "new" && <Btn onClick={() => act(l.id, "contacted", undefined, "Marked contacted")}>Mark contacted</Btn>}
          {["new", "contacted", "quoted"].includes(l.status) && <Btn kind="primary" disabled={!l.check_in || sel.length === 0} onClick={async () => { const r: any = await act(l.id, "quote", { room_ids: sel }, "Quote composed"); if (r?.whatsapp_url) window.open(r.whatsapp_url, "_blank"); }}>Quote → WhatsApp</Btn>}
          {l.status === "quoted" && <Btn onClick={() => act(l.id, "hold", undefined, "Rooms held 48 h")}>Hold 48 h</Btn>}
          {["quoted", "hold"].includes(l.status) && <Btn kind="gold" onClick={() => act(l.id, "won", {}, "Won → booking created")}>Won → booking</Btn>}
          {!["won", "lost"].includes(l.status) && <details><summary>Lost…</summary><div className="chips">{LOST.map(([v, lab]) => <button type="button" className="chip bad" key={v} onClick={() => act(l.id, "lost", { reason: v }, "Marked lost")}>{lab}</button>)}</div></details>}
        </div>
      </Card>;
    })}
    <Card title="Funnel · measured from the books" sub="conversion and revenue per source, not call counts">{!funnel.data ? <Loading /> : funnel.data.funnel.length === 0 ? <Empty>No leads yet.</Empty> : <table className="t"><thead><tr><th>Source</th><th className="num">Leads</th><th className="num">Open</th><th className="num">Won</th><th className="num">Lost</th><th className="num">Revenue</th></tr></thead><tbody>{funnel.data.funnel.map((f: any) => <tr key={f.source}><td>{f.source}</td><td className="num">{f.leads}</td><td className="num">{f.open}</td><td className="num">{f.won}</td><td className="num">{f.lost}</td><td className="num">{inr(f.revenue_paise)}</td></tr>)}</tbody></table>}</Card>
  </>;
}

export function Inbox({ refs }: { me: Me; refs: Ref }) {
  const [status, setStatus] = useState("pending");
  const q = useLoad(() => get(`/inbox?status=${status}`), [status]);
  const [pick, setPick] = useState<Record<string, string[]>>({});
  const [rate, setRate] = useState<Record<string, string>>({});
  const [paste, setPaste] = useState({ from: "", subject: "", text: "" });
  // Rooms automation would have chosen are preselected; a person only taps when the choice is not obvious.
  const chosen = (it: any): string[] => pick[it.id] ?? it.suggested_room_ids ?? [];
  const book = (it: any) => run(async () => {
    const rooms = chosen(it);
    const r = await post(`/inbox/${it.id}/approve`, { room_ids: rooms, ...(rate[it.id] ? { nightly_rate_paise: Math.round(Number(rate[it.id]) * 100) } : {}) });
    await q.reload();
    toast(it.kind === "cancellation" ? "Booking cancelled · rooms released" : r.booking?.status === "approved" ? "Booked · it is in Reservations" : `Booked · awaiting approval (${(r.booking?.approval?.reasons ?? []).join(", ")})`);
  });
  return <>
    <h2>Inbox — bookings <small>STAAH, SwiftBook and Airpay emails book, cancel and record themselves when the facts line up; the rest wait here for one tap</small></h2>
    <Chips value={status} options={[{ value: "pending", label: "Needs a person" }, { value: "approved", label: "Done · auto and approved" }, { value: "duplicate", label: "Already in the books" }, { value: "dismissed", label: "Dismissed" }]} onChange={setStatus} />
    {!q.data ? <Loading error={q.error} /> : q.data.items.length === 0 ? <Empty>Nothing to review.</Empty> : q.data.items.map((it: any) => {
      const d = it.parsed ?? {}; const sel = chosen(it); const opts: any[] = it.room_options ?? [];
      const selNames = opts.filter((o) => sel.includes(o.id)).map((o) => o.name).join(" + ");
      const nights = d.check_in && d.check_out ? Math.max(1, Math.round((Date.parse(d.check_out) - Date.parse(d.check_in)) / 86_400_000)) : null;
      const ratePaise = rate[it.id] ? Math.round(Number(rate[it.id]) * 100) : it.nightly_rate_paise;
      return <Card key={it.id} title={<>{d.guest_name ?? it.subject} <span className="muted">· {d.channel ?? it.source}</span> <Status s={it.auto_applied ? "auto" : it.status} />{d.confidence === "low" && <Status s="check parse" />}</>}
        sub={<>{d.check_in ? `${fmtDate(d.check_in)} → ${fmtDate(d.check_out)}${nights ? ` · ${nights} night${nights > 1 ? "s" : ""}` : ""}` : it.subject}{d.room_name ? ` · ${d.rooms ?? 1} × ${d.room_name}` : ""}{d.adults ? ` · ${d.adults} adult${d.adults > 1 ? "s" : ""}${d.children ? `, ${d.children} child${d.children > 1 ? "ren" : ""}` : ""}` : ""}{it.external_ref ? <> · ref <span className="mono">{it.external_ref}</span></> : ""}</>}
        tone={it.status === "pending" && it.auto_note ? "amb" : undefined}>
        {it.status === "pending" && it.auto_note && <div className="sub" style={{ marginBottom: "8px" }}><b>Waiting because:</b> {it.auto_note}</div>}
        {it.auto_applied === 1 && <div className="sub" style={{ marginBottom: "8px" }}>Applied automatically on arrival</div>}
        <div className="grid two">
          <div>
            {d.room_total_paise != null && <Row label={`Room total${d.room_total_is_ex_gst ? " (ex-GST)" : ""}`} value={inr(d.room_total_paise)} />}
            {d.total_incl_gst_paise != null && <Row label="Total incl. GST" value={inr(d.total_incl_gst_paise)} />}
            {d.commission_paise != null && <Row label="OTA commission" value={inr(d.commission_paise)} />}{d.commission_bp != null && <Row label="Commission" value={`${d.commission_bp / 100}%`} />}
            {d.collection_type && <Row label="Collection" value={d.collection_type.replace("_", " ")} />}
            {d.order_id && <Row label="Order" value={<span className="mono">{d.order_id}</span>} />}{d.amount_paise != null && <Row label="Amount" value={inr(d.amount_paise)} />}
            {it.status !== "pending" && <div className="sub">From {it.from_addr} · {it.subject}</div>}
          </div>
          {it.status === "pending" && it.kind === "new_reservation" && opts.length > 0 && <div>
            <div className="sub">Room for this stay · tap to change</div>
            <div className="chips">{opts.map((o) => <button type="button" key={o.id} className={`chip ${sel.includes(o.id) ? "on" : ""} ${o.free ? "" : "bad"}`} disabled={!o.free} title={o.free ? "free for these dates" : `taken by ${o.taken_by}`} onClick={() => setPick({ ...pick, [it.id]: sel.includes(o.id) ? sel.filter((x) => x !== o.id) : [...sel, o.id] })}>{o.name}{o.free ? "" : ` · ${o.taken_by}`}</button>)}</div>
            {opts.every((o) => !o.free) && <div className="sub" style={{ color: "var(--bad)" }}>Every room is taken for these dates. Free one up (cancel or move the booking holding it in Reservations), then come back and book.</div>}
            <Field label="Nightly rate ex-GST (₹)" hint={it.nightly_rate_paise ? `from the email: ${inr(it.nightly_rate_paise)}` : "the email carried no amount"}><input inputMode="decimal" value={rate[it.id] ?? (it.nightly_rate_paise ? String(it.nightly_rate_paise / 100) : "")} onChange={(e: any) => setRate({ ...rate, [it.id]: e.currentTarget.value })} /></Field>
          </div>}
        </div>
        {it.status === "pending" && <div className="actions end">
          <Btn kind="danger" onClick={() => run(async () => { await post(`/inbox/${it.id}/dismiss`, { reason: "manual" }); await q.reload(); }, "Dismissed")}>Dismiss</Btn>
          <Btn onClick={() => run(async () => { const r = await post(`/inbox/${it.id}/reparse`); await q.reload(); toast(r.auto?.applied ? `Applied automatically: ${r.auto.what}` : r.auto?.note ? `Read again · still waiting: ${r.auto.note}` : `Read again · ${r.status}`); })}>Re-read</Btn>
          {it.kind === "new_reservation" && <Btn kind="primary" disabled={sel.length === 0 || !ratePaise} onClick={() => book(it)}>{sel.length ? `Book ${selNames}${ratePaise ? ` @ ${inr(ratePaise)}/night` : ""}` : "Pick a room to book"}</Btn>}
          {it.kind === "cancellation" && <Btn kind="primary" onClick={() => book(it)}>Cancel the booking</Btn>}
        </div>}
        {it.booking_id && <div className="muted">Booking {it.booking_id}{it.booking_status ? ` · ${it.booking_status.replace("_", " ")}` : ""} · see Reservations</div>}
      </Card>;
    })}
    <Card title="Paste an email" sub="forwarded mail arrives on its own once Email Routing is on; paste one here to test, or when a notification went astray — same parser, same automation, same audit">
      <div className="grid two"><Field label="From"><input value={paste.from} onChange={(e: any) => setPaste({ ...paste, from: e.currentTarget.value })} placeholder="noreply@staah.com" /></Field><Field label="Subject"><input value={paste.subject} onChange={(e: any) => setPaste({ ...paste, subject: e.currentTarget.value })} /></Field></div>
      <Field label="Body (text)"><textarea rows={6} value={paste.text} onChange={(e: any) => setPaste({ ...paste, text: e.currentTarget.value })} /></Field>
      <div className="actions end"><Btn kind="primary" onClick={() => run(async () => { await post("/inbox/ingest", paste); setPaste({ from: "", subject: "", text: "" }); setStatus("pending"); await q.reload(); }, "Ingested")}>Ingest</Btn></div></Card>
    <span hidden>{refs.locations.length}</span>
  </>;
}

/* ---------- Reservations: the desk's most-used screen. Pick dates, see every room's state for those dates,
   tap the rooms, the money adds itself up, save. The list below is filterable and opens into a detail
   with the same room picker for amendments. ---------- */

const nightsOf = (ci: string, co: string) => ci && co && ci < co ? Math.round((Date.parse(co) - Date.parse(ci)) / 86_400_000) : 0;
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
const slabFor = (me: Me, tariff: number | null, rate: number) => { const d = tariff ?? rate; return !me.property.gstin || d <= me.property.gst_nil_upto_paise ? 0 : d <= me.property.gst_threshold_paise ? me.property.gst_rate_below_bp : me.property.gst_rate_above_bp; };
const CHANNEL_SHORT: Record<string, string> = { direct: "Direct", booking_com: "Booking.com", makemytrip: "MMT", goibibo: "Goibibo", agoda: "Agoda", cleartrip: "Cleartrip", expedia: "Expedia", yatra: "Yatra", swiftbook: "SwiftBook", referral: "Referral", agent: "Agent" };

/** Who holds each room for a stay, from the availability endpoint. */
function useHolders(checkIn: string, checkOut: string, ignoreBookingId?: string | null) {
  const n = nightsOf(checkIn, checkOut);
  const q = useLoad(() => n > 0 ? get(`/bookings/availability?from=${checkIn}&to=${addDays(checkOut, -1)}`) : Promise.resolve(null), [checkIn, checkOut]);
  const holders: Record<string, { name: string; kind: string }> = {};
  for (const t of q.data?.taken ?? []) { if (ignoreBookingId && t.booking_id === ignoreBookingId) continue; if (!holders[t.room_id]) holders[t.room_id] = { name: t.guest_name ?? (t.kind === "hold" ? "a quote on hold" : "another booking"), kind: t.kind }; }
  return { holders, loading: n > 0 && !q.data && !q.error, nights: n };
}

/**
 * Room picker: one tile per room showing its state for the chosen dates. Tap a free room to add it at tariff,
 * change the rate in place, tap again to remove. Taken rooms say who has them and cannot be picked.
 */
function RoomPicker({ me, rooms, checkIn, checkOut, sel, onChange, tariffFor, holders, loading }: { me: Me; rooms: Ref["locations"]; checkIn: string; checkOut: string; sel: Record<string, string>; onChange: (s: Record<string, string>) => void; tariffFor: (roomId: string, night: string) => number | null; holders: Record<string, { name: string; kind: string }>; loading: boolean }) {
  const n = nightsOf(checkIn, checkOut);
  if (n === 0) return <div className="roomgrid">{rooms.map((r) => <div key={r.id} className="roomtile idle"><b>{r.name}</b><span className="sub">{r.code} · pick dates to see availability</span></div>)}</div>;
  return <div className="roomgrid">{rooms.map((r) => {
    const t = tariffFor(r.id, checkIn); const held = holders[r.id]; const on = (sel[r.id] ?? "") !== "";
    const rate = on ? Math.round(Number(sel[r.id]) * 100) : 0; const slab = on ? slabFor(me, t, rate) : 0;
    const cls = `roomtile ${on ? "on" : held ? "taken" : "free"}`;
    const toggle = () => { if (held && !on) return; const next = { ...sel }; if (on) delete next[r.id]; else next[r.id] = t ? String(t / 100) : ""; onChange(next); };
    return <div key={r.id} className={cls}>
      <button type="button" className="tilehead" onClick={toggle} disabled={!!held && !on} aria-pressed={on}>
        <span><b>{r.name}</b><span className="sub">{r.code}{t ? ` · tariff ${inr(t)}/night` : " · no tariff set"}</span></span>
        <span className="state">{loading ? "…" : on ? "✓ in this booking" : held ? `${held.kind === "hold" ? "held" : "taken"} · ${held.name}` : "free"}</span>
      </button>
      {on && <div className="tilebody">
        <label className="field"><span>Rate per night, ex-GST (₹)</span><input inputMode="decimal" value={sel[r.id]} onChange={(e: any) => onChange({ ...sel, [r.id]: e.currentTarget.value })} /></label>
        <div className="sub">{n} night{n > 1 ? "s" : ""} × {inr(rate)} = <b>{inr(rate * n)}</b>{me.property.gstin ? ` · GST ${slab / 100}%` : ""}{t && rate < t ? " · below tariff" : t && rate > t ? " · above tariff" : ""}</div>
        <div className="actions">{t && rate !== t && <Btn small onClick={() => onChange({ ...sel, [r.id]: String(t / 100) })}>Use tariff</Btn>}<Btn small onClick={toggle}>Remove</Btn></div>
      </div>}
    </div>;
  })}</div>;
}

/** The money a stay adds up to, computed the way the server will. */
function stayTotals(me: Me, sel: Record<string, string>, checkIn: string, checkOut: string, tariffFor: (roomId: string, night: string) => number | null) {
  const n = nightsOf(checkIn, checkOut); let room = 0, gst = 0, below = false, noTariff = false;
  for (const [id, v] of Object.entries(sel)) { if (v === "") continue; const rate = Math.round(Number(v) * 100); const t = tariffFor(id, checkIn); if (t === null) noTariff = true; else if (rate < t) below = true; const sub = rate * n; room += sub; gst += Math.round(sub * slabFor(me, t, rate) / 10000); }
  return { nights: n, rooms: Object.values(sel).filter((v) => v !== "").length, room, gst, gross: room + gst, below, noTariff };
}

function SummaryBar({ t, me, isOta, label }: { t: ReturnType<typeof stayTotals>; me: Me; isOta: boolean; label?: string }) {
  if (!t.rooms) return null;
  const approval = isOta ? "OTA stay · approves itself" : t.below ? "below tariff · goes to the revenue desk" : t.noTariff ? "no tariff for these dates · goes to the revenue desk" : me.property.auto_approve_on_tariff ? "on tariff · approves itself" : "waits for approval";
  return <div className="sumbar"><div><small>{label ?? "This stay"}</small><b>{t.rooms} room{t.rooms > 1 ? "s" : ""} · {t.nights} night{t.nights > 1 ? "s" : ""}</b></div><div><small>Room total ex-GST</small><b>{inr(t.room)}</b></div><div><small>GST</small><b>{inr(t.gst)}</b></div><div className="gross"><small>Gross</small><b>{inr(t.gross)}</b></div><div className="appr"><Status s={isOta || (!t.below && !t.noTariff && me.property.auto_approve_on_tariff) ? "auto" : "pending"} /> <span className="sub">{approval}</span></div></div>;
}

export function Reservations({ me, refs }: { me: Me; refs: Ref }) {
  const q = useLoad(() => get("/bookings"), []);
  const rooms = refs.locations.filter((l) => l.kind === "room");
  const today = me.property.today;
  const [f, setF] = useState<any>({ guest_name: "", guest_phone: "", guest_email: "", notes: "", check_in: today, check_out: addDays(today, 1), adults: 2, children: 0, channel_code: "direct", rooms: {} as Record<string, string> });
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<"upcoming" | "inhouse" | "past" | "cancelled" | "all">("upcoming");
  const [search, setSearch] = useState("");
  const detail = useLoad(() => open ? get(`/bookings/${open}`) : Promise.resolve(null), [open]);
  const tariffFor = (roomId: string, night: string) => { let best: any = null; for (const c of refs.rate_cards) { if (c.room_id !== roomId) continue; if (c.from_date && night < c.from_date) continue; if (c.to_date && night > c.to_date) continue; if (!best || c.priority > best.priority) best = c; } return best?.rate_paise ?? null; };
  const av = useHolders(f.check_in, f.check_out);
  const totals = stayTotals(me, f.rooms, f.check_in, f.check_out, tariffFor);
  const channel = refs.channels.find((c) => c.code === f.channel_code);
  const isOta = !!channel && channel.collection_type !== "direct";
  const canSave = totals.rooms > 0 && totals.nights > 0 && f.guest_name.trim().length > 1 && Object.values(f.rooms as Record<string, string>).every((v) => v === "" || Number(v) >= 0);
  const save = () => run(async () => {
    const rs = Object.entries(f.rooms as Record<string, string>).filter(([, v]) => v !== "").map(([room_id, v]) => ({ room_id, nightly_rate_paise: Math.round(Number(v) * 100) }));
    const r = await post("/bookings", { ...f, rooms: rs });
    toast(r.booking.status === "approved" ? `Booked · ${inr(r.booking.grossPaise)} gross · approved` : `Booked · awaiting approval (${r.booking.approval.reasons.join(", ")})`);
    setF({ ...f, guest_name: "", guest_phone: "", guest_email: "", notes: "", rooms: {} }); await q.reload(); setOpen(r.booking.id);
  });
  const list: any[] = (q.data?.bookings ?? []).filter((b: any) => {
    if (search && !`${b.guest_name} ${b.guest_phone ?? ""} ${b.external_ref ?? ""}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === "all") return true;
    if (filter === "cancelled") return ["cancelled", "no_show"].includes(b.status);
    if (filter === "inhouse") return b.status === "checked_in";
    if (filter === "past") return b.status === "checked_out";
    return ["provisional", "approved"].includes(b.status) && b.check_out >= today;
  }).sort((a: any, b: any) => filter === "past" || filter === "cancelled" ? (a.check_in < b.check_in ? 1 : -1) : (a.check_in > b.check_in ? 1 : -1));
  const counts = { upcoming: (q.data?.bookings ?? []).filter((b: any) => ["provisional", "approved"].includes(b.status) && b.check_out >= today).length, inhouse: (q.data?.bookings ?? []).filter((b: any) => b.status === "checked_in").length };
  return <>
    <h2>Reservations <small>pick the dates, tap the rooms, the money adds itself up · on-tariff bookings approve themselves, exceptions go to the revenue desk</small></h2>
    <Card title="New booking" sub="three steps: the stay, the rooms, the guest">
      <div className="section"><div className="sectionhead"><b>1 · Stay</b><span className="sub">{totals.nights > 0 ? `${totals.nights} night${totals.nights > 1 ? "s" : ""} · ${fmtDate(f.check_in)} → ${fmtDate(f.check_out)}` : "check-out must be after check-in"}</span></div>
        <div className="form-grid four">
          <Field label="Check-in"><input type="date" value={f.check_in} onChange={(e: any) => { const ci = e.currentTarget.value; setF({ ...f, check_in: ci, check_out: f.check_out <= ci ? addDays(ci, 1) : f.check_out, rooms: {} }); }} /></Field>
          <Field label="Check-out"><input type="date" min={addDays(f.check_in, 1)} value={f.check_out} onChange={(e: any) => setF({ ...f, check_out: e.currentTarget.value, rooms: {} })} /></Field>
          <Field label="Adults"><input type="number" min="1" value={f.adults} onChange={(e: any) => setF({ ...f, adults: Number(e.currentTarget.value) })} /></Field>
          <Field label="Children"><input type="number" min="0" value={f.children} onChange={(e: any) => setF({ ...f, children: Number(e.currentTarget.value) })} /></Field>
        </div>
        <div className="sub" style={{ marginBottom: "6px" }}>Channel</div>
        <Chips value={f.channel_code} options={refs.channels.map((c) => ({ value: c.code, label: CHANNEL_SHORT[c.code] ?? c.name }))} onChange={(v) => setF({ ...f, channel_code: v })} />
      </div>
      <div className="section"><div className="sectionhead"><b>2 · Rooms</b><span className="sub">{totals.nights > 0 ? "tap a free room to add it at tariff; change the rate on the tile" : "set the dates first"}</span></div>
        <RoomPicker me={me} rooms={rooms} checkIn={f.check_in} checkOut={f.check_out} sel={f.rooms} onChange={(rs) => setF({ ...f, rooms: rs })} tariffFor={tariffFor} holders={av.holders} loading={av.loading} />
        <SummaryBar t={totals} me={me} isOta={isOta} />
      </div>
      <div className="section"><div className="sectionhead"><b>3 · Guest</b><span className="sub">name and phone are enough; the rest can follow</span></div>
        <div className="form-grid four">
          <Field label="Guest name"><input value={f.guest_name} onChange={(e: any) => setF({ ...f, guest_name: e.currentTarget.value })} placeholder="as on the ID" /></Field>
          <Field label="Phone"><input inputMode="tel" value={f.guest_phone} onChange={(e: any) => setF({ ...f, guest_phone: e.currentTarget.value })} /></Field>
          <Field label="Email"><input type="email" value={f.guest_email} onChange={(e: any) => setF({ ...f, guest_email: e.currentTarget.value })} /></Field>
          <Field label="Notes"><input value={f.notes} onChange={(e: any) => setF({ ...f, notes: e.currentTarget.value })} placeholder="early check-in, anniversary…" /></Field>
        </div>
      </div>
      <div className="actions end"><Btn kind="primary" disabled={!canSave} onClick={save}>{totals.rooms ? `Save booking · ${inr(totals.gross)} gross` : "Pick the rooms to save"}</Btn></div>
    </Card>

    <Card title={me.actor.role === "sales" ? "My bookings" : "Bookings"} actions={<input className="search" placeholder="Search guest, phone, reference" value={search} onChange={(e: any) => setSearch(e.currentTarget.value)} />}>
      <Chips value={filter} options={[{ value: "upcoming", label: `Upcoming · ${counts.upcoming}` }, { value: "inhouse", label: `In house · ${counts.inhouse}` }, { value: "past", label: "Past" }, { value: "cancelled", label: "Cancelled" }, { value: "all", label: "All" }]} onChange={setFilter} />
      {!q.data ? <Loading error={q.error} /> : list.length === 0 ? <Empty>{filter === "upcoming" ? "No upcoming stays." : "Nothing here."}</Empty> : <div className="table-wrap"><table className="t bookings"><thead><tr><th>Guest</th><th>Stay</th><th>Rooms</th><th>Channel</th><th className="num">Gross</th><th className="num">Balance</th><th>Status</th><th></th></tr></thead><tbody>{list.map((b: any) => <tr key={b.id} className={open === b.id ? "open" : ""} onClick={() => setOpen(open === b.id ? null : b.id)}>
        <td><b>{b.guest_name}</b>{b.guest_phone && <small>{b.guest_phone}</small>}</td>
        <td>{fmtDate(b.check_in)} → {fmtDate(b.check_out)}<small>{b.nights} night{b.nights > 1 ? "s" : ""}{b.external_ref ? ` · ref ${b.external_ref}` : ""}</small></td>
        <td><span className="roomchips">{String(b.room_names ?? "").split(", ").filter(Boolean).map((n: string) => <i key={n}>{n}</i>)}</span></td>
        <td>{CHANNEL_SHORT[b.channel_code] ?? b.channel_name}</td>
        <td className="num">{inr(b.gross_paise)}</td>
        <td className="num">{b.gross_paise - b.paid_paise > 0 ? <span style={{ color: "var(--amb)" }}>{inr(b.gross_paise - b.paid_paise)}</span> : <span className="muted">paid</span>}</td>
        <td><Status s={b.status} />{b.rate_vs_tariff === "below" && <> <Status s="below" /></>}</td>
        <td className="actions"><Btn small onClick={() => setOpen(open === b.id ? null : b.id)}>{open === b.id ? "Close" : "Open"}</Btn></td>
      </tr>)}</tbody></table></div>}
    </Card>

    {open && detail.data && <BookingDetail me={me} refs={refs} d={detail.data} rooms={rooms} tariffFor={tariffFor} onChange={async () => { await Promise.all([q.reload(), detail.reload()]); }} onClose={() => setOpen(null)} />}
  </>;
}

/** One booking: who, when, which rooms, what is owed; cancel or delete per the rules; amend with the same room picker. */
function BookingDetail({ me, refs, d, rooms, tariffFor, onChange, onClose }: { me: Me; refs: Ref; d: any; rooms: Ref["locations"]; tariffFor: (roomId: string, night: string) => number | null; onChange: () => Promise<void>; onClose: () => void }) {
  const b = d.booking; const live = ["provisional", "approved", "checked_in"].includes(b.status);
  const canDelete = b.status === "provisional" && (me.actor.role !== "sales" || b.created_by === me.actor.id) && d.paid_paise === 0;
  return <Card title={<>{d.guest.name} <Status s={b.status} />{b.rate_vs_tariff === "below" && <> <Status s="below" /></>}</>} sub={<>{fmtDate(b.check_in)} → {fmtDate(b.check_out)} · {b.nights} night{b.nights > 1 ? "s" : ""} · {d.channel.name}{b.external_ref ? ` · ref ${b.external_ref}` : ""} · {b.adults} adult{b.adults > 1 ? "s" : ""}{b.children ? `, ${b.children} child${b.children > 1 ? "ren" : ""}` : ""}{d.guest.phone ? ` · ${d.guest.phone}` : ""}</>}
    actions={<div className="actions"><Btn small onClick={onClose}>Close</Btn>{canDelete && <Btn small kind="danger" onClick={() => run(async () => { await del(`/bookings/${b.id}`); onClose(); await onChange(); }, "Deleted")}>Delete</Btn>}{["provisional", "approved"].includes(b.status) && <Btn small kind="danger" onClick={() => { const reason = prompt("Cancellation reason"); if (reason) run(async () => { await post(`/bookings/${b.id}/cancel`, { reason }); await onChange(); }, "Cancelled · rooms released"); }}>Cancel booking</Btn>}</div>}>
    <div className="grid two">
      <div>
        {d.rooms.map((r: any) => <Row key={r.id} label={<><b>{r.room_name}</b> · {r.nights} night{r.nights > 1 ? "s" : ""} @ {inr(r.nightly_rate_paise)}</>} sub={`${r.tariff_rate_paise ? `tariff ${inr(r.tariff_rate_paise)} · ` : ""}GST ${r.gst_rate_bp / 100}%`} value={inr(r.room_total_paise + r.gst_paise)} />)}
      </div>
      <div>
        <Row label="Gross" value={inr(b.gross_paise)} /><Row label="Paid" value={inr(d.paid_paise)} /><Row strong label="Balance" value={<span style={d.balance_paise > 0 ? { color: "var(--amb)" } : undefined}>{inr(d.balance_paise)}</span>} />
        {d.invoices.map((i: any) => <Row key={i.id} label={`Invoice ${i.number}`} sub={fmtDate(i.issued_on)} value={<Status s={i.status} />} />)}
        {d.approvals.filter((a: any) => a.status !== "auto").map((a: any) => <Row key={a.id} label={`${a.kind} approval`} sub={a.note} value={<Status s={a.status} />} />)}
      </div>
    </div>
    {b.notes && <div className="sub" style={{ whiteSpace: "pre-line", marginTop: "6px" }}>{b.notes}</div>}
    <details><summary>Audit trail ({d.audit.length})</summary>{d.audit.map((a: any) => <div className="muted" key={a.id}>{a.at} · {a.actor_email} · {a.action}{a.action === "booking.amend" && a.after_json ? ` · ${JSON.parse(a.after_json).remark ?? ""}` : ""}</div>)}</details>
    {live && <Amend key={b.id} me={me} d={d} rooms={rooms} refs={refs} tariffFor={tariffFor} onDone={onChange} />}
  </Card>;
}

/** Correct a booking in place: room exchange, dates, rates, guest, channel. A remark is required and lands in the audit trail. */
function Amend({ me, d, rooms, refs, tariffFor, onDone }: { me: Me; d: any; rooms: Ref["locations"]; refs: Ref; tariffFor: (roomId: string, night: string) => number | null; onDone: () => Promise<void> }) {
  const cur: Record<string, string> = {}; for (const r of d.rooms) cur[r.room_id] = String(r.nightly_rate_paise / 100);
  const [openA, setOpenA] = useState(false);
  const [a, setA] = useState<any>({ guest_name: d.guest.name, guest_phone: d.guest.phone ?? "", check_in: d.booking.check_in, check_out: d.booking.check_out, adults: d.booking.adults, children: d.booking.children, channel_code: d.channel.code, rooms: cur, remark: "" });
  const av = useHolders(a.check_in, a.check_out, d.booking.id);
  const totals = stayTotals(me, a.rooms, a.check_in, a.check_out, tariffFor);
  const channel = refs.channels.find((c) => c.code === a.channel_code);
  const changed = a.guest_name !== d.guest.name || a.guest_phone !== (d.guest.phone ?? "") || a.check_in !== d.booking.check_in || a.check_out !== d.booking.check_out || a.adults !== d.booking.adults || a.children !== d.booking.children || a.channel_code !== d.channel.code || JSON.stringify(a.rooms) !== JSON.stringify(cur);
  const save = () => run(async () => {
    const r = await post(`/bookings/${d.booking.id}/amend`, { ...a, rooms: Object.entries(a.rooms as Record<string, string>).filter(([, v]) => v !== "").map(([room_id, v]) => ({ room_id, nightly_rate_paise: Math.round(Number(v) * 100) })) });
    toast(r.booking.needsApproval ? `Amended · awaiting approval (${r.booking.approval.reasons.join(", ")})` : "Amended · audited · front desk notified");
    setOpenA(false); await onDone();
  });
  if (!openA) return <div className="actions end" style={{ marginTop: "12px" }}><Btn onClick={() => setOpenA(true)}>Amend this booking</Btn></div>;
  return <div className="amend">
    <div className="sectionhead"><b>Amend</b><span className="sub">room exchange, dates, rate, guest or channel · say why in the remark; the change is audited and the front desk is told</span></div>
    <div className="form-grid four">
      <Field label="Check-in"><input type="date" value={a.check_in} onChange={(e: any) => setA({ ...a, check_in: e.currentTarget.value })} /></Field>
      <Field label="Check-out"><input type="date" value={a.check_out} onChange={(e: any) => setA({ ...a, check_out: e.currentTarget.value })} /></Field>
      <Field label="Adults"><input type="number" min="1" value={a.adults} onChange={(e: any) => setA({ ...a, adults: Number(e.currentTarget.value) })} /></Field>
      <Field label="Children"><input type="number" min="0" value={a.children} onChange={(e: any) => setA({ ...a, children: Number(e.currentTarget.value) })} /></Field>
    </div>
    <RoomPicker me={me} rooms={rooms} checkIn={a.check_in} checkOut={a.check_out} sel={a.rooms} onChange={(rs) => setA({ ...a, rooms: rs })} tariffFor={tariffFor} holders={av.holders} loading={av.loading} />
    <SummaryBar t={totals} me={me} isOta={!!channel && channel.collection_type !== "direct"} label="After the change" />
    <div className="form-grid four">
      <Field label="Guest"><input value={a.guest_name} onChange={(e: any) => setA({ ...a, guest_name: e.currentTarget.value })} /></Field>
      <Field label="Phone"><input inputMode="tel" value={a.guest_phone} onChange={(e: any) => setA({ ...a, guest_phone: e.currentTarget.value })} /></Field>
      <Field label="Channel"><select value={a.channel_code} onChange={(e: any) => setA({ ...a, channel_code: e.currentTarget.value })}>{refs.channels.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></Field>
      <Field label="Remark (required)" hint="what was wrong and what changed"><input value={a.remark} onChange={(e: any) => setA({ ...a, remark: e.currentTarget.value })} placeholder="e.g. Cleartrip mapped the room type wrongly; moved to Superior" /></Field>
    </div>
    <div className="actions end"><Btn onClick={() => setOpenA(false)}>Discard</Btn><Btn kind="primary" disabled={!changed || a.remark.trim().length < 3 || totals.rooms === 0} onClick={save}>Save amendment</Btn></div>
  </div>;
}

export function Availability({ refs }: { me: Me; refs: Ref }) {
  const [from, setFrom] = useState(todayIso());
  const days = 14;
  const to = new Date(Date.parse(from) + (days - 1) * 86400000).toISOString().slice(0, 10);
  const q = useLoad(() => get(`/bookings/availability?from=${from}&to=${to}`), [from]);
  const nights = Array.from({ length: days }, (_, i) => new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10));
  return <>
    <h2>Availability <small>room-nights: booked, held (48 h) or free — the double-booking guard</small></h2>
    <div className="actions" style={{ marginBottom: "10px" }}><Btn onClick={() => setFrom(new Date(Date.parse(from) - days * 86400000).toISOString().slice(0, 10))}>← {days} d</Btn><input type="date" value={from} onChange={(e: any) => setFrom(e.currentTarget.value)} /><Btn onClick={() => setFrom(new Date(Date.parse(from) + days * 86400000).toISOString().slice(0, 10))}>{days} d →</Btn></div>
    {!q.data ? <Loading error={q.error} /> : <Card><div className="avail"><div className="r"><div className="n"></div>{nights.map((n) => <div className="c h" key={n}>{n.slice(8)}/{n.slice(5, 7)}</div>)}</div>
      {q.data.rooms.map((r: any) => <div className="r" key={r.id}><div className="n">{r.name}</div>{nights.map((n) => { const t = q.data.taken.find((x: any) => x.room_id === r.id && x.night === n); return <div key={n} className={`c ${t ? t.kind : ""}`} title={t ? `${t.kind} · ${t.guest_name ?? t.lead_id ?? ""}` : "free"}>{t ? (t.guest_name ?? "hold").slice(0, 3) : ""}</div>; })}</div>)}</div></Card>}
  </>;
}
export { patch as _p };
