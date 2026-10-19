import { useState } from "preact/hooks";
import { get, post, patch, del } from "../api";
import { Card, Row, Btn, Chips, Field, Status, Empty, Loading, inr, fmtDate, fmtDateTime, useLoad, run, toast, thisPeriod } from "../ui";
import type { Me, Ref } from "../app";

export function Approvals({ me }: { me: Me; refs: Ref }) {
  const q = useLoad(() => get("/approvals"), []);
  const refunds = useLoad(() => get("/approvals?status=approved"), []);
  const decide = (id: string, verb: string, body?: unknown) => run(async () => { await post(`/approvals/${id}/${verb}`, body); await Promise.all([q.reload(), refunds.reload()]); }, verb === "approve" ? "Approved · audited" : "Returned");
  if (!q.data) return <Loading error={q.error} />;
  const toPay = (refunds.data?.approvals ?? []).filter((a: any) => a.kind === "refund");
  return <>
    <h2>Approvals <small>exceptions only — on-tariff bookings approve themselves</small></h2>
    {q.data.approvals.length === 0 ? <Empty>Nothing waiting. On-tariff bookings, parsed OTA reservations and settlements pass straight through, audited.</Empty> : q.data.approvals.map((a: any) => <Card key={a.id} tone="amb" title={<>{a.kind} · {a.summary}</>} sub={<>requested by {a.requested_name ?? "system"} · {fmtDateTime(a.created_at)} · {a.note ? `reason: ${a.note.replace(/_/g, " ")}` : ""}</>}>
      {a.amount_paise != null && <Row strong label="Amount" value={inr(a.amount_paise)} />}
      <div class="actions end"><Btn kind="danger" onClick={() => { const note = prompt("Return with a note"); if (note) decide(a.id, "return", { note }); }}>Return</Btn><Btn kind="primary" onClick={() => decide(a.id, "approve", {})}>Approve</Btn></div></Card>)}
    {me.actor.role === "owner" && toPay.length > 0 && <Card title="Refunds approved · make the bank transfer and record it">{toPay.map((a: any) => <div class="row" key={a.id}><div><div>{a.summary}</div><div class="sub">approved {fmtDateTime(a.decided_at)}</div></div><div class="actions"><b class="num">{inr(a.amount_paise)}</b><Btn small kind="primary" onClick={() => { const r = prompt("NEFT/UPI reference"); run(async () => { const res = await post(`/approvals/refunds/${a.id}/pay`, { reference: r }); if (res.invoice_to_credit) { await post(`/invoices/${res.invoice_to_credit.id}/credit-notes`, { reason: "refund on cancellation", total_paise: res.invoice_to_credit.suggested_total_paise, refund_payment_id: res.id }); toast("Refund recorded · credit note issued"); } else toast("Refund recorded"); await refunds.reload(); }); }}>Record transfer</Btn></div></div>)}</Card>}
    <Card title="Recent decisions · audit trail">{q.data.recent.length === 0 ? <Empty>None yet.</Empty> : q.data.recent.map((a: any) => <div class="row" key={a.id}><div><div>{a.summary}</div><div class="sub">{a.decided_name} · {fmtDateTime(a.decided_at)}{a.note ? ` · ${a.note}` : ""}</div></div><Status s={a.status} /></div>)}</Card>
  </>;
}

