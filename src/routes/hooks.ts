import { Hono } from "hono";
import type { Env } from "../env";
import { Batch, HttpError, one, id } from "../db";
import { normalisePhone } from "../domain/ids";
import { notifyRole } from "../services/notify";

/**
 * Unauthenticated inbound hooks (lead sources). They are gated by a shared secret in the URL
 * (?key=) that the owner sets as HOOK_SECRET; each hook only ever creates a lead card.
 */
const r = new Hono<{ Bindings: Env & { HOOK_SECRET?: string } }>();

async function createLeadFromHook(env: Env, propertyId: string, lead: { source: string; name: string; phone?: string | null; email?: string | null; check_in?: string | null; check_out?: string | null; rooms?: number | null; adults?: number | null; notes?: string | null; external_ref?: string | null }) {
  if (lead.external_ref) {
    const dup = await one(env.DB, "SELECT id FROM leads WHERE property_id = ? AND source = ? AND external_ref = ?", propertyId, lead.source, lead.external_ref);
    if (dup) return { id: (dup as any).id, duplicate: true };
  }
  const b = new Batch(env.DB, null);
  const phone = normalisePhone(lead.phone);
  let guestId = phone ? ((await one<{ id: string }>(env.DB, "SELECT id FROM guests WHERE property_id = ? AND phone = ?", propertyId, phone))?.id ?? null) : null;
  if (!guestId) { guestId = id("gst"); b.add("INSERT INTO guests (id, property_id, name, phone, email) VALUES (?,?,?,?,?)", guestId, propertyId, lead.name, phone, lead.email ?? null); }
  const sales = await one<{ id: string }>(env.DB, "SELECT id FROM users WHERE property_id = ? AND role = 'sales' AND active = 1 ORDER BY created_at LIMIT 1", propertyId);
  const lid = id("led");
  b.add("INSERT INTO leads (id, property_id, guest_id, source, status, check_in, check_out, rooms_wanted, adults, notes, assigned_to, external_ref) VALUES (?,?,?,?,'new',?,?,?,?,?,?,?)",
    lid, propertyId, guestId, lead.source, lead.check_in ?? null, lead.check_out ?? null, lead.rooms ?? 1, lead.adults ?? 2, lead.notes ?? null, sales?.id ?? null, lead.external_ref ?? null);
  await notifyRole(b, propertyId, "sales", "lead_new", `New ${lead.source} lead: ${lead.name}`, { kind: "lead", id: lid });
  b.audit("lead.create", "lead", lid, null, { source: lead.source, via: "hook" });
  await b.run();
  return { id: lid, duplicate: false };
}

function gate(c: any) {
  const secret = c.env.HOOK_SECRET;
  if (!secret || c.req.query("key") !== secret) throw new HttpError(401, "bad hook key");
  const propertyId = c.env.INBOX_PROPERTY_ID;
  if (!propertyId) throw new HttpError(500, "INBOX_PROPERTY_ID not configured");
  return propertyId;
}

/** Website enquiry form: POST JSON or form fields. */
r.post("/leads/website", async (c) => {
  const propertyId = gate(c);
  const ct = c.req.header("content-type") ?? "";
  const x: any = ct.includes("json") ? await c.req.json() : Object.fromEntries((await c.req.formData()).entries());
  if (!x.name) throw new HttpError(400, "name required");
  const res = await createLeadFromHook(c.env, propertyId, { source: "website", name: String(x.name), phone: x.phone, email: x.email, check_in: x.check_in, check_out: x.check_out, rooms: x.rooms ? Number(x.rooms) : null, adults: x.adults ? Number(x.adults) : null, notes: x.message ?? x.notes ?? null });
  return c.json(res, res.duplicate ? 200 : 201);
});

/** Meta Lead Ads webhook (Instagram/Facebook lead forms). GET = verification handshake; POST = leadgen events. */
r.get("/leads/meta", (c) => {
  const secret = c.env.HOOK_SECRET;
  if (c.req.query("hub.mode") === "subscribe" && c.req.query("hub.verify_token") === secret) return c.text(c.req.query("hub.challenge") ?? "");
  return c.text("forbidden", 403);
});
r.post("/leads/meta", async (c) => {
  const propertyId = gate(c);
  const payload: any = await c.req.json();
  const out: unknown[] = [];
  for (const entry of payload.entry ?? []) for (const ch of entry.changes ?? []) {
    const v = ch.value ?? {};
    // Meta sends leadgen_id; field values arrive only when the lead is retrieved via Graph API or when the page
    // is configured to push field_data. Both shapes are accepted; the card is created with whatever arrived.
    const fields: Record<string, string> = {};
    for (const f of v.field_data ?? []) fields[f.name] = Array.isArray(f.values) ? f.values[0] : f.values;
    const source = /instagram/i.test(v.platform ?? "") ? "instagram" : "facebook";
    const res = await createLeadFromHook(c.env, propertyId, { source, name: fields.full_name ?? fields.name ?? `Meta lead ${v.leadgen_id ?? ""}`.trim(), phone: fields.phone_number ?? fields.phone, email: fields.email, check_in: fields.check_in ?? null, check_out: fields.check_out ?? null, rooms: fields.rooms ? Number(fields.rooms) : null, notes: fields.message ?? null, external_ref: v.leadgen_id ? String(v.leadgen_id) : null });
    out.push(res);
  }
  return c.json({ received: out.length, leads: out });
});

export default r;
