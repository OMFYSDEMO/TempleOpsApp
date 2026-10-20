import { describe, it, expect, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";
import { seed, ok, sql } from "./helpers";

// Lead hooks: the website form and Meta (Instagram / Facebook) lead forms become lead cards for sales.
const KEY = "test-hook-key";
async function sign(body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("test-app-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return "sha256=" + Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("Lead hooks", () => {
  beforeAll(async () => { await seed(); });

  it("website enquiry: JSON or form-encoded, gated by the key, assigned to sales", async () => {
    expect((await SELF.fetch("http://x/hooks/leads/website?key=wrong", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Nobody" }) })).status).toBe(401);
    const r = await SELF.fetch(`http://x/hooks/leads/website?key=${KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Web Guest", phone: "9333333333", email: "web@example.com", check_in: "2027-03-01", check_out: "2027-03-03", rooms: 2, adults: 4, message: "Anniversary trip" }) });
    expect(r.status).toBe(201);
    const { id } = await r.json() as any;
    const lead = (await sql("SELECT source, status, check_in, rooms_wanted, adults, notes, assigned_to FROM leads WHERE id = ?", id))[0] as any;
    expect(lead).toMatchObject({ source: "website", status: "new", check_in: "2027-03-01", rooms_wanted: 2, adults: 4, notes: "Anniversary trip", assigned_to: "usr_prachi" });
    const f = await SELF.fetch(`http://x/hooks/leads/website?key=${KEY}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "name=Form+Guest&phone=9444444444&message=Weekend" });
    expect(f.status).toBe(201);
    const list = await ok("prachi", "GET", "/api/leads");
    expect(list.leads.find((l: any) => l.guest_name === "Form Guest")).toBeTruthy();
  });

  it("meta lead forms: handshake, signed deliveries only, answers mapped, duplicates ignored", async () => {
    const hs = await SELF.fetch(`http://x/hooks/leads/meta?hub.mode=subscribe&hub.verify_token=${KEY}&hub.challenge=12345`);
    expect(hs.status).toBe(200); expect(await hs.text()).toBe("12345");
    expect((await SELF.fetch(`http://x/hooks/leads/meta?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`)).status).toBe(403);
    const body = JSON.stringify({ object: "page", entry: [{ id: "1", changes: [{ field: "leadgen", value: { leadgen_id: "9001", platform: "ig", form_id: "77", field_data: [{ name: "full_name", values: ["Insta Guest"] }, { name: "phone_number", values: ["+919555555555"] }, { name: "email", values: ["ig@example.com"] }, { name: "check_in", values: ["2027-04-10"] }, { name: "check_out", values: ["2027-04-12"] }, { name: "how_many_rooms?", values: ["2"] }] } }] }] });
    expect((await SELF.fetch(`http://x/hooks/leads/meta?key=${KEY}`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef" }, body })).status).toBe(401);
    const r = await SELF.fetch(`http://x/hooks/leads/meta?key=${KEY}`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": await sign(body) }, body });
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.received).toBe(1); expect(j.leads[0].duplicate).toBe(false);
    const lead = (await sql("SELECT l.source, l.check_in, l.check_out, l.notes, l.external_ref, g.name, g.phone, g.email FROM leads l JOIN guests g ON g.id = l.guest_id WHERE l.id = ?", j.leads[0].id))[0] as any;
    expect(lead).toMatchObject({ source: "instagram", check_in: "2027-04-10", check_out: "2027-04-12", external_ref: "9001", name: "Insta Guest", email: "ig@example.com" });
    expect(lead.notes).toMatch(/how many rooms\?: 2/);
    const again = await SELF.fetch(`http://x/hooks/leads/meta?key=${KEY}`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": await sign(body) }, body });
    expect((await again.json() as any).leads[0].duplicate).toBe(true);
    expect((await sql("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'lead_new' AND ref_id = ?", j.leads[0].id))[0].n).toBeGreaterThan(0);
  });
});