export function Payouts({ refs }: { me: Me; refs: Ref }) {
  const otaChannels = refs.channels.filter((c) => c.collection_type === "channel_collect");
  const [channel, setChannel] = useState(otaChannels[0]?.code ?? "booking_com");
  const un = useLoad(() => get(`/settlements/unsettled?channel=${channel}`), [channel]);
  const list = useLoad(() => get("/settlements"), []);
  const [sel, setSel] = useState<string[]>([]); const [preview, setPreview] = useState<any>(null); const [refn, setRefn] = useState(""); const [recv, setRecv] = useState(""); const [on, setOn] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const detail = useLoad(() => open ? get(`/settlements/${open}`) : Promise.resolve(null), [open]);
  const doPreview = () => run(async () => setPreview((await post("/settlements", { channel_code: channel, booking_ids: sel, preview: true })).preview));
  const create = () => run(async () => { const s = await post("/settlements", { channel_code: channel, booking_ids: sel, payout_ref: refn, payout_on: on || null, received_paise: recv ? Math.round(Number(recv) * 100) : undefined }); setSel([]); setPreview(null); setRefn(""); await Promise.all([un.reload(), list.reload()]); setOpen(s.id); }, "Settlement drafted · nothing posted yet");
  const settle = (id: string) => run(async () => { await post(`/settlements/${id}/settle`, {}); await Promise.all([list.reload(), un.reload(), detail.reload()]); }, "Settled · commission & fee posted once, stays settled");
  const undo = (id: string) => { const reason = prompt("Undo reason"); if (reason) run(async () => { await post(`/settlements/${id}/undo`, { reason }); await Promise.all([list.reload(), un.reload(), detail.reload()]); }, "Undone · every expense the settlement created removed"); };
  const ch = refs.channels.find((c) => c.code === channel);
  return <>
    <h2>OTA payouts <small>W4 · gross − commission − fee − TCS − TDS = received, to the paisa</small></h2>
    <Chips value={channel} options={otaChannels.map((c) => ({ value: c.code, label: c.name }))} onChange={(v) => { setChannel(v); setSel([]); setPreview(null); }} />
    {ch && <div class="muted">Terms: commission {ch.commission_bp / 100}% · payment fee {ch.payment_fee_bp / 100}% · TCS {ch.tcs_bp / 100}% · TDS {ch.tds_bp / 100}% (owner changes these under Settings)</div>}
    <div class="grid two">
      <Card title="Stays awaiting payout" sub="tick the stays on the OTA statement">{!un.data ? <Loading /> : un.data.stays.length === 0 ? <Empty>Nothing unsettled.</Empty> : un.data.stays.map((s: any) => <label class="row" key={s.id}><div><input type="checkbox" checked={sel.includes(s.id)} onChange={() => setSel(sel.includes(s.id) ? sel.filter((x) => x !== s.id) : [...sel, s.id])} /> {s.guest_name} · {fmtDate(s.check_in)}→{fmtDate(s.check_out)}<div class="sub">ref {s.external_ref}</div></div><b class="num">{inr(s.gross_paise)}</b></label>)}
        <div class="actions end"><Btn disabled={!sel.length} onClick={doPreview}>Compute</Btn></div></Card>
      <Card title={preview ? "Expected payout" : "Compute first"}>{preview && <>
        <Row label="Gross" value={inr(preview.grossPaise)} /><Row label={`Commission ${ch!.commission_bp / 100}%`} value={`− ${inr(preview.commissionPaise)}`} /><Row label={`Payment fee ${ch!.payment_fee_bp / 100}% of gross`} value={`− ${inr(preview.paymentFeePaise)}`} />
        {preview.tcsPaise > 0 && <Row label="TCS (recoverable credit)" value={`− ${inr(preview.tcsPaise)}`} />}{preview.tdsPaise > 0 && <Row label="TDS 194-O (recoverable credit)" value={`− ${inr(preview.tdsPaise)}`} />}
        <Row strong label="Expected" value={inr(preview.expectedPaise)} />
        <div class="grid two"><Field label="Payout reference"><input value={refn} onInput={(e: any) => setRefn(e.currentTarget.value)} placeholder="010649992418" /></Field><Field label="Payout date"><input type="date" value={on} onInput={(e: any) => setOn(e.currentTarget.value)} /></Field><Field label="Received (₹) — blank = expected"><input inputMode="decimal" value={recv} onInput={(e: any) => setRecv(e.currentTarget.value)} /></Field></div>
        <div class="actions end"><Btn kind="primary" disabled={!refn} onClick={create}>Draft settlement</Btn></div></>}</Card>
    </div>
    <Card title="Settlements">{!list.data ? <Loading /> : list.data.settlements.length === 0 ? <Empty>None yet.</Empty> : <table class="t"><thead><tr><th>Payout</th><th>Channel</th><th class="num">Stays</th><th class="num">Expected</th><th class="num">Received</th><th class="num">Variance</th><th>Status</th><th></th></tr></thead><tbody>{list.data.settlements.map((s: any) => <tr key={s.id}><td class="mono">{s.payout_ref}</td><td>{s.channel_name}</td><td class="num">{s.stays}</td><td class="num">{inr(s.expected_paise)}</td><td class="num">{inr(s.received_paise)}</td><td class="num">{inr(s.variance_paise)}</td><td><Status s={s.status} /></td><td class="actions"><Btn small onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? "Close" : "Open"}</Btn>{s.status === "draft" && <Btn small kind="primary" onClick={() => settle(s.id)}>Mark settled</Btn>}{s.status === "settled" && <Btn small kind="danger" onClick={() => undo(s.id)}>Undo</Btn>}</td></tr>)}</tbody></table>}</Card>
    {open && detail.data && <Card title={`Payout ${detail.data.settlement.payout_ref}`} sub={<>{detail.data.settlement.channel_name} · <Status s={detail.data.settlement.status} /></>}>
      <table class="t"><thead><tr><th>Stay</th><th class="num">Gross</th><th class="num">Commission</th><th class="num">Fee</th><th class="num">TCS</th><th class="num">TDS</th><th class="num">Net</th></tr></thead><tbody>{detail.data.items.map((i: any) => <tr key={i.booking_id}><td>{i.guest_name} · {fmtDate(i.check_out)}</td><td class="num">{inr(i.gross_paise)}</td><td class="num">{inr(i.commission_paise)}</td><td class="num">{inr(i.payment_fee_paise)}</td><td class="num">{inr(i.tcs_paise)}</td><td class="num">{inr(i.tds_paise)}</td><td class="num">{inr(i.net_paise)}</td></tr>)}</tbody></table>
      {detail.data.expenses.length > 0 && <div class="muted" style="margin-top:8px">Expenses this settlement created: {detail.data.expenses.map((e: any) => `${e.kind} ${inr(e.amount_paise)}${e.voided_at ? " (void)" : ""}`).join(" · ")}</div>}
    </Card>}
  </>;
}

