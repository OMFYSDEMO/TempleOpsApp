import { useState } from "react";
import { get } from "../api";
import { Card, Btn, Status, Empty, Loading, useLoad, inr, fmtDateTime, ScrollX } from "../ui";
import type { Me, Ref } from "../app";

/** How long something has waited, in words a person reads at a glance. */
function age(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} d`;
}
const KIND_LABEL: Record<string, string> = { inbox: "Inbox", lead: "Lead", receipt: "Receipt", arrival: "Arrival", departure: "Departure", overstay: "Overstay", task: "Task", approval: "Approval", payout: "OTA payout", bank: "Bank line", lock: "Month lock", file: "GST filing", idproof: "ID proof", formc: "Form C", idarchive: "ID archive" };

function Item({ it, raised }: { it: any; raised?: boolean }) {
  return <div className="row">
    <div style={{ minWidth: 0 }}>
      <div><Status s={it.overdue ? "overdue" : "waiting"} /> <b>{it.title}</b></div>
      <div className="sub">{KIND_LABEL[it.kind] ?? it.kind} · waited {age(it.waited_hours)}{it.overdue ? ` · allowed ${it.tolerance_hours} h` : ` · due in ${age(Math.max(0, it.tolerance_hours - it.waited_hours))}`}{raised ? ` · on ${it.owner_role}` : ""}{it.escalated_to && !raised ? ` · raised to ${it.escalated_to} ${fmtDateTime(it.escalated_at)}` : ""}{it.sub ? ` · ${it.sub}` : ""}</div>
    </div>
    <div className="actions"><a className="btn small" href={it.href}>Open</a></div>
  </div>;
}

/** My work (W14): what is on this role right now, oldest and overdue first; what other roles let slip, for the owner. */
export function MyWork({ me }: { me: Me; refs: Ref }) {
  const q = useLoad(() => get("/work"), []);
  const [days, setDays] = useState(14);
  const slipsQ = useLoad(() => me.capabilities.includes("pnl_reports") ? get(`/work/slips?days=${days}`) : Promise.resolve(null), [days]);
  if (!q.data) return <Loading error={q.error} />;
  const { items, raised, overdue } = q.data;
  const first = me.actor.name.split(" ")[0];
  return <>
    <h1>My work <small>{items.length === 0 ? `Nothing waiting on you, ${first}.` : `${items.length} item${items.length > 1 ? "s" : ""} on you${overdue ? `, ${overdue} overdue` : ""}. Oldest first; nothing here is entered twice, it is what the books already know.`}</small></h1>
    <div className="kpi">
      <div className="k"><small>On you now</small><b>{items.length}</b></div>
      <div className="k"><small>Overdue</small><b style={overdue ? { color: "var(--bad)" } : undefined}>{overdue}</b></div>
      <div className="k"><small>Raised to you from other desks</small><b>{raised.length}</b></div>
    </div>
    {items.length > 0 && <Card title={overdue ? "Overdue, then waiting" : "Waiting on you"} sub="each item shows how long it has waited and how long it may wait before it is raised to the next desk" tone={overdue ? "amb" : undefined}>{items.map((it: any) => <Item key={it.key} it={it} />)}</Card>}
    {items.length === 0 && <Card><Empty>Nothing on your desk. New emails, leads, arrivals, approvals and tasks appear here the moment they exist.</Empty></Card>}
    {raised.length > 0 && <Card title={me.actor.role === "owner" ? "Overdue elsewhere" : "Raised to you"} sub={me.actor.role === "owner" ? "waited past its tolerance on another desk; the person responsible has been told once" : "past its tolerance on the desk below you; nudge, or do it"}>{raised.map((it: any) => <Item key={it.key} it={it} raised />)}</Card>}
    {me.capabilities.includes("pnl_reports") && <Card title={`What slipped · last ${days} days`} sub="every item that went overdue, who had it, how long it waited · the conversation to have is about patterns, not single items" actions={<div className="actions">{[7, 14, 30].map((d) => <Btn key={d} small kind={d === days ? "primary" : undefined} onClick={() => setDays(d)}>{d} d</Btn>)}</div>}>
      {!slipsQ.data ? <Loading /> : slipsQ.data.slips.length === 0 ? <Empty>Nothing slipped. That is the number to protect.</Empty> : <ScrollX><table className="t"><thead><tr><th>Item</th><th>Desk</th><th>Raised to</th><th className="num">Waited</th><th>Status</th></tr></thead><tbody>{slipsQ.data.slips.map((s: any) => <tr key={s.item_key}><td>{s.title}<div className="sub">{KIND_LABEL[s.kind] ?? s.kind} · {fmtDateTime(s.escalated_at)}</div></td><td>{s.owner_role}</td><td>{s.escalated_to}</td><td className="num">{age(s.waited_hours)}</td><td><Status s={s.cleared_at ? "done" : "open"} /></td></tr>)}</tbody></table></ScrollX>}
    </Card>}
    <span hidden>{inr(0)}</span>
  </>;
}
