import type { Actor } from "../auth";
import { Batch, HttpError, all, one, id, type PropertyRow, assertPeriodOpen } from "../db";
import { nightsBetween, nightsOf, nowIso } from "../domain/dates";
import { computeRoomLine, type GstPolicy } from "../domain/gst";
import { normalisePhone } from "../domain/ids";
import { tariffFor, compareToTariff, decideApproval, type RateCardRow, type RateVsTariff } from "../domain/tariff";
import { notifyRole } from "./notify";

export interface ChannelRow {
  id: string; code: string; name: string; collection_type: "direct" | "channel_collect" | "hotel_collect";
  commission_bp: number; commission_base: "ex_gst" | "gross"; payment_fee_bp: number; payment_fee_base: "ex_gst" | "gross";
  tcs_bp: number; tcs_base: "ex_gst" | "gross"; tds_bp: number; tds_base: "ex_gst" | "gross";
}

export interface CreateBookingInput {
  guest: { id?: string | null; name: string; phone?: string | null; email?: string | null };
  channelCode: string;
  externalRef?: string | null;
  checkIn: string;
  checkOut: string;
  adults?: number;
  children?: number;
  rooms: { roomId: string; nightlyRatePaise: number }[]; // ex-GST as sold
  leadId?: string | null;
  inboxItemId?: string | null;
  salespersonId?: string | null;
  notes?: string | null;
  /** OTA bookings arrive already paid/contracted: they bypass the tariff approval but are still audited. */
  isOta?: boolean;
}

export function gstPolicy(p: PropertyRow): GstPolicy {
  return { gstin: p.gstin, nilUptoPaise: p.gst_nil_upto_paise ?? 100_000, thresholdPaise: p.gst_threshold_paise, belowBp: p.gst_rate_below_bp, aboveBp: p.gst_rate_above_bp };
}

export async function findOrCreateGuest(b: Batch, propertyId: string, g: CreateBookingInput["guest"]): Promise<string> {
  if (g.id) {
    const row = await one<{ id: string }>(b.db, "SELECT id FROM guests WHERE id = ? AND property_id = ?", g.id, propertyId);
    if (!row) throw new HttpError(404, "guest not found");
    return row.id;
  }
  const phone = normalisePhone(g.phone);
  if (phone) {
    const existing = await one<{ id: string }>(b.db, "SELECT id FROM guests WHERE property_id = ? AND phone = ?", propertyId, phone);
    if (existing) return existing.id;
  }
  const gid = id("gst");
  b.add("INSERT INTO guests (id, property_id, name, phone, email) VALUES (?,?,?,?,?)", gid, propertyId, g.name.trim(), phone, g.email?.trim() || null);
  b.audit("guest.create", "guest", gid, null, { name: g.name, phone });
  return gid;
}

/** Nights a room is already taken (booked or unexpired hold) in a window, excluding a lead's own hold. */
export async function conflicts(db: D1Database, propertyId: string, roomIds: string[], checkIn: string, checkOut: string, opts: { ignoreLeadId?: string | null; ignoreBookingId?: string | null } = {}) {
  if (!roomIds.length) return [];
  const placeholders = roomIds.map(() => "?").join(",");
  const rows = await all<{ room_id: string; night: string; kind: string; booking_id: string | null; lead_id: string | null; expires_at: string | null }>(
    db,
    `SELECT room_id, night, kind, booking_id, lead_id, expires_at FROM room_nights
     WHERE property_id = ? AND room_id IN (${placeholders}) AND night >= ? AND night < ?`,
    propertyId, ...roomIds, checkIn, checkOut,
  );
  const now = nowIso();
  return rows.filter((r) => {
    if (opts.ignoreLeadId && r.lead_id === opts.ignoreLeadId) return false;
    if (opts.ignoreBookingId && r.booking_id === opts.ignoreBookingId) return false;
    if (r.kind === "hold" && r.expires_at && r.expires_at < now) return false; // expired hold: cron will sweep it
    return true;
  });
}

type Line = { roomId: string; nights: number; nightlyRatePaise: number; tariffRatePaise: number | null; gstRateBp: number; roomTotalPaise: number; gstPaise: number; rateVsTariff: RateVsTariff };