export function Reconcile({ me, refs }: { me: Me; refs: Ref }) {
  const bank = refs.accounts.find((a) => a.kind === "bank");
  const [period, setPeriod] = useState(thisPeriod());
  const q = useLoad(() => get(`/recon?period=${period}`), [period]);
  const [text, setText] = useState("");
  const paste = () => run(async () => { const r = await post("/recon/paste", { account_id: bank?.id, text }); toast(`${r.inserted} line(s) read · ${r.duplicates} already seen · ${r.rejected.length} unreadable`); setText(""); await q.reload(); });
  const acceptAll = () => run(async () => { const ids = q.data.lines.filter((l: any) => l.status === "proposed").map((l: any) => l.id); const r = await post("/recon/accept", { line_ids: ids }); toast(`${r.accepted} accepted · written`); await q.reload(); });
  const tierLabel = (t: number | null) => ({ 1: "Tier 1 · UTR", 2: "Tier 2 · exact", 3: "Tier 3 · fee-tolerant", 4: "Tier 4 · OTA subset", 0: "manual" } as any)[t ?? -1] ?? "";
  return <>
    <h2>Smart Reconcile <small>W7 · four tiers; nothing writes until accepted · target &gt; 80% auto</small></h2>
    {me.actor.role === "revenue" && <div class="muted">You see bank credits. Debits (bank-paid expenses, refunds) are reconciled by the owner or the CA.</div>}
    <Card title={`Paste bank statement · ${bank?.name ?? "bank"}`} sub="date, description, debit, credit — tab, comma or pipe separated; lines already seen are skipped">
      <Field label=""><textarea rows={5} value={text} onInput={(e: any) => setText(e.currentTarget.value)} placeholder={"14/10/2026\tNEFT BOOKING.COM 010649992418\t\t30836.26"} /></Field><div class="actions end"><Btn onClick={() => setText("")}>Clear</Btn><Btn kind="primary" disabled={!text.trim()} onClick={paste}>Match</Btn></div></Card>
    <div class="actions" style="margin-bottom:10px"><Field label="Month"><input type="month" value={period} onInput={(e: any) => setPeriod(e.currentTarget.value)} /></Field>{q.data && <div class="kpi" style="flex:1"><div class="k"><small>Lines</small><b>{q.data.stats.total}</b></div><div class="k"><small>Matched</small><b>{q.data.stats.matched}</b></div><div class="k"><small>Proposed</small><b>{q.data.stats.proposed}</b></div><div class="k"><small>Auto rate</small><b>{q.data.stats.auto_rate}%</b></div></div>}</div>
    {!q.data ? <Loading error={q.error} /> : q.data.lines.length === 0 ? <Empty>No statement lines in {period}.</Empty> : <>
      <div class="actions end"><Btn kind="primary" disabled={!q.data.stats.proposed} onClick={acceptAll}>Accept all proposed ({q.data.stats.proposed})</Btn></div>
      {q.data.lines.map((l: any) => <Card key={l.id} tone={l.status === "matched" ? "ok" : l.status === "proposed" ? "amb" : l.status === "unmatched" ? "bad" : undefined} title={<>{l.description} <Status s={l.status} /></>} sub={<>{fmtDate(l.on_date)}{l.tier != null ? ` · ${tierLabel(l.tier)}` : ""}{l.match ? ` · ${l.match.label}` : ""}{l.match?.implied_fee_bp != null ? ` · implied fee ${(l.match.implied_fee_bp / 100).toFixed(2)}% (variance ${inr(l.match.variance_paise)} vs contracted)` : ""}{l.match?.stays ? ` · ${l.match.stays.length} stay(s)${l.match.partial ? " (subset)" : ""}` : ""}{l.reason ? ` · carried: ${l.reason}` : ""}</>} actions={<b class="num">{inr(l.amount_paise)}</b>}>
        <div class="actions end">{l.status === "proposed" && <Btn small kind="primary" onClick={() => run(async () => { await post("/recon/accept", { line_ids: [l.id] }); await q.reload(); }, "Accepted")}>Accept</Btn>}{l.status === "unmatched" && <Btn small onClick={() => { const reason = prompt("Explain or carry forward — reason"); if (reason) run(async () => { await post(`/recon/${l.id}/carry`, { reason }); await q.reload(); }, "Carried"); }}>Explain / carry</Btn>}{l.status === "unmatched" && <Btn small onClick={() => { const id = prompt("Match to record id (payment/transfer/settlement/expense id)"); const kind = id && prompt("Kind: payment | transfer | settlement | expense"); if (id && kind) run(async () => { await post(`/recon/${l.id}/match`, { kind, id }); await q.reload(); }, "Proposed · accept to write"); }}>Match manually</Btn>}{l.status === "matched" && <Btn small kind="danger" onClick={() => run(async () => { await post(`/recon/${l.id}/unmatch`); await q.reload(); }, "Unmatched")}>Unmatch</Btn>}</div></Card>)}</>}
  </>;
}

