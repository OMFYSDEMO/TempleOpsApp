import { Batch, all, one, id } from "../db";
import { nowIso } from "../domain/dates";

/**
 * STAAH holds the room inventory every channel sells from; AVOS only reads it. A direct booking made by hand in AVOS
 * (not one that arrived from a STAAH, OTA or website-engine email) is unknown to STAAH, so a person must close those
 * nights there; cancelling or moving it means opening them again. Each needed update is a row until it is ticked done.
 */
export function handMadeDirect(bk: { inbox_item_id: string | null }, collectionType: string): boolean {
  return collectionType === "direct" && !bk.inbox_item_id;
}

export function addCloseout(b: Batch, propertyId: string, bookingId: string, action: "close" | "reopen", checkIn: string, checkOut: string, rooms: string, guestName: string | null, actorId: string | null) {
  b.add("INSERT INTO staah_closeouts (id, property_id, booking_id, action, check_in, check_out, rooms, guest_name, created_by) VALUES (?,?,?,?,?,?,?,?,?)",
    id("stc"), propertyId, bookingId, action, checkIn, checkOut, rooms, guestName, actorId);
}

/** The open close-out for a booking, if STAAH has not been closed for it yet. */
export function openClose(db: D1Database, bookingId: string) {
  return one<{ id: string; check_in: string; check_out: string; rooms: string }>(db, "SELECT id, check_in, check_out, rooms FROM staah_closeouts WHERE booking_id = ? AND action = 'close' AND status = 'open' ORDER BY created_at DESC LIMIT 1", bookingId);
}

/** Cancelled in AVOS: nights never closed in STAAH need nothing (drop the close-out); nights that were closed must reopen. */
export async function closeoutOnCancel(db: D1Database, b: Batch, propertyId: string, bk: { id: string; check_in: string; check_out: string; inbox_item_id: string | null }, collectionType: string, rooms: string, guestName: string | null, actorId: string | null) {
  if (!handMadeDirect(bk, collectionType)) return;
  const pending = await openClose(db, bk.id);
  if (pending) b.add("UPDATE staah_closeouts SET status = 'dropped', note = 'booking cancelled before STAAH was closed: nothing to reopen', done_at = ? WHERE id = ?", nowIso(), pending.id);
  else addCloseout(b, propertyId, bk.id, "reopen", bk.check_in, bk.check_out, rooms, guestName, actorId);
}

/** Moved in AVOS (dates or rooms): a close-out still open just follows the booking; one already done means reopen old, close new. */
export async function closeoutOnAmend(db: D1Database, b: Batch, propertyId: string, bk: { id: string; check_in: string; check_out: string; inbox_item_id: string | null }, collectionType: string, oldRooms: string, next: { checkIn: string; checkOut: string; rooms: string }, guestName: string | null, actorId: string | null) {
  if (!handMadeDirect(bk, collectionType)) return;
  if (bk.check_in === next.checkIn && bk.check_out === next.checkOut && oldRooms === next.rooms) return;
  const pending = await openClose(db, bk.id);
  if (pending) { b.add("UPDATE staah_closeouts SET check_in = ?, check_out = ?, rooms = ? WHERE id = ?", next.checkIn, next.checkOut, next.rooms, pending.id); return; }
  addCloseout(b, propertyId, bk.id, "reopen", bk.check_in, bk.check_out, oldRooms, guestName, actorId);
  addCloseout(b, propertyId, bk.id, "close", next.checkIn, next.checkOut, next.rooms, guestName, actorId);
}

export const roomNames = (names: (string | undefined | null)[]) => names.filter(Boolean).sort().join(" + ");

export function openCloseouts(db: D1Database, propertyId: string) {
  return all<{ id: string; booking_id: string; action: string; check_in: string; check_out: string; rooms: string; guest_name: string | null; created_at: string }>(db,
    "SELECT id, booking_id, action, check_in, check_out, rooms, guest_name, created_at FROM staah_closeouts WHERE property_id = ? AND status = 'open' ORDER BY created_at", propertyId);
}
