import type { Actor } from "../auth";
import { Batch, HttpError, all, one, type PropertyRow } from "../db";
import { nowIso, todayIn } from "../domain/dates";
import { slabBpForRoomNight } from "../domain/gst";
import { splitInclusive } from "../domain/money";
import type { ParsedEmail } from "../email/parsers";
import { createBooking, cancelBooking, conflicts, gstPolicy } from "./bookings";
import { notifyRole } from "./notify";
import { recordPayment } from "./payments";

/**
 * Inbox automation (W1). A parsed email is applied to the books the moment it arrives when every fact lines up;
 * otherwise it stays a review card carrying the reason. The rules are deliberately narrow: automation only does
 * what a person would do without thinking, and everything it does is audited as "inbox-automation".
 *
 *  - new reservation  → channel recognised, a free room of the named type for every night, an amount → booking
 *  - cancellation     → one open booking with that reference → cancelled (a refund approval is raised if money was taken)
 *  - Airpay payment   → successful, and the order id starts with a SwiftBook itinerary we hold → payment + fee
 *  - modification     → always a person: the email rarely says what changed
 */
/** A booking reference matches as stored, or as the "STAAH id (OTA ref)" pair the migrated stays carry. */
export const REF_MATCH = "(external_ref = ? OR external_ref LIKE ? OR external_ref LIKE ?)";
export const refArgs = (ref: string) => [ref, `${ref} (%`, `% (${ref})`];

export type AutoResult = { applied: true; what: "booked" | "cancelled" | "paid"; id: string } | { applied: false; note: string };

