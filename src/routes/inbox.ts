import { newRouter, requireCap, body, str, optStr, int, date } from "../app";
import { Batch, HttpError, all, one, id } from "../db";
import { nowIso } from "../domain/dates";
import { splitInclusive } from "../domain/money";
import { parseInboundEmail, PARSER_VERSION, type ParsedEmail } from "../email/parsers";
import { createBooking, gstPolicy } from "../services/bookings";
import { slabBpForRoomNight } from "../domain/gst";
import type { Env } from "../env";

const r = newRouter();
r.use("*", requireCap("inbox"));

r.get("/", async (c) => {
  const p = c.get("property");
  const status = c.req.query("status") ?? "pending";
  const rows = await all(c.env.DB, "SELECT * FROM inbox_items WHERE property_id = ? AND status = ? ORDER BY received_at DESC LIMIT 100", p.id, status);
  return c.json({ items: rows.map((x: any) => ({ ...x, parsed: x.parsed_json ? JSON.parse(x.parsed_json) : null })) });
});

/** Shared with the Email Worker: store an inbound email as an inbox item (duplicates flagged, payments routed). */
export async function ingestEmail(env: Env, propertyId: string, msg: { message_id: string | null; from: string; subject: string; html?: string; text?: string; raw?: ArrayBuffer | null; received_at?: string }) {
  const parsed = parseInboundEmail(msg.from, msg.subject, msg.html, msg.text);
  const iid = id("inb");
  let rawKey: string | null = null;
  if (msg.raw) { rawKey = `inbox/${propertyId}/${iid}.eml`; await env.FILES.put(rawKey, msg.raw, { httpMetadata: { contentType: "message/rfc822" } }); }
  let status = "pending";
  if (parsed.external_ref && parsed.kind === "new_reservation") {
    const dup = await one(env.DB, "SELECT b.id FROM bookings b JOIN channels ch ON ch.id = b.channel_id WHERE b.property_id = ? AND b.external_ref = ?", propertyId, parsed.external_ref);
    if (dup) status = "duplicate";
  }
  if (parsed.kind === "payment") status = "routed"; // Sindhu's Payments screen picks these up
  const b = new Batch(env.DB, null);
  b.add(`INSERT INTO inbox_items (id, property_id, source, kind, message_id, from_addr, subject, received_at, raw_key, parsed_json, parser_version, external_ref, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    iid, propertyId, parsed.source, parsed.kind, msg.message_id, msg.from, msg.subject, msg.received_at ?? nowIso(), rawKey, JSON.stringify({ ...parsed.data, confidence: parsed.confidence }), PARSER_VERSION, parsed.external_ref, status);
  b.audit("inbox.ingest", "inbox_item", iid, null, { source: parsed.source, kind: parsed.kind, status, confidence: parsed.confidence });
  await b.run();
  return { id: iid, status, parsed };
}

/** Manual ingest (paste an email) — the same code path the Email Worker uses, handy before DNS is set up. */
r.post("/ingest", async (c) => {
  const p = c.get("property");
  const x = await body(c);
  const res = await ingestEmail(c.env, p.id, { message_id: optStr(x.message_id, "message_id"), from: str(x.from, "from"), subject: str(x.subject, "subject"), html: optStr(x.html, "html") ?? undefined, text: optStr(x.text, "text") ?? undefined, raw: null });
  return c.json(res, 201);
});

/** Edit the parsed fields before approving (the mock's "Edit"). */
r.patch("/:id", async (c) => {
  const p = c.get("property"); const item: any = await one(c.env.DB, "SELECT * FROM inbox_items WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!item) throw new HttpError(404, "inbox item not found");
  if (item.status !== "pending") throw new HttpError(409, `item is ${item.status}`);
  const x = await body(c);
  const before = JSON.parse(item.parsed_json ?? "{}");
  const after = { ...before, ...x.parsed as object };
  const b = new Batch(c.env.DB, c.get("actor"));
  b.add("UPDATE inbox_items SET parsed_json = ?, external_ref = COALESCE(?, external_ref) WHERE id = ?", JSON.stringify(after), optStr(x.external_ref, "external_ref"), item.id);
  b.audit("inbox.edit", "inbox_item", item.id, before, after);
  await b.run();
  return c.json({ ok: true });
});

/** Approve: a reservation becomes a booking (through the shared path); a cancellation cancels its booking. */
r.post("/:id/approve", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const item: any = await one(c.env.DB, "SELECT * FROM inbox_items WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!item) throw new HttpError(404, "inbox item not found");
  if (item.status !== "pending") throw new HttpError(409, `item is ${item.status}`);
  const x = await body(c).catch(() => ({} as Record<string, unknown>));
  const d = { ...JSON.parse(item.parsed_json ?? "{}"), ...((x.parsed as object) ?? {}) };
  if (item.kind === "new_reservation") {
    const channelCode = str(x.channel_code ?? (item.source === "swiftbook" ? "swiftbook" : d.channel ? String(d.channel).toLowerCase().replace(/[^a-z]+/g, "_") : ""), "channel_code");
    const roomIds: string[] = Array.isArray(x.room_ids) ? x.room_ids.map(String) : [];
    if (!roomIds.length) throw new HttpError(400, "room_ids: pick the room(s) this reservation occupies");
    const checkIn = date(d.check_in, "check_in"), checkOut = date(d.check_out, "check_out");
    // Rate per room-night ex-GST. OTA totals usually arrive ex-GST; SwiftBook arrives inclusive, so split it.
    const nights = Math.max(1, Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000));
    let nightly: number;
    if (x.nightly_rate_paise !== undefined) nightly = int(x.nightly_rate_paise, "nightly_rate_paise", { min: 0 });
    else if (d.nightly_rate_paise) nightly = Number(d.nightly_rate_paise);
    else if (d.room_total_paise) nightly = Math.round(Number(d.room_total_paise) / (nights * roomIds.length));
    else if (d.total_incl_gst_paise) {
      const perNight = Math.round(Number(d.total_incl_gst_paise) / (nights * roomIds.length));
      const slab = slabBpForRoomNight(gstPolicy(p), perNight);
      nightly = splitInclusive(perNight, slab).ex;
    } else throw new HttpError(400, "nightly_rate_paise required: the email carried no amount");
    const result = await createBooking(c.env.DB, actor, p, {
      guest: { name: str(d.guest_name, "guest_name"), phone: d.guest_phone ?? null, email: d.guest_email ?? null },
      channelCode, externalRef: item.external_ref, checkIn, checkOut, rooms: roomIds.map((roomId) => ({ roomId, nightlyRatePaise: nightly })),
      inboxItemId: item.id, isOta: channelCode !== "direct", notes: `from ${item.source} email ${item.subject}`,
    });
    const b = new Batch(c.env.DB, actor);
    b.add("UPDATE inbox_items SET status = 'approved', booking_id = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?", result.id, actor.id, nowIso(), item.id);
    b.audit("inbox.approve", "inbox_item", item.id, { status: "pending" }, { status: "approved", booking_id: result.id });
    await b.run();
    return c.json({ booking: result });
  }
  if (item.kind === "cancellation") {
    if (!item.external_ref) throw new HttpError(400, "cancellation email has no reference; dismiss and cancel the booking manually");
    const bk: any = await one(c.env.DB, "SELECT id FROM bookings WHERE property_id = ? AND external_ref = ? AND status NOT IN ('cancelled','no_show','checked_out')", p.id, item.external_ref);
    if (!bk) throw new HttpError(404, `no open booking with reference ${item.external_ref}`);
    const { cancelBooking } = await import("../services/bookings");
    const res = await cancelBooking(c.env.DB, actor, p, bk.id, "cancelled", `OTA cancellation (${item.source})`);
    const b = new Batch(c.env.DB, actor);
    b.add("UPDATE inbox_items SET status = 'approved', booking_id = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?", bk.id, actor.id, nowIso(), item.id);
    b.audit("inbox.approve", "inbox_item", item.id, { status: "pending" }, { status: "approved", cancelled: bk.id });
    await b.run();
    return c.json({ cancelled: bk.id, ...res });
  }
  throw new HttpError(400, `cannot auto-apply a ${item.kind}; edit the booking directly and dismiss this item`);
});

r.post("/:id/dismiss", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const item: any = await one(c.env.DB, "SELECT * FROM inbox_items WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!item) throw new HttpError(404, "inbox item not found");
  const x = await body(c).catch(() => ({} as Record<string, unknown>));
  const b = new Batch(c.env.DB, actor);
  b.add("UPDATE inbox_items SET status = 'dismissed', reviewed_by = ?, reviewed_at = ? WHERE id = ?", actor.id, nowIso(), item.id);
  b.audit("inbox.dismiss", "inbox_item", item.id, { status: item.status }, { status: "dismissed", reason: optStr(x.reason, "reason") });
  await b.run();
  return c.json({ ok: true });
});

export default r;
export type { ParsedEmail };
