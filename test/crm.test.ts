import { describe, it, expect, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";
import { seed, ok, sql } from "./helpers";
import { mapCrmLead } from "../src/routes/hooks";

/** The CRM (NeoDove) is the front door; its webhook opens lead cards here without duplicates. */
describe("CRM lead hook", () => {
  beforeAll(seed);
  const KEY = "test-hook-key";
  const post = (path: string, body: unknown) => SELF.fetch(`http://x/hooks/leads/${path}?key=${KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("maps the usual CRM field names, nested or flat, and normalises the source", () => {
    const m = mapCrmLead({ lead: { id: 88123, customer_name: "Neo Guest", mobile_number: "+91 95555 00001", lead_source: "Instagram", campaign_name: "Diwali 2026", disposition: "Interested", agent_name: "Prachi", remarks: "2 rooms, 25-27 Dec" }, custom_fields: { "Check In": "25/12/2026", "Check Out": "2026-12-27", Rooms: "2" } }, null);
    expect(m).toMatchObject({ name: "Neo Guest", phone: "+91 95555 00001", source: "instagram", campaign: "Diwali 2026", external_ref: "88123", check_in: "2026-12-25", check_out: "2026-12-27", rooms: 2, disposition: "Interested" });
    expect(m.notes).toContain("CRM stage: Interested"); expect(m.notes).toContain("CRM agent: Prachi");
    expect(mapCrmLead({ name: "X", phone: "9", source: "WA" }, null).source).toBe("whatsapp");
    expect(mapCrmLead({ name: "X", phone: "9", source: "Facebook Lead Ads" }, null).source).toBe("facebook");
    expect(mapCrmLead({ name: "X", phone: "9" }, "website").source).toBe("website");
    expect(mapCrmLead({ name: "X", phone: "9", source: "Justdial" }, null).source).toBe("other");
  });

  it("a delivery opens a lead for sales; the same CRM lead again updates it; a wrong key is refused; an empty payload is kept and skipped", async () => {
    expect((await SELF.fetch("http://x/hooks/leads/neodove?key=nope", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    const r = await post("neodove", { lead_id: "ND-1", name: "Neo Guest", mobile: "9555500001", source: "instagram", campaign: "Diwali 2026", disposition: "Interested", remarks: "wants sea view" });
    expect(r.status).toBe(201);
    const { id: leadId } = await r.json() as any;
    const lead = (await sql("SELECT source, status, campaign, external_ref, notes, assigned_to FROM leads WHERE id = ?", leadId))[0];
    expect(lead).toMatchObject({ source: "instagram", status: "new", campaign: "Diwali 2026", external_ref: "neodove:ND-1", assigned_to: "usr_prachi" });
    expect(lead.notes).toContain("wants sea view");
    // The CRM sends the same lead again at a later stage: one card, the note grows.
    const r2 = await post("neodove", { lead_id: "ND-1", name: "Neo Guest", mobile: "9555500001", source: "instagram", disposition: "Quote requested" });
    expect(r2.status).toBe(200); expect((await r2.json() as any).duplicate).toBe(true);
    expect((await sql("SELECT COUNT(*) AS n FROM leads WHERE external_ref = 'neodove:ND-1'"))[0].n).toBe(1);
    expect((await sql("SELECT notes FROM leads WHERE id = ?", leadId))[0].notes).toContain("CRM stage: Quote requested");
    // A different CRM id but the same phone within 30 days is the same person: no second card.
    const r3 = await post("crm", { id: "OTHER-9", full_name: "Neo Guest", phone: "+91 9555500001", channel: "whatsapp" });
    expect((await r3.json() as any).id).toBe(leadId);
    // Nothing usable → kept for inspection, no lead.
    const r4 = await post("neodove", { event: "lead.updated", foo: "bar" });
    expect(r4.status).toBe(202);
    const sales = await ok("prachi", "GET", "/api/leads");
    expect(sales.leads.filter((l: any) => l.guest_name === "Neo Guest")).toHaveLength(1);
    const recent = await (await SELF.fetch(`http://x/hooks/leads/crm/recent?key=${KEY}`)).json() as any;
    expect(recent.deliveries.map((d: any) => d.outcome)).toEqual(["skipped:no name or phone", "duplicate", "updated", "created"]);
    expect(recent.deliveries[3].payload.lead_id).toBe("ND-1");
  });
});
