/**
 * One-off migration: AVOS Books backup (invoice-centric JSON) → AVOS bookings, rooms, room-nights,
 * payments and gateway-fee expenses, as SQL. Reuses the domain rules (GST slab from declared tariff,
 * rate-vs-tariff, approval by exception) so migrated rows look exactly like rows the app would create.
 *
 *   npx esbuild scripts/migrate-avosbooks.ts --bundle --platform=node --format=esm --outfile=/tmp/mig.mjs
 *   node /tmp/mig.mjs <backup.json> <from YYYY-MM-DD> <to YYYY-MM-DD> <today YYYY-MM-DD> > migration.sql
 *
 * Legacy model (AVOS Books): one "invoice" per stay with `date` = CHECK-OUT date (confirmed by the owner),
 * lines {desc: room type, qty: nights, rate: ex-GST per night}; check-in = date − nights billed. The same
 * room may appear on several lines (different nightly rates on consecutive nights); "additional bed" lines
 * belong to the room line before them.
 */
import { readFileSync } from "node:fs";
import { addDays, nightsOf } from "../src/domain/dates";
import { computeRoomLine, type GstPolicy } from "../src/domain/gst";
import { rupeesToPaise, applyBp } from "../src/domain/money";
import { tariffFor, compareToTariff, decideApproval, type RateCardRow, type RateVsTariff } from "../src/domain/tariff";

const [backupPath, FROM, TO, TODAY] = process.argv.slice(2);
if (!backupPath || !FROM || !TO || !TODAY) { console.error("usage: backup.json from to today"); process.exit(2); }
const backup = JSON.parse(readFileSync(backupPath, "utf8"));

// ---- Reference data as seeded in AVOS (seed/meadows-varkala.sql) ----
const PROPERTY = "prop_meadows";
const OWNER = "usr_shaji";
const POLICY: GstPolicy = { gstin: "32AARCM3606J1ZD", thresholdPaise: 750_000, belowBp: 500, aboveBp: 1800 };
const APPROVAL = { autoApproveOnTariff: true, autoApproveMaxRooms: 4 };
const ROOMS: Record<string, string> = { deluxe: "loc_r1", premium: "loc_r2", superior: "loc_r3", executive: "loc_r4" };
const CARDS: RateCardRow[] = [
  { room_id: "loc_r1", rate_paise: 600000, from_date: null, to_date: null, priority: 0 },
  { room_id: "loc_r2", rate_paise: 650000, from_date: null, to_date: null, priority: 0 },
  { room_id: "loc_r3", rate_paise: 550000, from_date: null, to_date: null, priority: 0 },
  { room_id: "loc_r4", rate_paise: 700000, from_date: null, to_date: null, priority: 0 },
  { room_id: "loc_r1", rate_paise: 700000, from_date: "2026-12-20", to_date: "2027-01-05", priority: 10 },
  { room_id: "loc_r2", rate_paise: 750000, from_date: "2026-12-20", to_date: "2027-01-05", priority: 10 },
  { room_id: "loc_r3", rate_paise: 650000, from_date: "2026-12-20", to_date: "2027-01-05", priority: 10 },
  { room_id: "loc_r4", rate_paise: 750000, from_date: "2026-12-20", to_date: "2027-01-05", priority: 10 },
];
/** Legacy channel id + who collects → AVOS channel. Channels not yet in AVOS are created below. */
const CHANNELS: Record<string, { id: string; name: string; collection: "direct" | "channel_collect" | "hotel_collect" }> = {
  "direct:guest": { id: "ch_direct", name: "Direct", collection: "direct" },
  "direct:ota": { id: "ch_direct", name: "Direct", collection: "direct" },
  "referral:guest": { id: "ch_referral", name: "Guest referral", collection: "direct" },
  "bcom:ota": { id: "ch_bcom", name: "Booking.com", collection: "channel_collect" },
  "bcom:guest": { id: "ch_bcom_hc", name: "Booking.com (pay at property)", collection: "hotel_collect" },
  "agoda:ota": { id: "ch_agoda", name: "Agoda", collection: "channel_collect" },
  "mmt:ota": { id: "ch_mmt", name: "MakeMyTrip", collection: "channel_collect" },
  "clear-trip:ota": { id: "ch_cleartrip", name: "Cleartrip", collection: "channel_collect" },
  "clear-trip:guest": { id: "ch_cleartrip_hc", name: "Cleartrip (pay at property)", collection: "hotel_collect" },
  "yatra-travelguru:ota": { id: "ch_yatra", name: "Yatra / Travelguru", collection: "channel_collect" },
  "expedia:ota": { id: "ch_expedia", name: "Expedia", collection: "channel_collect" },
  "expedia:guest": { id: "ch_expedia_hc", name: "Expedia (pay at property)", collection: "hotel_collect" },
  "agent:guest": { id: "ch_agent", name: "Travel agent", collection: "hotel_collect" },
  "agent:ota": { id: "ch_agent", name: "Travel agent", collection: "hotel_collect" },
};
const NEW_CHANNELS = [
  // id, code, name, collection, commission_bp, payment_fee_bp, tcs_bp, tds_bp  (from the AVOS Books channel settings)
  ["ch_referral", "referral", "Guest referral", "direct", 0, 0, 0, 0],
  ["ch_cleartrip", "cleartrip", "Cleartrip", "channel_collect", 1800, 0, 50, 10],
  ["ch_cleartrip_hc", "cleartrip_hotel_collect", "Cleartrip (pay at property)", "hotel_collect", 1800, 0, 0, 0],
  ["ch_yatra", "yatra", "Yatra / Travelguru", "channel_collect", 2000, 0, 50, 10],
  ["ch_expedia", "expedia", "Expedia", "channel_collect", 1800, 0, 0, 0],
  ["ch_expedia_hc", "expedia_hotel_collect", "Expedia (pay at property)", "hotel_collect", 1800, 0, 0, 0],
  ["ch_agent", "agent", "Travel agent", "hotel_collect", 1000, 0, 0, 0],
] as const;
// Anu (sp1) resigned before October: her stays keep the name in the notes but no AVOS user.
const SALES: Record<string, string> = { z53ut8a: "usr_prachi" };
const SALES_NAME: Record<string, string> = { z53ut8a: "Prachi", sp1: "Anu" };
/** Legacy payment method → AVOS method, account, fee bp. POS settles to the bank, not the gateway. */
const METHODS: Record<string, { method: string; account: string; feeBp: number }> = {
  gateway: { method: "airpay", account: "acc_gw", feeBp: 200 },
  pos: { method: "card", account: "acc_bank", feeBp: 150 },
  bank: { method: "bank", account: "acc_bank", feeBp: 0 },
  upi: { method: "upi", account: "acc_bank", feeBp: 0 },
  cash: { method: "cash", account: "acc_cash", feeBp: 0 },
};