/** Automation acts for the owner (FKs need a real user) but signs the audit as itself. */
async function automationActor(db: D1Database, propertyId: string): Promise<Actor | null> {
  const u = await one<{ id: string; name: string }>(db, "SELECT id, name FROM users WHERE property_id = ? AND active = 1 ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'sales' THEN 1 ELSE 2 END, id LIMIT 1", propertyId);
  return u ? { id: u.id, property_id: propertyId, email: "inbox-automation", name: "Inbox automation", role: "owner", via: "automation" } : null;
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Match the email's channel name to a configured channel; hotel-collect emails prefer the "(pay at property)" twin. */
async function resolveChannel(db: D1Database, propertyId: string, parsed: ParsedEmail): Promise<{ code: string } | null> {
  if (parsed.source === "swiftbook") return await one<{ code: string }>(db, "SELECT code FROM channels WHERE property_id = ? AND code = 'swiftbook' AND active = 1", propertyId);
  const want = norm(parsed.data.channel);
  if (!want) return null;
  const rows = await all<{ code: string; name: string; collection_type: string }>(db, "SELECT code, name, collection_type FROM channels WHERE property_id = ? AND active = 1", propertyId);
  const base = rows.filter((r) => !/hotel_collect$/.test(r.code)).filter((r) => { const n = norm(r.name), c = norm(r.code); return n === want || c === want || n.startsWith(want) || want.startsWith(n) || c.replace(/ /g, "") === want.replace(/ /g, ""); });
  if (base.length !== 1) return null;
  if (parsed.data.collection_type === "hotel_collect") {
    const twin = rows.find((r) => r.code === `${base[0].code}_hotel_collect`);
    if (twin) return twin;
  }
  return base[0];
}

/** Free rooms of the named type for every night of the stay, in sort order. */
async function freeRoomsOfType(db: D1Database, propertyId: string, roomName: unknown, checkIn: string, checkOut: string): Promise<{ ids: string[]; typeKnown: boolean }> {
  const want = norm(roomName);
  const rooms = await all<{ id: string; name: string; code: string }>(db, "SELECT id, name, code FROM locations WHERE property_id = ? AND kind = 'room' AND active = 1 ORDER BY sort, code", propertyId);
  const ofType = want ? rooms.filter((r) => { const n = norm(r.name); return n === want || want.startsWith(n) || n.startsWith(want); }) : [];
  if (!ofType.length) return { ids: [], typeKnown: false };
  const taken = new Set((await conflicts(db, propertyId, ofType.map((r) => r.id), checkIn, checkOut)).map((c) => c.room_id));
  return { ids: ofType.filter((r) => !taken.has(r.id)).map((r) => r.id), typeKnown: true };
}

export async function autoApply(db: D1Database, property: PropertyRow, item: { id: string; kind: string; source: string; external_ref: string | null; subject: string }, parsed: ParsedEmail): Promise<AutoResult> {
  const actor = await automationActor(db, property.id);
  if (!actor) return { applied: false, note: "no active user to act for" };
  const d = parsed.data as Record<string, any>;
  try {
    if (item.kind === "new_reservation") {
      if (parsed.confidence !== "high") return { applied: false, note: "parser not confident: check the fields" };
      const checkIn = String(d.check_in), checkOut = String(d.check_out);
      if (!(checkIn < checkOut)) return { applied: false, note: "dates do not make a stay" };
      if (checkOut < todayIn(property.timezone)) return { applied: false, note: "stay is in the past" };
      const channel = await resolveChannel(db, property.id, parsed);
      if (!channel) return { applied: false, note: `channel "${d.channel ?? "?"}" is not set up: pick it by hand or add it under Settings` };
      const wanted = Math.max(1, Number(d.rooms ?? 1));
      const free = await freeRoomsOfType(db, property.id, d.room_name, checkIn, checkOut);
      if (!free.typeKnown) return { applied: false, note: `room type "${d.room_name ?? "?"}" does not match a room: pick the room(s) by hand` };
      if (free.ids.length < wanted) return { applied: false, note: `only ${free.ids.length} of ${wanted} ${d.room_name} room(s) free for those dates: possible overbooking, pick by hand` };
      const roomIds = free.ids.slice(0, wanted);
      const nights = Math.max(1, Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000));
      let nightly: number;
      if (d.nightly_rate_paise) nightly = Number(d.nightly_rate_paise);
      else if (d.room_total_paise) nightly = Math.round(Number(d.room_total_paise) / (nights * roomIds.length));
      else if (d.total_incl_gst_paise) { const perNight = Math.round(Number(d.total_incl_gst_paise) / (nights * roomIds.length)); nightly = splitInclusive(perNight, slabBpForRoomNight(gstPolicy(property), perNight)).ex; }
      else return { applied: false, note: "the email carried no amount" };
      const result = await createBooking(db, actor, property, {
        guest: { name: String(d.guest_name), phone: d.guest_phone ?? null, email: d.guest_email ?? null },
        channelCode: channel.code, externalRef: item.external_ref, checkIn, checkOut, rooms: roomIds.map((roomId) => ({ roomId, nightlyRatePaise: nightly })),
        inboxItemId: item.id, isOta: channel.code !== "direct", notes: `auto-booked from ${item.source} email: ${item.subject}`,
      });
      const b = new Batch(db, actor);
      b.add("UPDATE inbox_items SET status = 'approved', booking_id = ?, auto_applied = 1, auto_note = NULL, reviewed_at = ? WHERE id = ?", result.id, nowIso(), item.id);
      b.audit("inbox.auto_book", "inbox_item", item.id, { status: "pending" }, { status: "approved", booking_id: result.id, rooms: roomIds, channel: channel.code });
      await notifyRole(b, property.id, "sales", "inbox_auto_booked", `${d.guest_name} · ${checkIn} → ${checkOut} booked from ${item.source} (${channel.code})`, { kind: "booking", id: result.id });
      await notifyRole(b, property.id, "property", "inbox_auto_booked", `${d.guest_name} arrives ${checkIn} (${channel.code}, from email)`, { kind: "booking", id: result.id });
      await b.run();
      return { applied: true, what: "booked", id: result.id };
    }
    if (item.kind === "cancellation") {
      if (!item.external_ref) return { applied: false, note: "no booking reference in the email" };
      const open = await all<{ id: string; status: string; guest_id: string }>(db, `SELECT id, status, guest_id FROM bookings WHERE property_id = ? AND ${REF_MATCH} AND status NOT IN ('cancelled','no_show','checked_out')`, property.id, ...refArgs(item.external_ref));
      if (open.length !== 1) return { applied: false, note: open.length ? "more than one open booking carries that reference" : `no open booking with reference ${item.external_ref}` };
      if (open[0].status === "checked_in") return { applied: false, note: "guest is checked in: a person decides" };
      const res = await cancelBooking(db, actor, property, open[0].id, "cancelled", `${item.source} cancellation email`);
      const b = new Batch(db, actor);
      b.add("UPDATE inbox_items SET status = 'approved', booking_id = ?, auto_applied = 1, auto_note = NULL, reviewed_at = ? WHERE id = ?", open[0].id, nowIso(), item.id);
      b.audit("inbox.auto_cancel", "inbox_item", item.id, { status: "pending" }, { status: "approved", cancelled: open[0].id, refund_approval: res.refundApprovalId });
      await notifyRole(b, property.id, "sales", "inbox_auto_cancelled", `Booking ${item.external_ref} cancelled by ${item.source} email${res.paidPaise > 0 ? " · refund awaits approval" : ""}`, { kind: "booking", id: open[0].id });
      await notifyRole(b, property.id, "property", "inbox_auto_cancelled", `Booking ${item.external_ref} cancelled (from email): rooms released`, { kind: "booking", id: open[0].id });
      await b.run();
      return { applied: true, what: "cancelled", id: open[0].id };
    }
    if (item.kind === "payment") {
      if (parsed.confidence !== "high" || !d.success) return { applied: false, note: "not a confirmed successful transaction" };
      const dup = await one<{ id: string }>(db, "SELECT id FROM payments WHERE property_id = ? AND method = 'airpay' AND reference = ? AND status != 'void'", property.id, String(d.order_id));
      if (dup) {
        const b = new Batch(db, actor);
        b.add("UPDATE inbox_items SET status = 'duplicate', payment_id = ?, auto_note = 'already recorded' WHERE id = ?", dup.id, item.id);
        b.audit("inbox.duplicate", "inbox_item", item.id, null, { payment_id: dup.id });
        await b.run();
        return { applied: false, note: "already recorded" };
      }
      // Airpay order ids begin with the SwiftBook itinerary number: that is the stay the money is for.
      const bk = await all<{ id: string; guest_name: string }>(db, "SELECT b.id, g.name AS guest_name FROM bookings b JOIN guests g ON g.id = b.guest_id WHERE b.property_id = ? AND b.external_ref IS NOT NULL AND ? LIKE b.external_ref || '%' AND b.status NOT IN ('cancelled','no_show') ORDER BY b.created_at DESC", property.id, String(d.order_id));
      if (bk.length !== 1) return { applied: false, note: bk.length ? "order matches more than one stay" : "no stay matches the order id: confirm or dismiss on the Payments screen" };
      const pay = await recordPayment(db, actor, property, { booking_id: bk[0].id, method: "airpay", amount_paise: Number(d.amount_paise), reference: String(d.order_id), inbox_item_id: item.id, idempotency_key: `airpay:${d.order_id}` });
      const b = new Batch(db, actor);
      b.add("UPDATE inbox_items SET auto_applied = 1, auto_note = NULL WHERE id = ?", item.id);
      b.audit("inbox.auto_pay", "inbox_item", item.id, { status: "routed" }, { status: "approved", payment_id: pay.id, booking_id: bk[0].id });
      await notifyRole(b, property.id, "property", "inbox_auto_paid", `Airpay ${Number(d.amount_paise) / 100} received for ${bk[0].guest_name} (order ${d.order_id})`, { kind: "payment", id: pay.id });
      await b.run();
      return { applied: true, what: "paid", id: pay.id };
    }
    if (item.kind === "modification") return { applied: false, note: "modifications are applied by hand: compare with the booking and edit it" };
    return { applied: false, note: "could not tell what this email is" };
  } catch (e: any) {
    // Anything the books refuse (locked month, clash, bad data) leaves the card for a person, with the reason.
    const msg = e instanceof HttpError ? e.message : String(e?.message ?? e);
    return { applied: false, note: msg };
  }
}
