import { Hono } from "hono";
import type { Env } from "../env";
import { Batch, HttpError, one, id } from "../db";
import { normalisePhone } from "../domain/ids";
import { notifyRole } from "../services/notify";

/**
 * Unauthenticated inbound hooks (lead sources). They are gated by a shared secret in the URL
 * (?key=) that the owner sets as HOOK_SECRET; each hook only ever creates a lead card.
 */
const r = new Hono<{ Bindings: Env }>();

async function createLeadFromHook(env: Env, propertyId: string, lead: { source: string; name: string; phone?: string | null; email?: string | null; check_in?: string | null; check_out?: string | null; rooms?: number | null; adults?: number | null; notes?: string | null; external_ref?: string | null; campaign?: string | null; utm_source?: string | null; utm_medium?: string | null; ad_name?: string | null }) {
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
  const clip = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);
  b.add("INSERT INTO leads (id, property_id, guest_id, source, status, check_in, check_out, rooms_wanted, adults, notes, assigned_to, external_ref, campaign, utm_source, utm_medium, ad_name) VALUES (?,?,?,?,'new',?,?,?,?,?,?,?,?,?,?,?)",
    lid, propertyId, guestId, lead.source, lead.check_in ?? null, lead.check_out ?? null, lead.rooms ?? 1, lead.adults ?? 2, lead.notes ?? null, sales?.id ?? null, lead.external_ref ?? null, clip(lead.campaign), clip(lead.utm_source), clip(lead.utm_medium), clip(lead.ad_name));
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
  const res = await createLeadFromHook(c.env, propertyId, { campaign: x.campaign ?? x.utm_campaign ?? null, utm_source: x.utm_source ?? null, utm_medium: x.utm_medium ?? null, ad_name: x.utm_content ?? x.ad ?? null, source: "website", name: String(x.name), phone: x.phone, email: x.email, check_in: x.check_in, check_out: x.check_out, rooms: x.rooms ? Number(x.rooms) : null, adults: x.adults ? Number(x.adults) : null, notes: x.message ?? x.notes ?? null });
  return c.json(res, res.duplicate ? 200 : 201);
});

/** Meta signs each webhook delivery with HMAC-SHA256 of the raw body using the app secret. */
async function metaSignatureOk(secret: string, header: string | undefined, raw: ArrayBuffer): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, raw));
  const want = header.slice(7).toLowerCase();
  const got = Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (want.length !== got.length) return false;
  let diff = 0; for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

/** Lead answers: Meta's standard question names plus the custom ones a form may carry; everything else goes into the notes. */
function leadFromFields(fieldData: { name: string; values?: string[] }[] | undefined, v: { leadgen_id?: string; platform?: string; form_id?: string; ad_name?: string; campaign_name?: string; adset_name?: string }) {
  const fields: Record<string, string> = {};
  for (const f of fieldData ?? []) fields[f.name.toLowerCase()] = Array.isArray(f.values) ? String(f.values[0] ?? "") : String((f as any).values ?? "");
  const pick = (...names: string[]) => { for (const n of names) if (fields[n]) return fields[n]; return null; };
  const known = new Set(["full_name", "first_name", "last_name", "name", "email", "phone_number", "phone", "check_in", "checkin", "check-in", "arrival", "check_out", "checkout", "check-out", "departure", "rooms", "number_of_rooms", "adults", "guests", "message", "notes", "requirements"]);
  const extras = Object.entries(fields).filter(([k, val]) => !known.has(k) && val).map(([k, val]) => `${k.replace(/_/g, " ")}: ${val}`);
  const first = pick("first_name"), last = pick("last_name");
  const name = pick("full_name", "name") ?? [first, last].filter(Boolean).join(" ") ?? "";
  const platform = /ig|instagram/i.test(v.platform ?? "") ? "instagram" : "facebook";
  const notes = [pick("message", "notes", "requirements"), ...extras, v.ad_name ? `ad: ${v.ad_name}` : null].filter(Boolean).join(" · ") || null;
  return { campaign: v.campaign_name ?? null, ad_name: v.ad_name ?? null, utm_source: platform, utm_medium: "lead_ad", source: platform, name: name || `Meta lead ${v.leadgen_id ?? ""}`.trim(), phone: pick("phone_number", "phone"), email: pick("email"), check_in: pick("check_in", "checkin", "check-in", "arrival"), check_out: pick("check_out", "checkout", "check-out", "departure"), rooms: Number(pick("rooms", "number_of_rooms") ?? "") || null, adults: Number(pick("adults", "guests") ?? "") || null, notes, external_ref: v.leadgen_id ? String(v.leadgen_id) : null };
}

