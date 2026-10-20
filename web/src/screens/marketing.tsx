import { useState } from "react";
import { get } from "../api";
import { Card, Chips, Empty, Loading, inr, useLoad } from "../ui";
import type { Me, Ref } from "../app";

/**
 * Marketing scorecard: what the agency's work turns into, measured from the books, not from their dashboard.
 * Leads by source and month, how fast sales answered, bookings and revenue those leads became, and the
 * marketing spend from the expense book, so cost per lead and cost per booking are real figures.
 */
const SOURCE_LABEL: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", website: "Website", whatsapp: "WhatsApp", phone: "Phone", walkin: "Walk-in", other: "Other" };
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
const pct = (a: number, b: number) => b ? `${Math.round((a / b) * 100)}%` : "—";
const money = (v: number | null) => v === null ? "—" : inr(v);

export function Marketing({ }: { me: Me; refs: Ref }) {
  const [months, setMonths] = useState("6");
  const q = useLoad(() => get(`/reports/marketing?months=${months}`), [months]);
  const d = q.data;
  const last = d?.per_month[d.per_month.length - 1];
  return <>
    <h2>Marketing scorecard <small>leads → answered → booked → revenue, against what marketing cost · the agency's results in your numbers</small></h2>
    <Chips value={months} options={[{ value: "3", label: "3 months" }, { value: "6", label: "6 months" }, { value: "12", label: "12 months" }]} onChange={setMonths} />
    {!d ? <Loading error={q.error} /> : <>
      <div className="kpi">
        <div className="k"><small>Leads · {d.months.length} months</small><b>{d.totals.leads}</b></div>
        <div className="k"><small>Answered within 1 h</small><b>{pct(d.totals.answered_1h, d.totals.leads)}</b></div>
        <div className="k"><small>Became bookings</small><b>{d.totals.won} <span className="sub">· {pct(d.totals.won, d.totals.leads)}</span></b></div>
        <div className="k"><small>Revenue from leads (gross)</small><b>{inr(d.totals.revenue_paise)}</b></div>
        <div className="k"><small>Marketing spend</small><b>{inr(d.totals.spend_paise)}</b></div>
        <div className="k"><small>Cost per lead</small><b>{money(d.totals.cost_per_lead_paise)}</b></div>
        <div className="k"><small>Cost per booking</small><b>{money(d.totals.cost_per_booking_paise)}</b></div>
      </div>

      <Card title="By month" sub={last ? `${monthLabel(last.month)}: ${last.leads} leads, ${last.won} booked, ${inr(last.revenue_paise)} revenue against ${inr(last.spend_paise)} spend` : undefined}>
        <div className="table-wrap"><table className="t"><thead><tr><th>Month</th><th className="num">Leads</th><th className="num">Answered ≤1 h</th><th className="num">Quoted</th><th className="num">Booked</th><th className="num">Lost</th><th className="num">Room-nights</th><th className="num">Revenue</th><th className="num">Spend</th><th className="num">Cost / lead</th><th className="num">Cost / booking</th><th className="num">₹ revenue per ₹ spent</th></tr></thead>
          <tbody>{d.per_month.map((m: any) => <tr key={m.month}><td>{monthLabel(m.month)}</td><td className="num">{m.leads}</td><td className="num">{pct(m.answered_1h, m.leads)}</td><td className="num">{m.quoted}</td><td className="num">{m.won}</td><td className="num">{m.lost}</td><td className="num">{m.room_nights}</td><td className="num">{inr(m.revenue_paise)}</td><td className="num">{inr(m.spend_paise)}</td><td className="num">{money(m.cost_per_lead_paise)}</td><td className="num">{money(m.cost_per_booking_paise)}</td><td className="num">{m.revenue_per_rupee ?? "—"}</td></tr>)}</tbody></table></div>
      </Card>

      <div className="grid two">
        <Card title="By source" sub="where the leads come from and which sources actually book">
          {d.by_source.length === 0 ? <Empty>No leads in this window.</Empty> : <div className="table-wrap"><table className="t"><thead><tr><th>Source</th><th className="num">Leads</th><th className="num">≤1 h</th><th className="num">Booked</th><th className="num">Conv.</th><th className="num">Nights</th><th className="num">Revenue</th></tr></thead>
            <tbody>{d.by_source.map((s: any) => <tr key={s.source}><td>{SOURCE_LABEL[s.source] ?? s.source}</td><td className="num">{s.leads}</td><td className="num">{pct(s.answered_1h, s.leads)}</td><td className="num">{s.won}</td><td className="num">{pct(s.won, s.leads)}</td><td className="num">{s.room_nights}</td><td className="num">{inr(s.revenue_paise)}</td></tr>)}</tbody></table></div>}
        </Card>
        <Card title="By campaign" sub="campaign comes in on the lead (website UTM, Meta campaign name, or typed by sales) and on the marketing expense line; '(no campaign)' means the tag was missing on one side">
          {d.by_campaign.length === 0 ? <Empty>No campaigns yet. Ask the agency to pass utm_campaign on the website form and to name Meta campaigns; tag marketing expenses with the same name.</Empty> : <div className="table-wrap"><table className="t"><thead><tr><th>Campaign</th><th className="num">Leads</th><th className="num">Booked</th><th className="num">Revenue</th><th className="num">Spend</th><th className="num">Cost / lead</th><th className="num">Cost / booking</th></tr></thead>
            <tbody>{d.by_campaign.map((c: any) => <tr key={c.campaign}><td>{c.campaign}{c.sources.length ? <small style={{ display: "block", color: "var(--muted)" }}>{c.sources.map((s: string) => SOURCE_LABEL[s] ?? s).join(", ")}</small> : null}</td><td className="num">{c.leads}</td><td className="num">{c.won}</td><td className="num">{inr(c.revenue_paise)}</td><td className="num">{inr(c.spend_paise)}</td><td className="num">{money(c.cost_per_lead_paise)}</td><td className="num">{money(c.cost_per_booking_paise)}</td></tr>)}</tbody></table></div>}
        </Card>
      </div>
      <div className="muted">Revenue is the gross of bookings that came from a lead; OTA bookings have no lead and are not counted here, see Revenue overview for the channel view. Spend is every expense in the "Marketing & advertising" category, petty or bank.</div>
    </>}
  </>;
}