export function RevenueOverview({ me }: { me: Me; refs: Ref }) {
  const [period, setPeriod] = useState(thisPeriod());
  const q = useLoad(() => get(`/reports/revenue?period=${period}`), [period]);
  const pre = useLoad(() => get(`/reports/preclose?period=${period}`), [period]);
  const close = useLoad(() => get(`/close/${period}`), [period]);
  const preclear = (ack: boolean) => run(async () => { const note = ack ? prompt("Carry the remaining exceptions with a note") : null; if (ack && !note) return; await post(`/close/${period}/preclear`, ack ? { acknowledge: true, note } : {}); await close.reload(); }, "Pre-close cleared · handed to the CA");
  return <>
    <h2>Revenue overview <small>revenue oversight and the pre-close; full P&amp;L stays with the owner and the CA</small></h2>
    <Field label="Month"><input type="month" value={period} onInput={(e: any) => setPeriod(e.currentTarget.value)} /></Field>
    {!q.data ? <Loading error={q.error} /> : <>
      <div class="kpi"><div class="k"><small>Revenue (ex-GST)</small><b>{inr(q.data.taxable_paise)}</b></div><div class="k"><small>Direct share</small><b>{q.data.direct_share_pct}%</b></div><div class="k"><small>OTA clearing</small><b>{inr(q.data.ota_clearing.paise)}</b></div><div class="k"><small>Pending approvals</small><b>{q.data.pending_approvals}</b></div><div class="k"><small>Stays</small><b>{q.data.stays}</b></div></div>
      <Card title="By channel">{q.data.by_source.length === 0 ? <Empty>No checked-out stays in {period}.</Empty> : q.data.by_source.map((s: any) => <Row key={s.channel} label={`${s.channel} · ${s.stays} stay(s)`} value={inr(s.taxable_paise)} />)}{q.data.advances_for_future_stays.n > 0 && <div class="muted">Advances received this month for later stays: {inr(q.data.advances_for_future_stays.paise)} — GST time-of-supply item for the CA.</div>}</Card></>}
    {pre.data && close.data && <Card title={`Pre-close · ${period}`} sub={<>Month status: <Status s={close.data.lock.status} />{close.data.lock.version ? ` · pack v${close.data.lock.version}` : ""}</>}>
      {Object.entries(pre.data).filter(([k]) => k !== "period").map(([k, v]: any) => <Row key={k} label={k.replace(/_/g, " ")} value={<span style={v.length ? "color:var(--amb)" : "color:var(--ok)"}>{v.length}</span>} />)}
      {close.data.lock.status === "open" && <div class="actions end"><Btn onClick={() => preclear(true)}>Carry exceptions &amp; clear</Btn><Btn kind="primary" disabled={!close.data.clear} onClick={() => preclear(false)}>Approve for close</Btn></div>}
      <span hidden>{me.actor.id}</span></Card>}
  </>;
}

export function OwnerDashboard({ }: { me: Me; refs: Ref }) {
  const [period, setPeriod] = useState(thisPeriod());
  const q = useLoad(() => get(`/reports/owner?period=${period}`), [period]);
  const pnl = useLoad(() => get(`/reports/pnl?period=${period}`), [period]);
  const acc = useLoad(() => get("/payments/accounts"), []);
  return <>
    <h2>Owner dashboard <small>oversight · entries: bank payments only</small></h2>
    <Field label="Month"><input type="month" value={period} onInput={(e: any) => setPeriod(e.currentTarget.value)} /></Field>
    {!q.data ? <Loading error={q.error} /> : <>
      <div class="kpi"><div class="k"><small>Revenue (ex-GST)</small><b>{inr(q.data.revenue_paise)}</b></div><div class="k"><small>Expenses</small><b>{inr(q.data.expenses_paise)}</b></div><div class="k"><small>Operating result</small><b>{inr(q.data.operating_result_paise)}</b></div><div class="k"><small>OTA clearing</small><b>{inr(q.data.ota_clearing.paise)}</b></div><div class="k"><small>Month status</small><b><Status s={q.data.month.status} /></b></div></div>
      <div class="grid two">
        <Card title="Expenses by category">{!pnl.data ? <Loading /> : pnl.data.expenses.by_category.length === 0 ? <Empty>None.</Empty> : pnl.data.expenses.by_category.map((e: any) => <Row key={e.category + e.kind} label={`${e.category}${e.kind !== "normal" ? ` · ${e.kind.replace(/_/g, " ")}` : ""} · ${e.n}`} value={inr(e.amount_paise)} />)}{pnl.data && <Row strong label="OTA & gateway costs within the above" value={inr(pnl.data.expenses.ota_and_gateway_costs_paise)} />}</Card>
        <Card title="Cash position">{!acc.data ? <Loading /> : acc.data.accounts.map((a: any) => <Row key={a.id} label={a.name} sub={a.holder_role} value={inr(a.balance_paise)} />)}</Card>
      </div>
      <Card title="Who does what" sub="this org in one table">{q.data.who_does_what.map((u: any) => <Row key={u.name} label={{ sales: "Bookings & reservations", property: "Check-in/out, collections, tasks, petty cash", revenue: "Approvals, payouts, reconciliation, pre-close", owner: "Bank-paid expenses, oversight", accountant: "Month lock & GST filing" }[u.role as string]} value={u.name} />)}</Card></>}
  </>;
}