/** The webhook only carries the lead id; the answers live in the Graph API behind a Page token with leads_retrieval. */
async function fetchMetaLead(env: Env, leadgenId: string): Promise<{ field_data?: { name: string; values?: string[] }[]; platform?: string; form_id?: string; ad_name?: string; campaign_name?: string; adset_name?: string } | null> {
  if (!env.META_PAGE_TOKEN) return null;
  const v = env.META_GRAPH_VERSION ?? "v21.0";
  const res = await fetch(`https://graph.facebook.com/${v}/${encodeURIComponent(leadgenId)}?fields=field_data,platform,form_id,ad_name,adset_name,campaign_name,created_time&access_token=${encodeURIComponent(env.META_PAGE_TOKEN)}`);
  if (!res.ok) { console.error("meta lead fetch failed", leadgenId, res.status, await res.text()); return null; }
  return await res.json();
}

/**
 * Meta Lead Ads webhook (Instagram and Facebook lead forms).
 * GET = the subscription handshake (verify token = HOOK_SECRET). POST = leadgen events: the signature is checked
 * against the app secret, the answers are fetched from the Graph API, and each lead becomes a card for sales.
 * A lead whose answers cannot be fetched still becomes a card, so nothing is lost; the id is on it.
 */
r.get("/leads/meta", (c) => {
  const secret = c.env.HOOK_SECRET;
  if (secret && c.req.query("hub.mode") === "subscribe" && c.req.query("hub.verify_token") === secret) return c.text(c.req.query("hub.challenge") ?? "");
  return c.text("forbidden", 403);
});
r.post("/leads/meta", async (c) => {
  const propertyId = gate(c);
  const raw = await c.req.arrayBuffer();
  if (c.env.META_APP_SECRET && !(await metaSignatureOk(c.env.META_APP_SECRET, c.req.header("x-hub-signature-256"), raw))) throw new HttpError(401, "bad signature");
  const payload: any = JSON.parse(new TextDecoder().decode(raw) || "{}");
  const out: unknown[] = [];
  for (const entry of payload.entry ?? []) for (const ch of entry.changes ?? []) {
    if (ch.field && ch.field !== "leadgen") continue;
    const v = ch.value ?? {};
    let detail: Awaited<ReturnType<typeof fetchMetaLead>> = Array.isArray(v.field_data) ? v : null;
    if (!detail && v.leadgen_id) detail = await fetchMetaLead(c.env, String(v.leadgen_id));
    const lead = leadFromFields(detail?.field_data, { leadgen_id: v.leadgen_id, platform: detail?.platform ?? v.platform, form_id: detail?.form_id ?? v.form_id, ad_name: detail?.ad_name, campaign_name: detail?.campaign_name, adset_name: detail?.adset_name });
    if (!detail) lead.notes = [lead.notes, `answers not fetched: open lead ${v.leadgen_id ?? "?"} in Meta Business Suite`].filter(Boolean).join(" · ");
    const res = await createLeadFromHook(c.env, propertyId, lead);
    out.push(res);
  }
  return c.json({ received: out.length, leads: out });
});

export default r;
