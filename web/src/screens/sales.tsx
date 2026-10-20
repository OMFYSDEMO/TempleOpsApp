import { useState } from "preact/hooks";
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
    <div class="actions" style="margin-bottom:10px"><Chips value={filter} options={[{ value: "", label: "Open" }, { value: "new", label: "New" }, { value: "quoted", label: "Quoted" }, { value: "hold", label: "Hold" }, { value: "won", label: "Won" }, { value: "lost", label: "Lost" }]} onChange={(v) => setFilter(v || null)} /><span class="spacer" /><Btn kind="primary" onClick={() => setShowNew(!showNew)}>+ Lead</Btn></div>
    {showNew && <Card title="New lead · 3 taps + a name"><Chips value={newLead.source} options={SOURCES.map(([v, l]) => ({ value: v, label: l }))} onChange={(v) => setNewLead({ ...newLead, source: v })} />
      <div class="grid two"><Field label="Name"><input value={newLead.name} onInput={(e: any) => setNewLead({ ...newLead, name: e.currentTarget.value })} /></Field><Field label="Phone"><input inputMode="tel" value={newLead.phone} onInput={(e: any) => setNewLead({ ...newLead, phone: e.currentTarget.value })} /></Field>
      <Field label="Check-in"><input type="date" value={newLead.check_in} onInput={(e: any) => setNewLead({ ...newLead, check_in: e.currentTarget.value })} /></Field><Field label="Check-out"><input type="date" value={newLead.check_out} onInput={(e: any) => setNewLead({ ...newLead, check_out: e.currentTarget.value })} /></Field>
      <Field label="Rooms"><input type="number" min="1" value={newLead.rooms_wanted} onInput={(e: any) => setNewLead({ ...newLead, rooms_wanted: Number(e.currentTarget.value) })} /></Field><Field label="Adults"><input type="number" min="1" value={newLead.adults} onInput={(e: any) => setNewLead({ ...newLead, adults: Number(e.currentTarget.value) })} /></Field></div>
      <div class="actions end"><Btn onClick={() => setShowNew(false)}>Cancel</Btn><Btn kind="primary" onClick={create}>Save lead</Btn></div></Card>}
    {!q.data ? <Loading error={q.error} /> : q.data.leads.length === 0 ? <Empty>No leads{filter ? ` in ${filter}` : " open"}.</Empty> : q.data.leads.map((l: any) => {
      const quote = l.quote_json ? JSON.parse(l.quote_json) : null;
      const overdue = l.status === "new" && Date.now() - new Date(l.created_at.replace(" ", "T") + "Z").getTime() > 15 * 60000;
      const sel = quoteRooms[l.id] ?? [];
      return <Card key={l.id} tone={overdue ? "bad" : undefined} title={<>{l.source} · {l.guest_name} <Status s={l.status} /></>} sub={<>age {ago(l.created_at)} · {l.assigned_name ?? "unassigned"}{overdue ? " · overdue" : ""} · {l.past_stays ? `${l.past_stays} past stay(s)` : "new guest (no stays yet)"}</>}>
        <div class="muted">{l.check_in ? `${fmtDate(l.check_in)} → ${fmtDate(l.check_out)}` : "dates not set"} · {l.rooms_wanted} room(s) · {l.adults} adults{l.guest_phone ? ` · +${l.guest_phone}` : ""}</div>
        {quote && <div style="margin-top:8px">{quote.lines.map((x: any) => <Row key={x.room_id} label={`${x.room_name} × ${x.nights} night(s) @ ${inr(x.nightly_rate_paise)}`} value={inr(x.room_total_paise)} />)}{quote.gst_paise > 0 && <Row label="GST" value={inr(quote.gst_paise)} />}<Row strong label={<>Total{quote.on_tariff ? " · on tariff" : " · OFF tariff"}{l.quote_expires_at ? ` · valid till ${new Date(l.quote_expires_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}</>} value={inr(quote.total_paise)} />{quote.availability_conflicts?.length > 0 && <div class="muted" style="color:var(--bad)">⚠ {quote.availability_conflicts.length} room-night(s) already taken</div>}</div>}
        {l.status === "hold" && <div class="muted">Hold expires {new Date(l.hold_expires_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} · rooms blocked in inventory</div>}
        {l.status === "lost" && <div class="muted">Lost · reason: {l.lost_reason}</div>}
        {["new", "contacted", "quoted"].includes(l.status) && l.check_in && <div style="margin-top:8px"><div class="sub">Quote rooms</div><div class="chips">{rooms.map((r) => <button type="button" key={r.id} class={`chip ${sel.includes(r.id) ? "on" : ""}`} onClick={() => setQuoteRooms({ ...quoteRooms, [l.id]: sel.includes(r.id) ? sel.filter((x) => x !== r.id) : [...sel, r.id] })}>{r.name}</button>)}</div></div>}
        <div class="actions end">
          {l.status === "new" && <Btn onClick={() => act(l.id, "contacted", undefined, "Marked contacted")}>Mark contacted</Btn>}
          {["new", "contacted", "quoted"].includes(l.status) && <Btn kind="primary" disabled={!l.check_in || sel.length === 0} onClick={async () => { const r: any = await act(l.id, "quote", { room_ids: sel }, "Quote composed"); if (r?.whatsapp_url) window.open(r.whatsapp_url, "_blank"); }}>Quote → WhatsApp</Btn>}
          {l.status === "quoted" && <Btn onClick={() => act(l.id, "hold", undefined, "Rooms held 48 h")}>Hold 48 h</Btn>}
          {["quoted", "hold"].includes(l.status) && <Btn kind="gold" onClick={() => act(l.id, "won", {}, "Won → booking created")}>Won → booking</Btn>}
          {!["won", "lost"].includes(l.status) && <details><summary>Lost…</summary><div class="chips">{LOST.map(([v, lab]) => <button type="button" class="chip bad" key={v} onClick={() => act(l.id, "lost", { reason: v }, "Marked lost")}>{lab}</button>)}</div></details>}
        </div>
      </Card>;
    })}
    <Card title="Funnel · measured from the books" sub="conversion and revenue per source, not call counts">{!funnel.data ? <Loading /> : funnel.data.funnel.length === 0 ? <Empty>No leads yet.</Empty> : <table class="t"><thead><tr><th>Source</th><th class="num">Leads</th><th class="num">Open</th><th class="num">Won</th><th class="num">Lost</th><th class="num">Revenue</th></tr></thead><tbody>{funnel.data.funnel.map((f: any) => <tr key={f.source}><td>{f.source}</td><td class="num">{f.leads}</td><td class="num">{f.open}</td><td class="num">{f.won}</td><td class="num">{f.lost}</td><td class="num">{inr(f.revenue_paise)}</td></tr>)}</tbody></table>}</Card>
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
      return <Card key={it.id} title={<>{d.guest_name ?? it.subject} <span class="muted">· {d.channel ?? it.source}</span> <Status s={it.auto_applied ? "auto" : it.status} />{d.confidence === "low" && <Status s="check parse" />}</>}
        sub={<>{d.check_in ? `${fmtDate(d.check_in)} → ${fmtDate(d.check_out)}${nights ? ` · ${nights} night${nights > 1 ? "s" : ""}` : ""}` : it.subject}{d.room_name ? ` · ${d.rooms ?? 1} × ${d.room_name}` : ""}{d.adults ? ` · ${d.adults} adult${d.adults > 1 ? "s" : ""}${d.children ? `, ${d.children} child${d.children > 1 ? "ren" : ""}` : ""}` : ""}{it.external_ref ? <> · ref <span class="mono">{it.external_ref}</span></> : ""}</>}
        tone={it.status === "pending" && it.auto_note ? "amb" : undefined}>
        {it.status === "pending" && it.auto_note && <div class="sub" style="margin-bottom:8px"><b>Waiting because:</b> {it.auto_note}</div>}
        {it.auto_applied === 1 && <div class="sub" style="margin-bottom:8px">Applied automatically on arrival</div>}
        <div class="grid two">
          <div>
            {d.room_total_paise != null && <Row label={`Room total${d.room_total_is_ex_gst ? " (ex-GST)" : ""}`} value={inr(d.room_total_paise)} />}
            {d.total_incl_gst_paise != null && <Row label="Total incl. GST" value={inr(d.total_incl_gst_paise)} />}
            {d.commission_paise != null && <Row label="OTA commission" value={inr(d.commission_paise)} />}{d.commission_bp != null && <Row label="Commission" value={`${d.commission_bp / 100}%`} />}
            {d.collection_type && <Row label="Collection" value={d.collection_type.replace("_", " ")} />}
            {d.order_id && <Row label="Order" value={<span class="mono">{d.order_id}</span>} />}{d.amount_paise != null && <Row label="Amount" value={inr(d.amount_paise)} />}
            {it.status !== "pending" && <div class="sub">From {it.from_addr} · {it.subject}</div>}
          </div>
          {it.status === "pending" && it.kind === "new_reservation" && opts.length > 0 && <div>
            <div class="sub">Room for this stay · tap to change</div>
            <div class="chips">{opts.map((o) => <button type="button" key={o.id} class={`chip ${sel.includes(o.id) ? "on" : ""} ${o.free ? "" : "bad"}`} disabled={!o.free} title={o.free ? "free for these dates" : `taken by ${o.taken_by}`} onClick={() => setPick({ ...pick, [it.id]: sel.includes(o.id) ? sel.filter((x) => x !== o.id) : [...sel, o.id] })}>{o.name}{o.free ? "" : ` · ${o.taken_by}`}</button>)}</div>
            {opts.every((o) => !o.free) && <div class="sub" style="color:var(--bad)">Every room is taken for these dates. Free one up (cancel or move the booking holding it in Reservations), then come back and book.</div>}
            <Field label="Nightly rate ex-GST (₹)" hint={it.nightly_rate_paise ? `from the email: ${inr(it.nightly_rate_paise)}` : "the email carried no amount"}><input inputMode="decimal" value={rate[it.id] ?? (it.nightly_rate_paise ? String(it.nightly_rate_paise / 100) : "")} onInput={(e: any) => setRate({ ...rate, [it.id]: e.currentTarget.value })} /></Field>
          </div>}
        </div>
        {it.status === "pending" && <div class="actions end">
          <Btn kind="danger" onClick={() => run(async () => { await post(`/inbox/${it.id}/dismiss`, { reason: "manual" }); await q.reload(); }, "Dismissed")}>Dismiss</Btn>
          <Btn onClick={() => run(async () => { const r = await post(`/inbox/${it.id}/reparse`); await q.reload(); toast(r.auto?.applied ? `Applied automatically: ${r.auto.what}` : r.auto?.note ? `Read again · still waiting: ${r.auto.note}` : `Read again · ${r.status}`); })}>Re-read</Btn>
          {it.kind === "new_reservation" && <Btn kind="primary" disabled={sel.length === 0 || !ratePaise} onClick={() => book(it)}>{sel.length ? `Book ${selNames}${ratePaise ? ` @ ${inr(ratePaise)}/night` : ""}` : "Pick a room to book"}</Btn>}
          {it.kind === "cancellation" && <Btn kind="primary" onClick={() => book(it)}>Cancel the booking</Btn>}
        </div>}
        {it.booking_id && <div class="muted">Booking {it.booking_id}{it.booking_status ? ` · ${it.booking_status.replace("_", " ")}` : ""} · see Reservations</div>}
      </Card>;
    })}
    <Card title="Paste an email" sub="forwarded mail arrives on its own once Email Routing is on; paste one here to test, or when a notification went astray — same parser, same automation, same audit">
      <div class="grid two"><Field label="From"><input value={paste.from} onInput={(e: any) => setPaste({ ...paste, from: e.currentTarget.value })} placeholder="noreply@staah.com" /></Field><Field label="Subject"><input value={paste.subject} onInput={(e: any) => setPaste({ ...paste, subject: e.currentTarget.value })} /></Field></div>
      <Field label="Body (text)"><textarea rows={6} value={paste.text} onInput={(e: any) => setPaste({ ...paste, text: e.currentTarget.value })} /></Field>
      <div class="actions end"><Btn kind="primary" onClick={() => run(async () => { await post("/inbox/ingest", paste); setPaste({ from: "", subject: "", text: "" }); setStatus("pending"); await q.reload(); }, "Ingested")}>Ingest</Btn></div></Card>
    <span hidden>{refs.locations.length}</span>
  </>;
}

export function Reservations({ me, refs }: { me: Me; refs: Ref }) {
  const q = useLoad(() => get("/bookings"), []);
  const rooms = refs.locations.filter((l) => l.kind === "room");
  const [f, setF] = useState<any>({ guest_name: "", guest_phone: "", check_in: "", check_out: "", adults: 2, channel_code: "direct", rooms: {} as Record<string, string> });
  const [open, setOpen] = useState<string | null>(null);
  const detail = useLoad(() => open ? get(`/bookings/${open}`) : Promise.resolve(null), [open]);
  const tariffFor = (roomId: string, night: string) => { let best: any = null; for (const c of refs.rate_cards) { if (c.room_id !== roomId) continue; if (c.from_date && night < c.from_date) continue; if (c.to_date && night > c.to_date) continue; if (!best || c.priority > best.priority) best = c; } return best?.rate_paise ?? null; };
  const save = () => run(async () => {
    const rs = Object.entries(f.rooms).filter(([, v]) => v !== "").map(([room_id, v]) => ({ room_id, nightly_rate_paise: Math.round(Number(v) * 100) }));
    const r = await post("/bookings", { ...f, rooms: rs });
    toast(r.booking.status === "approved" ? "Booking approved (on tariff)" : `Awaiting approval: ${r.booking.approval.reasons.join(", ")}`);
    setF({ ...f, guest_name: "", guest_phone: "", rooms: {} }); await q.reload();
  });
  return <>
    <h2>Reservations <small>W2 · typed once; on-tariff auto-approves, exceptions go to the revenue desk</small></h2>
    <Card title="New manual booking">
      <div class="grid two"><Field label="Guest"><input value={f.guest_name} onInput={(e: any) => setF({ ...f, guest_name: e.currentTarget.value })} /></Field><Field label="Phone"><input inputMode="tel" value={f.guest_phone} onInput={(e: any) => setF({ ...f, guest_phone: e.currentTarget.value })} /></Field>
      <Field label="Check-in"><input type="date" value={f.check_in} onInput={(e: any) => setF({ ...f, check_in: e.currentTarget.value })} /></Field><Field label="Check-out"><input type="date" value={f.check_out} onInput={(e: any) => setF({ ...f, check_out: e.currentTarget.value })} /></Field>
      <Field label="Channel"><select value={f.channel_code} onChange={(e: any) => setF({ ...f, channel_code: e.currentTarget.value })}>{refs.channels.map((c) => <option value={c.code}>{c.name}</option>)}</select></Field><Field label="Adults"><input type="number" min="1" value={f.adults} onInput={(e: any) => setF({ ...f, adults: Number(e.currentTarget.value) })} /></Field></div>
      <div class="sub">Rooms · nightly rate ex-GST (tariff prefilled when dates are set)</div>
      <div class="grid">{rooms.map((r) => { const t = f.check_in ? tariffFor(r.id, f.check_in) : null; return <Field key={r.id} label={`${r.name}${t ? ` · tariff ${inr(t)}` : ""}`}><div class="actions"><input inputMode="decimal" placeholder="— not booked —" value={f.rooms[r.id] ?? ""} onInput={(e: any) => setF({ ...f, rooms: { ...f.rooms, [r.id]: e.currentTarget.value } })} />{t && <Btn small onClick={() => setF({ ...f, rooms: { ...f.rooms, [r.id]: String(t / 100) } })}>tariff</Btn>}</div></Field>; })}</div>
      <div class="actions end"><Btn kind="primary" onClick={save}>Save booking</Btn></div></Card>
    <Card title={me.actor.role === "sales" ? "My bookings" : "Bookings"}>{!q.data ? <Loading error={q.error} /> : q.data.bookings.length === 0 ? <Empty>No bookings yet.</Empty> : <table class="t"><thead><tr><th>Guest</th><th>Channel</th><th>Stay</th><th>Rooms</th><th class="num">Gross</th><th class="num">Paid</th><th>Status</th><th></th></tr></thead><tbody>{q.data.bookings.map((b: any) => <tr key={b.id}><td>{b.guest_name}</td><td>{b.channel_name}</td><td>{fmtDate(b.check_in)} → {fmtDate(b.check_out)}</td><td>{b.room_names}</td><td class="num">{inr(b.gross_paise)}</td><td class="num">{inr(b.paid_paise)}</td><td><Status s={b.status} />{b.rate_vs_tariff !== "on" && <> <Status s={b.rate_vs_tariff} /></>}</td><td class="actions">
      <Btn small onClick={() => setOpen(open === b.id ? null : b.id)}>{open === b.id ? "Close" : "Open"}</Btn>
      {b.status === "provisional" && (me.actor.role !== "sales" || b.created_by === me.actor.id) && <Btn small kind="danger" onClick={() => run(async () => { await del(`/bookings/${b.id}`); await q.reload(); }, "Deleted")}>Delete</Btn>}
      {["provisional", "approved"].includes(b.status) && <Btn small kind="danger" onClick={() => { const reason = prompt("Cancellation reason"); if (reason) run(async () => { await post(`/bookings/${b.id}/cancel`, { reason }); await q.reload(); }, "Cancelled; inventory released"); }}>Cancel</Btn>}
    </td></tr>)}</tbody></table>}</Card>
    {open && detail.data && <Card title={`Booking ${open}`} sub={<>{detail.data.guest.name} · {detail.data.channel.name} · {detail.data.booking.approval_mode ?? ""}</>}>
      {detail.data.rooms.map((r: any) => <Row key={r.id} label={`${r.room_name} · ${r.nights} night(s) @ ${inr(r.nightly_rate_paise)}${r.tariff_rate_paise ? ` (tariff ${inr(r.tariff_rate_paise)})` : ""} · GST ${r.gst_rate_bp / 100}%`} value={inr(r.room_total_paise + r.gst_paise)} />)}
      <Row strong label="Gross" value={inr(detail.data.booking.gross_paise)} /><Row label="Paid" value={inr(detail.data.paid_paise)} /><Row strong label="Balance" value={inr(detail.data.balance_paise)} />
      {detail.data.approvals.map((a: any) => <div class="muted" key={a.id}>Approval: <Status s={a.status} /> {a.note}</div>)}
      <details><summary>Audit trail ({detail.data.audit.length})</summary>{detail.data.audit.map((a: any) => <div class="muted" key={a.id}>{a.at} · {a.actor_email} · {a.action}</div>)}</details>
    </Card>}
  </>;
}

export function Availability({ refs }: { me: Me; refs: Ref }) {
  const [from, setFrom] = useState(todayIso());
  const days = 14;
  const to = new Date(Date.parse(from) + (days - 1) * 86400000).toISOString().slice(0, 10);
  const q = useLoad(() => get(`/bookings/availability?from=${from}&to=${to}`), [from]);
  const nights = Array.from({ length: days }, (_, i) => new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10));
  return <>
    <h2>Availability <small>room-nights: booked, held (48 h) or free — the double-booking guard</small></h2>
    <div class="actions" style="margin-bottom:10px"><Btn onClick={() => setFrom(new Date(Date.parse(from) - days * 86400000).toISOString().slice(0, 10))}>← {days} d</Btn><input type="date" value={from} onInput={(e: any) => setFrom(e.currentTarget.value)} /><Btn onClick={() => setFrom(new Date(Date.parse(from) + days * 86400000).toISOString().slice(0, 10))}>{days} d →</Btn></div>
    {!q.data ? <Loading error={q.error} /> : <Card><div class="avail"><div class="r"><div class="n"></div>{nights.map((n) => <div class="c h" key={n}>{n.slice(8)}/{n.slice(5, 7)}</div>)}</div>
      {q.data.rooms.map((r: any) => <div class="r" key={r.id}><div class="n">{r.name}</div>{nights.map((n) => { const t = q.data.taken.find((x: any) => x.room_id === r.id && x.night === n); return <div key={n} class={`c ${t ? t.kind : ""}`} title={t ? `${t.kind} · ${t.guest_name ?? t.lead_id ?? ""}` : "free"}>{t ? (t.guest_name ?? "hold").slice(0, 3) : ""}</div>; })}</div>)}</div></Card>}
  </>;
}
export { patch as _p };