const BANK_CATS = [["utilities", "Power & utilities"], ["subscriptions", "Subscriptions"], ["professional", "Professional fees"], ["marketing", "Marketing"], ["salaries", "Salaries"], ["repairs", "Repairs"], ["misc", "Misc"]] as const;
export function BankExpenses({ refs }: { me: Me; refs: Ref }) {
  const [period, setPeriod] = useState(thisPeriod());
  const q = useLoad(() => get(`/expenses?scope=bank&period=${period}`), [period]);
  const bank = refs.accounts.find((a) => a.kind === "bank"); const petty = refs.accounts.find((a) => a.kind === "petty_cash");
  const [f, setF] = useState<any>({ category: "utilities", description: "", vendor_name: "", vendor_gstin: "", amount: "", reference: "", gst_rate_bp: 0 });
  const [top, setTop] = useState("");
  return <>
    <h2>Bank expenses <small>the owner's one entry duty · each carries its NEFT reference and auto-matches at reconciliation</small></h2>
    <div class="grid two">
      <Card title="New expense · paid by bank transfer"><Chips value={f.category} options={BANK_CATS.map(([v, l]) => ({ value: v, label: l }))} onChange={(v) => setF({ ...f, category: v })} />
        <div class="grid two"><Field label="Description"><input value={f.description} onInput={(e: any) => setF({ ...f, description: e.currentTarget.value })} placeholder="KSEB electricity · Sep" /></Field><Field label="Amount incl. GST (₹)"><input inputMode="decimal" value={f.amount} onInput={(e: any) => setF({ ...f, amount: e.currentTarget.value })} /></Field><Field label="Vendor"><input value={f.vendor_name} onInput={(e: any) => setF({ ...f, vendor_name: e.currentTarget.value })} /></Field><Field label="Vendor GSTIN"><input value={f.vendor_gstin} onInput={(e: any) => setF({ ...f, vendor_gstin: e.currentTarget.value })} /></Field><Field label="GST rate on the bill"><select value={f.gst_rate_bp} onChange={(e: any) => setF({ ...f, gst_rate_bp: Number(e.currentTarget.value) })}><option value={0}>none</option><option value={500}>5%</option><option value={1200}>12%</option><option value={1800}>18%</option><option value={2800}>28%</option></select></Field><Field label="Bank reference (NEFT/UPI)"><input value={f.reference} onInput={(e: any) => setF({ ...f, reference: e.currentTarget.value })} /></Field></div>
        <div class="actions end"><Btn kind="primary" disabled={!f.amount} onClick={() => run(async () => { await post("/expenses", { ...f, amount_paise: Math.round(Number(f.amount) * 100), account_id: bank?.id }); setF({ ...f, description: "", amount: "", reference: "" }); await q.reload(); }, "Recorded")}>Record</Btn></div></Card>
      <Card title="Petty-cash top-up" sub="a transfer from the bank to the property manager — not an expense"><Field label="Amount (₹)"><input inputMode="decimal" value={top} onInput={(e: any) => setTop(e.currentTarget.value)} /></Field><div class="actions end"><Btn kind="primary" disabled={!top} onClick={() => run(async () => { await post("/payments/transfers", { from_account_id: bank?.id, to_account_id: petty?.id, amount_paise: Math.round(Number(top) * 100) }); setTop(""); }, "Top-up recorded as a transfer")}>Top up petty cash</Btn></div></Card>
    </div>
    <Field label="Month"><input type="month" value={period} onInput={(e: any) => setPeriod(e.currentTarget.value)} /></Field>
    <Card title="This month · bank-paid">{!q.data ? <Loading error={q.error} /> : q.data.expenses.length === 0 ? <Empty>None in {period}.</Empty> : q.data.expenses.map((e: any) => <div class="row" key={e.id}><div><div>{e.description ?? e.category} {e.kind !== "normal" && <Status s={e.kind} />}{e.voided_at && <Status s="void" />}</div><div class="sub">{fmtDate(e.on_date)} · {e.vendor_name ?? "—"}{e.vendor_gstin ? " · GSTIN ✓" : ""}{e.reference ? ` · ${e.reference}` : ""}</div></div><div class="actions"><b class="num">{inr(e.amount_paise)}</b>{!e.voided_at && e.kind === "normal" && <Btn small kind="danger" onClick={() => { const reason = prompt("Void reason"); if (reason) run(async () => { await post(`/expenses/${e.id}/void`, { reason }); await q.reload(); }, "Voided"); }}>Void</Btn>}</div></div>)}</Card>
  </>;
}