const roomName = (roomId: string) => Object.entries(ROOMS).find(([, v]) => v === roomId)?.[0] ?? roomId;
const q = (v: unknown): string => v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const sql: string[] = [];
const report: string[] = [];
const NOW = new Date().toISOString();
const MIG = `Migrated from AVOS Books on ${NOW.slice(0, 10)}`;
const audit = (action: string, entity: string, entityId: string, after: unknown) =>
  sql.push(`INSERT INTO audit_log (property_id, actor_id, actor_email, action, entity, entity_id, before_json, after_json, at) VALUES (${q(PROPERTY)}, ${q(OWNER)}, 'shajianandan@gmail.com', ${q(action)}, ${q(entity)}, ${q(entityId)}, NULL, ${q(JSON.stringify(after))}, ${q(NOW)});`);

// ---- Reference rows ----
sql.push(`-- AVOS Books → AVOS migration, stays checking in ${FROM}..${TO}, generated ${NOW}`);
for (const [id, code, name, coll, comm, fee, tcs, tds] of NEW_CHANNELS) {
  sql.push(`INSERT OR IGNORE INTO channels (id, property_id, code, name, collection_type, commission_bp, commission_base, payment_fee_bp, payment_fee_base, tcs_bp, tds_bp) VALUES (${q(id)}, ${q(PROPERTY)}, ${q(code)}, ${q(name)}, ${q(coll)}, ${comm}, 'ex_gst', ${fee}, 'gross', ${tcs}, ${tds});`);
}
// TCS 0.5% / TDS 0.1% as configured for these operators in AVOS Books (the live rows had 0.01% by mistake).
sql.push(`UPDATE channels SET tcs_bp = 50, tds_bp = 10 WHERE property_id = ${q(PROPERTY)} AND id IN ('ch_mmt', 'ch_agoda');`);