/** Price a stay: one booking_rooms line per (room, GST slab), GST computed night by night from the declared tariff. */
export async function priceStay(db: D1Database, property: PropertyRow, roomsIn: { roomId: string; nightlyRatePaise: number }[], checkIn: string, checkOut: string) {
  const cards = await all<RateCardRow>(db, "SELECT room_id, rate_paise, from_date, to_date, priority FROM rate_cards WHERE property_id = ?", property.id);
  const policy = gstPolicy(property);
  const stayNights = nightsOf(checkIn, checkOut);
  const lines: Line[] = [];
  for (const r of roomsIn) {
    if (!Number.isInteger(r.nightlyRatePaise) || r.nightlyRatePaise < 0) throw new HttpError(400, "nightly rate must be a non-negative integer (paise)");
    const groups = new Map<string, Line>();
    for (const night of stayNights) {
      const tariff = tariffFor(cards, r.roomId, night);
      const cmp = compareToTariff(r.nightlyRatePaise, tariff);
      const nl = computeRoomLine(policy, { roomId: r.roomId, nights: 1, nightlyRatePaise: r.nightlyRatePaise, declaredTariffPaise: tariff ?? r.nightlyRatePaise });
      const key = `${nl.gstRateBp}:${cmp}`;
      const g = groups.get(key) ?? { roomId: r.roomId, nights: 0, nightlyRatePaise: r.nightlyRatePaise, tariffRatePaise: tariff, gstRateBp: nl.gstRateBp, roomTotalPaise: 0, gstPaise: 0, rateVsTariff: cmp };
      g.nights += 1; g.roomTotalPaise += nl.roomTotalPaise; g.gstPaise += nl.gstPaise;
      if (tariff !== null && (g.tariffRatePaise === null || tariff > g.tariffRatePaise)) g.tariffRatePaise = tariff;
      groups.set(key, g);
    }
    lines.push(...groups.values());
  }
  const roomTotal = lines.reduce((a, l) => a + l.roomTotalPaise, 0);
  const gst = lines.reduce((a, l) => a + l.gstPaise, 0);
  const worst: RateVsTariff = lines.some((l) => l.rateVsTariff === "below") ? "below" : lines.some((l) => l.rateVsTariff === "above") ? "above" : lines.some((l) => l.rateVsTariff === "no_tariff") ? "no_tariff" : "on";
  return { lines, roomTotal, gst, worst, stayNights };
}

/**
 * The one place a booking is born. Used by manual entry (W2), Lead → Won (W13) and the inbox (W1).
 * Computes GST per room-night from the tariff card, checks the rate against tariff, decides approval
 * by exception, occupies inventory and audits — all in one D1 batch.
 */