export function Admin({ refs }: { me: Me; refs: Ref }) {
  const users = useLoad(() => get("/admin/users"), []);
  const prop = useLoad(() => get("/admin/property"), []);
  const [nu, setNu] = useState({ email: "", name: "", role: "sales" });
  const [p, setP] = useState<any>(null);
  const cur = p ?? prop.data?.property;
  const [rc, setRc] = useState({ room_id: refs.locations.find((l) => l.kind === "room")?.id ?? "", name: "Peak", rate: "", from_date: "", to_date: "", priority: 10 });
  return <>
    <h2>Settings &amp; users <small>owner only</small></h2>
    <div class="grid two">
      <Card title="Users" sub="each person signs in with their email and password; new people get a temporary password or a set-password link">{!users.data ? <Loading /> : users.data.users.map((u: any) => <div class="row" key={u.id}><div><div>{u.name} <span class="muted">· {u.role}</span>{!u.active && <Status s="inactive" />}</div><div class="sub">{u.email}</div></div><div class="actions"><select value={u.role} onChange={(e: any) => run(async () => { await patch(`/admin/users/${u.id}`, { role: e.currentTarget.value }); await users.reload(); }, "Role updated")}>{["sales", "property", "revenue", "owner", "accountant"].map((r) => <option value={r}>{r}</option>)}</select><Btn small onClick={() => run(async () => { await patch(`/admin/users/${u.id}`, { active: !u.active }); await users.reload(); })}>{u.active ? "Deactivate" : "Activate"}</Btn>
        <Btn small onClick={() => { const pw = prompt(`Temporary password for ${u.name} (they must change it at first sign-in, at least 10 characters)`); if (pw) run(async () => { await post(`/admin/users/${u.id}/set-password`, { password: pw }); }, "Temporary password set"); }}>Set password</Btn>
        <Btn small onClick={() => run(async () => { const r = await post(`/admin/users/${u.id}/password-link`); try { await navigator.clipboard.writeText(r.link); } catch {} prompt(`Set-password link for ${u.name} (valid 72 h, copied to clipboard). Send it to ${r.email}:`, r.link); })}>Password link</Btn>
        <Btn small kind="danger" onClick={() => run(async () => { await post(`/admin/users/${u.id}/sign-out-everywhere`); }, "Signed out on every device")}>Sign out all</Btn></div></div>)}
        <details><summary>Add user (their Cloudflare Access email)</summary><Field label="Email"><input value={nu.email} onInput={(e: any) => setNu({ ...nu, email: e.currentTarget.value })} /></Field><Field label="Name"><input value={nu.name} onInput={(e: any) => setNu({ ...nu, name: e.currentTarget.value })} /></Field><Field label="Role"><select value={nu.role} onChange={(e: any) => setNu({ ...nu, role: e.currentTarget.value })}>{["sales", "property", "revenue", "owner", "accountant"].map((r) => <option value={r}>{r}</option>)}</select></Field><div class="actions end"><Btn kind="primary" onClick={() => run(async () => { await post("/admin/users", nu); setNu({ email: "", name: "", role: "sales" }); await users.reload(); }, "User added")}>Add</Btn></div></details></Card>
      {cur && <Card title="Property & GST" sub={cur.gstin ? `GSTIN ${cur.gstin} · invoices carry GST` : "No GSTIN: invoices carry no GST. Register before go-live if turnover exceeds the threshold."}>
        <Field label="Legal name"><input value={cur.legal_name ?? ""} onInput={(e: any) => setP({ ...cur, legal_name: e.currentTarget.value })} /></Field><Field label="Address"><input value={cur.address ?? ""} onInput={(e: any) => setP({ ...cur, address: e.currentTarget.value })} /></Field>
        <Field label="GSTIN (blank until registered)"><input value={cur.gstin ?? ""} onInput={(e: any) => setP({ ...cur, gstin: e.currentTarget.value })} /></Field>
        <div class="grid two"><Field label="Slab threshold per room-night (₹)"><input inputMode="decimal" value={cur.gst_threshold_paise / 100} onInput={(e: any) => setP({ ...cur, gst_threshold_paise: Math.round(Number(e.currentTarget.value) * 100) })} /></Field><Field label="Rate at/below threshold (bp)"><input type="number" value={cur.gst_rate_below_bp} onInput={(e: any) => setP({ ...cur, gst_rate_below_bp: Number(e.currentTarget.value) })} /></Field><Field label="Rate above threshold (bp)"><input type="number" value={cur.gst_rate_above_bp} onInput={(e: any) => setP({ ...cur, gst_rate_above_bp: Number(e.currentTarget.value) })} /></Field><Field label="Auto-approve on-tariff bookings"><select value={cur.auto_approve_on_tariff ? "1" : "0"} onChange={(e: any) => setP({ ...cur, auto_approve_on_tariff: e.currentTarget.value === "1" ? 1 : 0 })}><option value="1">yes — exceptions only go to the revenue desk</option><option value="0">no — every booking waits</option></select></Field><Field label="Quote valid (h)"><input type="number" value={cur.quote_valid_hours} onInput={(e: any) => setP({ ...cur, quote_valid_hours: Number(e.currentTarget.value) })} /></Field><Field label="Hold (h)"><input type="number" value={cur.hold_hours} onInput={(e: any) => setP({ ...cur, hold_hours: Number(e.currentTarget.value) })} /></Field></div>
        <div class="actions end"><Btn kind="primary" onClick={() => run(async () => { const { id, created_at, name, timezone, fy_start_month, ...rest } = cur; await patch("/admin/property", { ...rest, auto_approve_on_tariff: !!rest.auto_approve_on_tariff }); setP(null); await prop.reload(); }, "Saved · audited")}>Save</Btn></div></Card>}
    </div>
    <div class="grid two">
      <Card title="Channels · payout terms" sub="commission base, fee, TCS and TDS per channel — the settlement formula reads these">{refs.channels.map((c) => <details key={c.id}><summary>{c.name} · {c.collection_type.replace("_", " ")} · {c.commission_bp / 100}% / fee {c.payment_fee_bp / 100}% / TCS {c.tcs_bp / 100}% / TDS {c.tds_bp / 100}%</summary><ChannelEdit c={c} /></details>)}</Card>
      <Card title="Tariff card" sub="per room; a dated card with higher priority overrides the standard rate">{refs.locations.filter((l) => l.kind === "room").map((r) => <div key={r.id}><b>{r.name}</b>{refs.rate_cards.filter((c) => c.room_id === r.id).map((c) => <div class="row" key={c.id}><div>{c.name}{c.from_date ? ` · ${fmtDate(c.from_date)} → ${fmtDate(c.to_date)}` : " · always"} · p{c.priority}</div><div class="actions"><b class="num">{inr(c.rate_paise)}</b><Btn small kind="danger" onClick={() => run(async () => { await del(`/admin/rate-cards/${c.id}`); location.reload(); }, "Removed")}>×</Btn></div></div>)}</div>)}
        <details><summary>Add card</summary><Field label="Room"><select value={rc.room_id} onChange={(e: any) => setRc({ ...rc, room_id: e.currentTarget.value })}>{refs.locations.filter((l) => l.kind === "room").map((r) => <option value={r.id}>{r.name}</option>)}</select></Field><div class="grid two"><Field label="Name"><input value={rc.name} onInput={(e: any) => setRc({ ...rc, name: e.currentTarget.value })} /></Field><Field label="Rate ex-GST (₹)"><input inputMode="decimal" value={rc.rate} onInput={(e: any) => setRc({ ...rc, rate: e.currentTarget.value })} /></Field><Field label="From"><input type="date" value={rc.from_date} onInput={(e: any) => setRc({ ...rc, from_date: e.currentTarget.value })} /></Field><Field label="To"><input type="date" value={rc.to_date} onInput={(e: any) => setRc({ ...rc, to_date: e.currentTarget.value })} /></Field></div><div class="actions end"><Btn kind="primary" onClick={() => run(async () => { await post("/admin/rate-cards", { room_id: rc.room_id, name: rc.name, rate_paise: Math.round(Number(rc.rate) * 100), from_date: rc.from_date || null, to_date: rc.to_date || null, priority: rc.priority }); location.reload(); }, "Card added")}>Add</Btn></div></details></Card>
    </div>
  </>;
}
function ChannelEdit({ c }: { c: any }) {
  const [f, setF] = useState({ commission_bp: c.commission_bp, payment_fee_bp: c.payment_fee_bp, tcs_bp: c.tcs_bp, tds_bp: c.tds_bp });
  return <div class="grid two">{(["commission_bp", "payment_fee_bp", "tcs_bp", "tds_bp"] as const).map((k) => <Field key={k} label={`${k.replace("_bp", "").replace("_", " ")} (bp: 2300 = 23%)`}><input type="number" value={(f as any)[k]} onInput={(e: any) => setF({ ...f, [k]: Number(e.currentTarget.value) })} /></Field>)}<div class="actions end"><Btn small kind="primary" onClick={() => run(async () => { await patch(`/admin/channels/${c.id}`, f); }, "Terms updated · audited")}>Save</Btn></div></div>;
}