// ---- Stays ----
type Line = { desc: string; qty: number; rate: number; stream: string; gstOverride?: string };
type Inv = { id: string; date: string; guest: string; channelId: string; collection: string; commissionPct: number; bookingRef?: string; salespersonId: string; lines: Line[]; discount: number; payments: { id: string; date: string; amount: number; method: string; provider?: string; ref: string; feePct?: number; note?: string }[]; approved: boolean; otaSettled: boolean; status?: string; paidVia?: string };
const stays = (backup.invoices as Inv[]).filter((i) => i.date >= FROM && i.date <= TO && i.lines.some((l) => l.stream === "rooms")).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
const occupied = new Map<string, string>(); // `${room}:${night}` → legacy invoice id (double-booking guard)
let nGuests = 0, nBookings = 0, nPayments = 0, nFees = 0, grossTotal = 0, paidTotal = 0;
const skipped: string[] = [];

for (const inv of stays) {
  // Group lines by room; fold "additional bed" lines into the room line before them.
  const roomLines: { roomId: string; nights: number; rate: number; extras: string[] }[] = [];
  for (const l of inv.lines) {
    const key = l.desc.trim().toLowerCase();
    const roomId = ROOMS[key];
    if (roomId) { roomLines.push({ roomId, nights: l.qty, rate: l.rate, extras: [] }); continue; }
    const prev = roomLines[roomLines.length - 1];
    if (prev && /bed/i.test(l.desc)) { prev.rate += (l.rate * l.qty) / prev.nights; prev.extras.push(`${l.desc.trim()} ₹${l.rate}×${l.qty} folded into nightly rate`); continue; }
    skipped.push(`${inv.id} ${inv.guest}: non-room line "${l.desc}" ₹${l.rate}×${l.qty} not migrated`);
  }
  if (!roomLines.length) { skipped.push(`${inv.id} ${inv.guest}: no room lines`); continue; }
  // Nights per room: lines for the same room are consecutive nights starting at check-in.
  const perRoom = new Map<string, { nights: number; segments: { nights: number; ratePaise: number }[]; extras: string[] }>();
  for (const rl of roomLines) {
    const r = perRoom.get(rl.roomId) ?? { nights: 0, segments: [], extras: [] };
    r.segments.push({ nights: rl.nights, ratePaise: rupeesToPaise(rl.rate) }); r.nights += rl.nights; r.extras.push(...rl.extras);
    perRoom.set(rl.roomId, r);
  }
  const checkOut = inv.date;
  const stayNights = Math.max(...[...perRoom.values()].map((r) => r.nights));
  const checkIn = addDays(checkOut, -stayNights);
  const bid = `bkg_mig_${inv.id}`;

  // Inventory guard: AVOS Books never checked availability, so the same room type was occasionally sold twice
  // on one night. The stay is still migrated for the books; only the clashing room-night is left unreserved
  // (never for a future stay — those are reported instead so the owner can resolve them before arrival).
  const clashes: string[] = [];
  const reserve: [string, string][] = [];
  const roomStart = (r: { nights: number }) => addDays(checkOut, -r.nights); // shorter stays end at check-out
  for (const [roomId, r] of perRoom) for (const night of nightsOf(roomStart(r), checkOut)) {
    const k = `${roomId}:${night}`; const other = occupied.get(k);
    if (other) clashes.push(`${roomName(roomId)} on ${night} is also booked by ${other}`); else reserve.push([roomId, night]);
  }
  if (clashes.length && checkOut > TODAY) { skipped.push(`${inv.id} ${inv.guest} ${checkIn}: future stay clashes — ${clashes.join("; ")}`); continue; }
  for (const [roomId, night] of reserve) occupied.set(`${roomId}:${night}`, `${inv.guest.trim()} (${inv.id})`);
  if (clashes.length) report.push(`  ! ${inv.guest.trim()} ${checkIn}: ${clashes.join("; ")} — room-night not reserved, stay kept for the books`);

  // booking_rooms: one line per (room, legacy segment, GST slab); GST per night from the declared tariff.
  type BR = { roomId: string; nights: number; ratePaise: number; tariff: number | null; gstBp: number; total: number; gst: number; cmp: RateVsTariff };
  const brs: BR[] = [];
  for (const [roomId, r] of perRoom) {
    let offset = 0;
    const start = roomStart(r);
    for (const seg of r.segments) {
      const groups = new Map<string, BR>();
      for (const night of nightsOf(addDays(start, offset), addDays(start, offset + seg.nights))) {
        const tariff = tariffFor(CARDS, roomId, night);
        const cmp = compareToTariff(seg.ratePaise, tariff);
        const nl = computeRoomLine(POLICY, { roomId, nights: 1, nightlyRatePaise: seg.ratePaise, declaredTariffPaise: tariff ?? seg.ratePaise });
        const key = `${nl.gstRateBp}:${cmp}`;
        const g = groups.get(key) ?? { roomId, nights: 0, ratePaise: seg.ratePaise, tariff, gstBp: nl.gstRateBp, total: 0, gst: 0, cmp };
        g.nights += 1; g.total += nl.roomTotalPaise; g.gst += nl.gstPaise;
        groups.set(key, g);
      }
      brs.push(...groups.values()); offset += seg.nights;
    }
  }
  const roomTotal = brs.reduce((a, l) => a + l.total, 0), gst = brs.reduce((a, l) => a + l.gst, 0), gross = roomTotal + gst;
  const worst: RateVsTariff = brs.some((l) => l.cmp === "below") ? "below" : brs.some((l) => l.cmp === "above") ? "above" : brs.some((l) => l.cmp === "no_tariff") ? "no_tariff" : "on";
  const ch = CHANNELS[`${inv.channelId}:${inv.collection}`];
  if (!ch) { skipped.push(`${inv.id} ${inv.guest}: unknown channel ${inv.channelId}/${inv.collection}`); continue; }
  const isOta = ch.collection !== "direct";
  const decision = decideApproval(APPROVAL, brs.map((l) => ({ rateVsTariff: l.cmp })), { isOta });

  // Status from the calendar: past stays are checked out; in-house (including today's departures) are
  // checked in; today's arrivals and later stays wait for the front desk as approved.
  const status = checkOut < TODAY ? "checked_out" : checkIn < TODAY ? "checked_in" : "approved";
  const checkedInAt = status !== "approved" ? `${checkIn}T08:30:00.000Z` : null;   // 14:00 IST
  const checkedOutAt = status === "checked_out" ? `${checkOut}T05:30:00.000Z` : null; // 11:00 IST

  const gid = `gst_mig_${inv.id}`;
  const salesperson = SALES[inv.salespersonId] ?? null;
  const notes = [
    `${MIG} (invoice ${inv.id})`,
    `Legacy: channel ${inv.channelId}, ${inv.collection === "ota" ? "OTA collects" : "guest pays"}, commission ${inv.commissionPct}%` + (inv.salespersonId ? `, salesperson ${SALES_NAME[inv.salespersonId] ?? inv.salespersonId}` : "") + (inv.discount ? `, discount ₹${inv.discount}` : ""),
    ...[...perRoom.values()].flatMap((r) => r.extras),
    ...clashes.map((c) => `Legacy double-booking: ${c}; that room-night is not reserved in AVOS inventory`),
    ...(decision.mode === "manual" ? [`Would have needed approval: ${decision.reasons.join(", ")}`] : []),
  ].join("\n");
  sql.push(`-- ${inv.guest} · ${ch.name} · ${checkIn}→${checkOut} · ₹${(gross / 100).toFixed(2)}`);
  sql.push(`INSERT INTO guests (id, property_id, name, phone, email, notes) VALUES (${q(gid)}, ${q(PROPERTY)}, ${q(inv.guest.trim())}, NULL, NULL, ${q(MIG)});`);
  sql.push(`INSERT INTO bookings (id, property_id, guest_id, channel_id, external_ref, status, check_in, check_out, nights, adults, children, room_total_paise, gst_paise, gross_paise, rate_vs_tariff, approval_mode, approved_by, approved_at, salesperson_id, books_date, checked_in_at, checked_out_at, notes, created_by, created_at, updated_at)
VALUES (${q(bid)}, ${q(PROPERTY)}, ${q(gid)}, ${q(ch.id)}, ${q(inv.bookingRef?.trim() || null)}, ${q(status)}, ${q(checkIn)}, ${q(checkOut)}, ${stayNights}, 2, 0, ${roomTotal}, ${gst}, ${gross}, ${q(worst)}, 'migrated', ${q(OWNER)}, ${q(NOW)}, ${q(salesperson)}, ${q(checkOut)}, ${q(checkedInAt)}, ${q(checkedOutAt)}, ${q(notes)}, ${q(OWNER)}, ${q(NOW)}, ${q(NOW)});`);
  brs.forEach((l, i) => sql.push(`INSERT INTO booking_rooms (id, booking_id, room_id, nightly_rate_paise, tariff_rate_paise, gst_rate_bp, nights, room_total_paise, gst_paise) VALUES (${q(`brm_mig_${inv.id}_${i + 1}`)}, ${q(bid)}, ${q(l.roomId)}, ${l.ratePaise}, ${q(l.tariff)}, ${l.gstBp}, ${l.nights}, ${l.total}, ${l.gst});`));
  for (const [roomId, night] of reserve) {
    sql.push(`INSERT INTO room_nights (property_id, room_id, night, kind, booking_id) VALUES (${q(PROPERTY)}, ${q(roomId)}, ${q(night)}, 'booked', ${q(bid)});`);
  }
  sql.push(`INSERT INTO approvals (id, property_id, kind, ref_id, summary, amount_paise, status, requested_by, decided_by, decided_at, note) VALUES (${q(`apr_mig_${inv.id}`)}, ${q(PROPERTY)}, 'booking', ${q(bid)}, ${q(`${inv.guest.trim()} · ${ch.name} · ${checkIn}→${checkOut} · ${perRoom.size} room(s)`)}, ${gross}, 'auto', ${q(OWNER)}, ${q(OWNER)}, ${q(NOW)}, 'migrated from AVOS Books');`);
  audit("booking.migrate", "booking", bid, { legacy_invoice: inv.id, status, channel: ch.id, check_in: checkIn, check_out: checkOut, gross_paise: gross, rate_vs_tariff: worst, approval: decision });
  nGuests++; nBookings++; grossTotal += gross;

  // Payments and their one-time gateway fee.
  let paid = 0;
  for (const p of inv.payments) {
    const m = METHODS[p.method];
    if (!m) { skipped.push(`${inv.id} ${inv.guest}: payment ${p.id} unknown method ${p.method}`); continue; }
    const amount = rupeesToPaise(p.amount);
    const pid = `pay_mig_${p.id}`;
    const feeBp = p.feePct !== undefined ? Math.round(p.feePct * 100) : m.feeBp;
    let feeId: string | null = null;
    if (feeBp > 0) {
      feeId = `exp_mig_${p.id}`;
      sql.push(`INSERT INTO expenses (id, property_id, kind, category, description, amount_paise, gst_rate_bp, gst_paise, paid_from_account_id, on_date, payment_id, recorded_by, created_at) VALUES (${q(feeId)}, ${q(PROPERTY)}, 'gateway_fee', 'bank_charges', ${q(`${m.method} fee ${feeBp / 100}% on payment ${pid}`)}, ${applyBp(amount, feeBp)}, 0, 0, ${q(m.account)}, ${q(p.date)}, ${q(pid)}, ${q(OWNER)}, ${q(NOW)});`);
      nFees++;
    }
    const kind = p.date < checkIn ? "advance" : "balance";
    const reference = [p.ref?.trim(), p.provider && p.provider !== "Airpay" && p.provider !== "POS" ? p.provider : null].filter(Boolean).join(" · ") || null;
    sql.push(`INSERT INTO payments (id, property_id, booking_id, guest_id, kind, method, amount_paise, account_id, reference, received_on, status, fee_expense_id, recorded_by, idempotency_key, created_at) VALUES (${q(pid)}, ${q(PROPERTY)}, ${q(bid)}, ${q(gid)}, ${q(kind)}, ${q(m.method)}, ${amount}, ${q(m.account)}, ${q(reference)}, ${q(p.date)}, 'confirmed', ${q(feeId)}, ${q(OWNER)}, ${q(`avosbooks:${p.id}`)}, ${q(NOW)});`);
    audit("payment.migrate", "payment", pid, { legacy_payment: p.id, booking_id: bid, kind, method: m.method, amount_paise: amount, fee_expense_id: feeId, note: p.note ?? null });
    paid += amount; nPayments++;
  }
  paidTotal += paid;
  report.push(`${checkIn}→${checkOut}  ${inv.guest.trim().padEnd(26)} ${ch.name.padEnd(30)} ${status.padEnd(11)} rooms=${[...perRoom.keys()].map(roomName).join("+").padEnd(34)} gross=₹${(gross / 100).toFixed(2).padStart(10)} paid=₹${(paid / 100).toFixed(2).padStart(10)}${worst !== "on" ? ` rate ${worst}` : ""}`);
}

process.stdout.write(sql.join("\n") + "\n");
console.error(`\n${report.join("\n")}\n\nguests=${nGuests} bookings=${nBookings} payments=${nPayments} fee_expenses=${nFees} gross=₹${(grossTotal / 100).toFixed(2)} paid=₹${(paidTotal / 100).toFixed(2)}`);
if (skipped.length) console.error(`\nNOT MIGRATED:\n${skipped.join("\n")}`);