export async function createBooking(db: D1Database, actor: Actor | null, property: PropertyRow, input: CreateBookingInput) {
  const nights = nightsBetween(input.checkIn, input.checkOut);
  if (!input.rooms.length) throw new HttpError(400, "at least one room is required");
  await assertPeriodOpen(db, property.id, input.checkOut);

  const channel = await one<ChannelRow>(db, "SELECT * FROM channels WHERE property_id = ? AND code = ? AND active = 1", property.id, input.channelCode);
  if (!channel) throw new HttpError(400, `unknown channel ${input.channelCode}`);

  const roomIds = [...new Set(input.rooms.map((r) => r.roomId))];
  if (roomIds.length !== input.rooms.length) throw new HttpError(400, "a room appears twice");
  const rooms = await all<{ id: string; name: string }>(db, `SELECT id, name FROM locations WHERE property_id = ? AND kind = 'room' AND active = 1 AND id IN (${roomIds.map(() => "?").join(",")})`, property.id, ...roomIds);
  if (rooms.length !== roomIds.length) throw new HttpError(400, "unknown room");

  // Expired holds are released lazily here as well as by cron, so a stale hold never blocks a sale.
  const taken = await conflicts(db, property.id, roomIds, input.checkIn, input.checkOut, { ignoreLeadId: input.leadId });
  if (taken.length) throw new HttpError(409, "room not available", { nights: taken.map((t) => ({ room_id: t.room_id, night: t.night, kind: t.kind })) });

  const { lines, roomTotal, gst, worst, stayNights } = await priceStay(db, property, input.rooms, input.checkIn, input.checkOut);

  const isOta = input.isOta ?? channel.collection_type !== "direct";
  const decision = decideApproval({ autoApproveOnTariff: property.auto_approve_on_tariff === 1, autoApproveMaxRooms: property.auto_approve_max_rooms }, lines, { isOta });
  const auto = decision.mode === "auto_on_tariff";

  const b = new Batch(db, actor);
  const guestId = await findOrCreateGuest(b, property.id, input.guest);
  const bid = id("bkg");
  const now = nowIso();
  const status = auto ? "approved" : "provisional";
  b.add(
    `INSERT INTO bookings (id, property_id, guest_id, channel_id, external_ref, status, check_in, check_out, nights, adults, children,
       room_total_paise, gst_paise, gross_paise, rate_vs_tariff, approval_mode, approved_by, approved_at, salesperson_id, lead_id, inbox_item_id, books_date, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    bid, property.id, guestId, channel.id, input.externalRef ?? null, status, input.checkIn, input.checkOut, nights, input.adults ?? 2, input.children ?? 0,
    roomTotal, gst, roomTotal + gst, worst, auto ? "auto_on_tariff" : "manual", auto ? (actor?.id ?? null) : null, auto ? now : null,
    input.salespersonId ?? actor?.id ?? null, input.leadId ?? null, input.inboxItemId ?? null, input.checkOut, input.notes ?? null, actor?.id ?? null,
  );
  for (const l of lines) {
    b.add("INSERT INTO booking_rooms (id, booking_id, room_id, nightly_rate_paise, tariff_rate_paise, gst_rate_bp, nights, room_total_paise, gst_paise) VALUES (?,?,?,?,?,?,?,?,?)",
      id("brm"), bid, l.roomId, l.nightlyRatePaise, l.tariffRatePaise, l.gstRateBp, l.nights, l.roomTotalPaise, l.gstPaise);
  }
  // Inventory: a lead's hold rows become booked rows; otherwise fresh rows. The PK makes a double booking impossible.
  if (input.leadId) b.add("DELETE FROM room_nights WHERE property_id = ? AND lead_id = ?", property.id, input.leadId);
  b.add("DELETE FROM room_nights WHERE property_id = ? AND kind = 'hold' AND expires_at < ?", property.id, now);
  for (const r of input.rooms) for (const night of stayNights) {
    b.add("INSERT INTO room_nights (property_id, room_id, night, kind, booking_id) VALUES (?,?,?,'booked',?)", property.id, r.roomId, night, bid);
  }
  const apId = id("apr");
  const summary = `${input.guest.name} · ${channel.name} · ${input.checkIn}→${input.checkOut} · ${input.rooms.length} room(s)`;
  b.add("INSERT INTO approvals (id, property_id, kind, ref_id, summary, amount_paise, status, requested_by, decided_by, decided_at, note) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    apId, property.id, "booking", bid, summary, roomTotal + gst, auto ? "auto" : "pending", actor?.id ?? null, auto ? (actor?.id ?? null) : null, auto ? now : null,
    auto ? (isOta ? "ota_parsed" : "on tariff") : decision.reasons.join(","));
  if (!auto) await notifyRole(b, property.id, "revenue", "approval_pending", `Booking awaiting approval: ${summary} (${decision.reasons.join(", ")})`, { kind: "booking", id: bid });
  if (input.leadId) {
    b.add("UPDATE leads SET status = 'won', booking_id = ?, hold_expires_at = NULL, updated_at = ? WHERE id = ? AND property_id = ?", bid, now, input.leadId, property.id);
    b.audit("lead.won", "lead", input.leadId, null, { booking_id: bid });
  }
  b.audit("booking.create", "booking", bid, null, { status, channel: channel.code, check_in: input.checkIn, check_out: input.checkOut, gross_paise: roomTotal + gst, rate_vs_tariff: worst, approval: decision });
  await b.run();
  return { id: bid, status, approval: decision, roomTotalPaise: roomTotal, gstPaise: gst, grossPaise: roomTotal + gst, rateVsTariff: worst, lines };
}

export interface BookingRow {
  id: string; property_id: string; guest_id: string; channel_id: string; external_ref: string | null; status: string;
  check_in: string; check_out: string; nights: number; adults: number; children: number;
  room_total_paise: number; gst_paise: number; gross_paise: number; rate_vs_tariff: string; approval_mode: string | null;
  approved_by: string | null; approved_at: string | null; salesperson_id: string | null; lead_id: string | null; inbox_item_id: string | null;
  books_date: string; checked_in_at: string | null; checked_out_at: string | null; cancelled_at: string | null; cancel_reason: string | null;
  notes: string | null; created_by: string | null; created_at: string; updated_at: string;
}

export async function loadBooking(db: D1Database, propertyId: string, bookingId: string): Promise<BookingRow> {
  const b = await one<BookingRow>(db, "SELECT * FROM bookings WHERE id = ? AND property_id = ?", bookingId, propertyId);
  if (!b) throw new HttpError(404, "booking not found");
  return b;
}

export async function paidOnBooking(db: D1Database, bookingId: string): Promise<number> {
  const r = await one<{ paid: number | null }>(db,
    "SELECT SUM(CASE WHEN kind = 'refund' THEN -amount_paise ELSE amount_paise END) AS paid FROM payments WHERE booking_id = ? AND status != 'void'", bookingId);
  return r?.paid ?? 0;
}

/** Cancel or no-show: release inventory; if money was taken, open a refund approval rather than moving money. */
export async function cancelBooking(db: D1Database, actor: Actor, property: PropertyRow, bookingId: string, newStatus: "cancelled" | "no_show", reason: string) {
  const bk = await loadBooking(db, property.id, bookingId);
  if (["cancelled", "no_show", "checked_out"].includes(bk.status)) throw new HttpError(409, `booking is ${bk.status}`);
  await assertPeriodOpen(db, property.id, bk.books_date);
  const paid = await paidOnBooking(db, bookingId);
  const b = new Batch(db, actor);
  const now = nowIso();
  b.add("UPDATE bookings SET status = ?, cancelled_at = ?, cancel_reason = ?, updated_at = ? WHERE id = ?", newStatus, now, reason, now, bookingId);
  b.add("DELETE FROM room_nights WHERE booking_id = ?", bookingId);
  b.audit(`booking.${newStatus}`, "booking", bookingId, { status: bk.status }, { status: newStatus, reason, paid_paise: paid });
  let refundApprovalId: string | null = null;
  if (paid > 0) {
    refundApprovalId = id("apr");
    b.add("INSERT INTO approvals (id, property_id, kind, ref_id, summary, amount_paise, status, requested_by) VALUES (?,?,?,?,?,?,?,?)",
      refundApprovalId, property.id, "refund", bookingId, `Refund on ${newStatus} booking ${bookingId}: ${reason}`, paid, "pending", actor.id);
    await notifyRole(b, property.id, "revenue", "approval_pending", `Refund of ${paid / 100} awaiting approval (${newStatus})`, { kind: "booking", id: bookingId });
  }
  await b.run();
  return { status: newStatus, paidPaise: paid, refundApprovalId };
}

export interface AmendBookingInput {
  rooms?: { roomId: string; nightlyRatePaise: number }[];
  checkIn?: string; checkOut?: string;
  guestName?: string | null; guestPhone?: string | null;
  adults?: number; children?: number;
  channelCode?: string; externalRef?: string | null;
  remark: string;
}

/**
 * Amend a live booking in place: rooms (an exchange), dates, rates, guest, channel. Every amendment carries a
 * remark and lands in the audit trail; inventory is re-checked so a move can never double-book. Money already
 * taken stays on the booking; an issued invoice blocks a change of amount until it is credited.
 * Sales, revenue and the owner may amend. A sales amendment that takes a direct booking off tariff goes back
 * through approval; revenue and the owner approve by the act of amending.
 */
export async function amendBooking(db: D1Database, actor: Actor, property: PropertyRow, bookingId: string, input: AmendBookingInput) {
  const bk = await loadBooking(db, property.id, bookingId);
  if (!["provisional", "approved", "checked_in"].includes(bk.status)) throw new HttpError(409, `booking is ${bk.status}; it can no longer be amended`);
  const remark = (input.remark ?? "").trim();
  if (remark.length < 3) throw new HttpError(400, "a remark is required: say what was wrong and what changed");
  await assertPeriodOpen(db, property.id, bk.books_date);
  const checkIn = input.checkIn ?? bk.check_in, checkOut = input.checkOut ?? bk.check_out;
  if (!(checkIn < checkOut)) throw new HttpError(400, "check-out must be after check-in");
  await assertPeriodOpen(db, property.id, checkOut);
  const currentRooms = await all<{ room_id: string; nightly_rate_paise: number }>(db, "SELECT room_id, nightly_rate_paise FROM booking_rooms WHERE booking_id = ? GROUP BY room_id", bk.id);
  const roomsIn = input.rooms ?? currentRooms.map((r) => ({ roomId: r.room_id, nightlyRatePaise: r.nightly_rate_paise }));
  if (!roomsIn.length) throw new HttpError(400, "at least one room is required");
  const roomIds = [...new Set(roomsIn.map((r) => r.roomId))];
  if (roomIds.length !== roomsIn.length) throw new HttpError(400, "a room appears twice");
  const rooms = await all<{ id: string; name: string }>(db, `SELECT id, name FROM locations WHERE property_id = ? AND kind = 'room' AND active = 1 AND id IN (${roomIds.map(() => "?").join(",")})`, property.id, ...roomIds);
  if (rooms.length !== roomIds.length) throw new HttpError(400, "unknown room");
  const channel = input.channelCode
    ? await one<ChannelRow>(db, "SELECT * FROM channels WHERE property_id = ? AND code = ? AND active = 1", property.id, input.channelCode)
    : await one<ChannelRow>(db, "SELECT * FROM channels WHERE id = ?", bk.channel_id);
  if (!channel) throw new HttpError(400, `unknown channel ${input.channelCode}`);
  const taken = await conflicts(db, property.id, roomIds, checkIn, checkOut, { ignoreBookingId: bk.id });
  if (taken.length) {
    const names = Object.fromEntries(rooms.map((r) => [r.id, r.name]));
    throw new HttpError(409, `${[...new Set(taken.map((t) => names[t.room_id]))].join(", ")} not free on ${[...new Set(taken.map((t) => t.night))].join(", ")}`, { nights: taken.map((t) => ({ room_id: t.room_id, night: t.night, kind: t.kind })) });
  }
  const { lines, roomTotal, gst, worst, stayNights } = await priceStay(db, property, roomsIn, checkIn, checkOut);
  const gross = roomTotal + gst;
  if (gross !== bk.gross_paise) {
    const inv = await one(db, "SELECT id, number FROM invoices WHERE booking_id = ? AND status = 'issued'", bk.id);
    if (inv) throw new HttpError(409, `invoice ${(inv as any).number} is issued for this amount; credit it first, then amend`);
  }
  const isOta = channel.collection_type !== "direct";
  const decision = decideApproval({ autoApproveOnTariff: property.auto_approve_on_tariff === 1, autoApproveMaxRooms: property.auto_approve_max_rooms }, lines, { isOta });
  const approverAmends = actor.role === "revenue" || actor.role === "owner";
  const needsApproval = bk.status !== "checked_in" && decision.mode !== "auto_on_tariff" && !approverAmends;
  const status = needsApproval ? "provisional" : bk.status === "provisional" && approverAmends ? "approved" : bk.status;
  const before = { check_in: bk.check_in, check_out: bk.check_out, rooms: currentRooms, adults: bk.adults, children: bk.children, channel_id: bk.channel_id, external_ref: bk.external_ref, gross_paise: bk.gross_paise, status: bk.status };
  const b = new Batch(db, actor);
  const now = nowIso();
  const guest = await one<{ id: string; name: string; phone: string | null }>(db, "SELECT id, name, phone FROM guests WHERE id = ?", bk.guest_id);
  if (input.guestName !== undefined || input.guestPhone !== undefined) {
    const name = (input.guestName ?? guest?.name ?? "").trim(); if (!name) throw new HttpError(400, "guest name cannot be empty");
    const phone = input.guestPhone === undefined ? guest?.phone ?? null : normalisePhone(input.guestPhone);
    b.add("UPDATE guests SET name = ?, phone = ? WHERE id = ?", name, phone, bk.guest_id);
  }
  b.add(`UPDATE bookings SET check_in = ?, check_out = ?, nights = ?, adults = ?, children = ?, channel_id = ?, external_ref = ?, room_total_paise = ?, gst_paise = ?, gross_paise = ?, rate_vs_tariff = ?, status = ?, books_date = ?,
         notes = COALESCE(notes || char(10), '') || ?, updated_at = ? WHERE id = ?`,
    checkIn, checkOut, nightsBetween(checkIn, checkOut), input.adults ?? bk.adults, input.children ?? bk.children, channel.id, input.externalRef === undefined ? bk.external_ref : input.externalRef,
    roomTotal, gst, gross, worst, status, checkOut, `Amended ${now.slice(0, 10)} by ${actor.name}: ${remark}`, now, bk.id);
  b.add("DELETE FROM booking_rooms WHERE booking_id = ?", bk.id);
  for (const l of lines) b.add("INSERT INTO booking_rooms (id, booking_id, room_id, nightly_rate_paise, tariff_rate_paise, gst_rate_bp, nights, room_total_paise, gst_paise) VALUES (?,?,?,?,?,?,?,?,?)",
    id("brm"), bk.id, l.roomId, l.nightlyRatePaise, l.tariffRatePaise, l.gstRateBp, l.nights, l.roomTotalPaise, l.gstPaise);
  b.add("DELETE FROM room_nights WHERE booking_id = ?", bk.id);
  for (const r of roomsIn) for (const night of stayNights) b.add("INSERT INTO room_nights (property_id, room_id, night, kind, booking_id) VALUES (?,?,?,'booked',?)", property.id, r.roomId, night, bk.id);
  const summary = `${guest?.name ?? "Guest"} · ${channel.name} · ${checkIn}→${checkOut} · ${roomsIn.length} room(s) · amended: ${remark}`;
  if (needsApproval) {
    b.add("UPDATE approvals SET status = 'returned', note = 'superseded by amendment', decided_at = ? WHERE ref_id = ? AND status = 'pending'", now, bk.id);
    b.add("INSERT INTO approvals (id, property_id, kind, ref_id, summary, amount_paise, status, requested_by, note) VALUES (?,?,?,?,?,?,?,?,?)", id("apr"), property.id, "booking", bk.id, summary, gross, "pending", actor.id, decision.reasons.join(","));
    await notifyRole(b, property.id, "revenue", "approval_pending", `Amended booking awaiting approval: ${summary} (${decision.reasons.join(", ")})`, { kind: "booking", id: bk.id });
  } else if (bk.status === "provisional" && approverAmends) {
    b.add("UPDATE approvals SET status = 'approved', decided_by = ?, decided_at = ?, note = ? WHERE ref_id = ? AND status = 'pending'", actor.id, now, `approved by amendment: ${remark}`, bk.id);
    b.add("UPDATE bookings SET approval_mode = 'manual', approved_by = ?, approved_at = ? WHERE id = ?", actor.id, now, bk.id);
  }
  const after = { check_in: checkIn, check_out: checkOut, rooms: roomsIn.map((r) => ({ room_id: r.roomId, name: rooms.find((x) => x.id === r.roomId)?.name, nightly_rate_paise: r.nightlyRatePaise })), adults: input.adults ?? bk.adults, children: input.children ?? bk.children, channel_id: channel.id, external_ref: input.externalRef === undefined ? bk.external_ref : input.externalRef, gross_paise: gross, status, remark };
  b.audit("booking.amend", "booking", bk.id, before, after);
  await notifyRole(b, property.id, "property", "booking_amended", `${guest?.name ?? "Guest"} ${checkIn}→${checkOut}: ${roomsIn.map((r) => rooms.find((x) => x.id === r.roomId)?.name).join(" + ")} · ${remark}`, { kind: "booking", id: bk.id });
  await b.run();
  return { id: bk.id, status, grossPaise: gross, roomTotalPaise: roomTotal, gstPaise: gst, rateVsTariff: worst, approval: decision, needsApproval };
}