export function MonthClose({ }: { me: Me; refs: Ref }) {
  const [period, setPeriod] = useState(thisPeriod());
  const q = useLoad(() => get(`/close/${period}`), [period]);
  const lock = () => run(async () => { const r = await post(`/close/${period}/lock`); toast(`Locked · pack v${r.version} stored`); await q.reload(); });
  const unlock = () => { const reason = prompt("Unlock reason (creates a revised pack on re-lock)"); if (reason) run(async () => { const r = await post(`/close/${period}/unlock`, { reason }); if (r.warning) alert("WARNING: GST was already filed for this period. The next lock produces a revised pack and an amendment will be needed."); await q.reload(); }, "Unlocked"); };
  return <>
    <h2>Month close <small>W9 · Trupti clears the pre-close; the CA locks by the 4th; the lock binds every role</small></h2>
    <Field label="Month"><input type="month" value={period} onInput={(e: any) => setPeriod(e.currentTarget.value)} /></Field>
    {!q.data ? <Loading error={q.error} /> : <>
      <Card title={<>{period} · <Status s={q.data.lock.status} /></>} sub={q.data.lock.status === "open" ? "waiting for the revenue desk to clear the pre-close" : q.data.lock.status === "precleared" ? `cleared by the revenue desk ${fmtDateTime(q.data.lock.precleared_at)}` : `locked ${fmtDateTime(q.data.lock.locked_at)} · v${q.data.lock.version}${q.data.lock.filed_at ? ` · filed ${fmtDateTime(q.data.lock.filed_at)}` : ""}`}>
        {Object.entries(q.data.exception_counts).map(([k, v]: any) => <Row key={k} label={k.replace(/_/g, " ")} value={<span style={v ? "color:var(--amb)" : "color:var(--ok)"}>{v}</span>} />)}
        <div class="actions end">{q.data.lock.status === "precleared" && <Btn kind="primary" onClick={lock}>Lock {period}</Btn>}{["locked", "filed"].includes(q.data.lock.status) && <Btn kind="danger" onClick={unlock}>Unlock (creates v{q.data.lock.version + 1} “revised”)</Btn>}</div></Card>
      <Card title="Statement packs" sub="stored immutably in R2; every version kept">{q.data.packs.length === 0 ? <Empty>No pack yet.</Empty> : q.data.packs.map((pk: any) => <div class="row" key={pk.id}><div><div>Pack v{pk.version}{pk.revised ? " · revised" : ""}</div><div class="sub">{fmtDateTime(pk.created_at)}</div></div><div class="actions">{Object.keys(JSON.parse(pk.keys_json)).map((f) => <a key={f} class="btn small" href={`/api/close/${period}/pack/${pk.version}/${f}`}>{f}</a>)}</div></div>)}</Card></>}
  </>;
}

export function GstSheet({ me }: { me: Me; refs: Ref }) {
  const [period, setPeriod] = useState(thisPeriod());
  const q = useLoad(() => get(`/close/${period}/gst`), [period]);
  const lock = useLoad(() => get(`/close/${period}`), [period]);
  return <>
    <h2>GST filing sheet <small>W10 · filing becomes review</small></h2>
    <Field label="Month"><input type="month" value={period} onInput={(e: any) => setPeriod(e.currentTarget.value)} /></Field>
    {!me.property.gstin && <div class="queue">No GSTIN on the property: nothing to file yet. Invoices carry no GST until the owner enters the GSTIN under Settings.</div>}
    {!q.data ? <Loading error={q.error} /> : <>
      <Card title="Output tax">{q.data.by_slab.map((s: any) => <Row key={s.rate_pct} label={`Taxable value @ ${s.rate_pct}% slab`} value={inr(s.taxable_paise)} sub={`GST ${inr(s.gst_paise)}`} />)}{q.data.credit_notes.taxable_paise > 0 && <Row label="Less credit notes" value={`− ${inr(q.data.credit_notes.taxable_paise)}`} sub={`GST − ${inr(q.data.credit_notes.gst_paise)}`} />}<Row strong label="Output GST" value={inr(q.data.output_gst_paise)} />
        {q.data.advances_received_for_future_stays.n > 0 && <div class="muted">Advances received this month for later stays: {inr(q.data.advances_received_for_future_stays.paise)} — confirm time-of-supply treatment.</div>}</Card>
      <div class="grid two"><Card title="TCS deducted by OTAs · accept on portal">{q.data.tcs.length === 0 ? <Empty>None.</Empty> : q.data.tcs.map((t: any) => <Row key={t.status} label={`${t.n} settlement(s) · ${t.status}`} value={inr(t.amount_paise)} />)}</Card><Card title="TDS 194-O · verify in 26AS / AIS">{q.data.tds.length === 0 ? <Empty>None.</Empty> : q.data.tds.map((t: any) => <Row key={t.status} label={`${t.n} settlement(s) · ${t.status}`} value={inr(t.amount_paise)} />)}</Card></div>
      <Card title="GST on purchases" sub={q.data.input_gst_on_purchases.note}><Row label={`${q.data.input_gst_on_purchases.n} bill(s) with GST`} value={inr(q.data.input_gst_on_purchases.gst_paise)} /></Card>
      {lock.data && <div class="actions end">{lock.data.lock.status === "locked" && <Btn kind="primary" onClick={() => run(async () => { await post(`/close/${period}/file`, {}); await lock.reload(); }, "Marked filed")}>Mark Filed</Btn>}{lock.data.lock.status === "filed" && <Status s="filed" />}</div>}
      <Card title="Change log · every edit in the month, who and when, before and after">{q.data.change_log.length === 0 ? <Empty>No edits.</Empty> : q.data.change_log.map((c: any) => <div class="row" key={c.id}><div><div>{c.action} · {c.entity} {c.entity_id}</div><div class="sub">{c.actor_email} · {fmtDateTime(c.at)}</div><div class="pre muted">{c.before_json ? `before ${c.before_json}` : ""} {c.after_json ? `after ${c.after_json}` : ""}</div></div></div>)}</Card></>}
  </>;
}

export function AuditLog({ }: { me: Me; refs: Ref }) {
  const [period, setPeriod] = useState(thisPeriod());
  const q = useLoad(() => get(`/reports/audit?period=${period}`), [period]);
  return <>
    <h2>Change log <small>who, when, before and after</small></h2>
    <Field label="Month"><input type="month" value={period} onInput={(e: any) => setPeriod(e.currentTarget.value)} /></Field>
    {!q.data ? <Loading error={q.error} /> : q.data.audit.length === 0 ? <Empty>Nothing in {period}.</Empty> : <Card>{q.data.audit.map((a: any) => <div class="row" key={a.id}><div><div>{a.action} · {a.entity} <span class="mono">{a.entity_id}</span></div><div class="sub">{a.actor_email} · {fmtDateTime(a.at)}</div>{(a.before_json || a.after_json) && <details><summary>detail</summary><div class="pre">{a.before_json && `before: ${a.before_json}\n`}{a.after_json && `after: ${a.after_json}`}</div></details>}</div></div>)}</Card>}
  </>;
}
