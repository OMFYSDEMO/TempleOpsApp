import { newRouter, requireCap, body, str, optStr, int, date, oneOf, paise } from "../app";
import { Batch, HttpError, all, one, id } from "../db";
import { addHours, nightsOf, nowIso } from "../domain/dates";
import { computeRoomLine } from "../domain/gst";
import { normalisePhone } from "../domain/ids";
import { tariffFor, type RateCardRow } from "../domain/tariff";
import { conflicts, createBooking, gstPolicy } from "../services/bookings";
import { notifyRole } from "../services/notify";

const r = newRouter();
r.use("*", requireCap("leads"));

const SOURCES = ["instagram", "facebook", "website", "whatsapp", "phone", "walkin", "other"] as const;
const LOST = ["dates", "price", "no_reply", "expired", "other"] as const;

r.get("/", async (c) => {
  const p = c.get("property");
  const status = c.req.query("status");
  const rows = await all(c.env.DB,
    `SELECT l.*, g.name AS guest_name, g.phone AS guest_phone, u.name AS assigned_name,
            (SELECT COUNT(*) FROM bookings b WHERE b.guest_id = l.guest_id AND b.status IN ('checked_out')) AS past_stays
     FROM leads l LEFT JOIN guests g ON g.id = l.guest_id LEFT JOIN users u ON u.id = l.assigned_to
     WHERE l.property_id = ? ${status ? "AND l.status = ?" : "AND l.status NOT IN ('won','lost')"}
     ORDER BY l.created_at DESC LIMIT 200`,
    ...(status ? [p.id, status] : [p.id]));
  return c.json({ leads: rows, now: nowIso() });
});

/** Funnel measured from the books: leads → won → revenue (gross of the bookings they became). */
r.get("/funnel", async (c) => {
  const p = c.get("property");
  const from = c.req.query("from") ?? "0000-00-00";
  const to = c.req.query("to") ?? "9999-99-99";
  const rows = await all(c.env.DB,
    `SELECT l.source,
            COUNT(*) AS leads,
            SUM(CASE WHEN l.status = 'won' THEN 1 ELSE 0 END) AS won,
            SUM(CASE WHEN l.status = 'lost' THEN 1 ELSE 0 END) AS lost,
            SUM(CASE WHEN l.status IN ('new','contacted','quoted','hold') THEN 1 ELSE 0 END) AS open,
            COALESCE(SUM(CASE WHEN b.status NOT IN ('cancelled','no_show') THEN b.gross_paise ELSE 0 END), 0) AS revenue_paise
     FROM leads l LEFT JOIN bookings b ON b.id = l.booking_id
     WHERE l.property_id = ? AND substr(l.created_at,1,10) BETWEEN ? AND ?
     GROUP BY l.source ORDER BY revenue_paise DESC`, p.id, from, to);
  return c.json({ funnel: rows });
});

r.post("/", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const x = await body(c);
  const source = oneOf(x.source, "source", SOURCES);
  const name = str(x.name, "name");
  const phone = normalisePhone(optStr(x.phone, "phone"));
  const b = new Batch(c.env.DB, actor);
  let guestId: string | null = null;
  if (phone) guestId = (await one<{ id: string }>(c.env.DB, "SELECT id FROM guests WHERE property_id = ? AND phone = ?", p.id, phone))?.id ?? null;
  if (!guestId) { guestId = id("gst"); b.add("INSERT INTO guests (id, property_id, name, phone, email) VALUES (?,?,?,?,?)", guestId, p.id, name, phone, optStr(x.email, "email")); }
  const lid = id("led");
  const assigned = optStr(x.assigned_to, "assigned_to") ?? (actor.role === "sales" ? actor.id : null);
  b.add(`INSERT INTO leads (id, property_id, guest_id, source, status, check_in, check_out, rooms_wanted, adults, children, notes, assigned_to, external_ref, campaign)
         VALUES (?,?,?,?,'new',?,?,?,?,?,?,?,?,?)`,
    lid, p.id, guestId, source, optStr(x.check_in, "check_in"), optStr(x.check_out, "check_out"), int(x.rooms_wanted ?? 1, "rooms_wanted", { min: 1 }),
    int(x.adults ?? 2, "adults", { min: 1 }), int(x.children ?? 0, "children", { min: 0, optional: true }), optStr(x.notes, "notes"), assigned, optStr(x.external_ref, "external_ref"), optStr(x.campaign, "campaign"));
  b.audit("lead.create", "lead", lid, null, { source, name, phone });
  await b.run();
  return c.json({ id: lid, guest_id: guestId }, 201);
});

async function loadLead(db: D1Database, propertyId: string, leadId: string) {
  const l = await one<any>(db, "SELECT l.*, g.name AS guest_name, g.phone AS guest_phone FROM leads l LEFT JOIN guests g ON g.id = l.guest_id WHERE l.id = ? AND l.property_id = ?", leadId, propertyId);
  if (!l) throw new HttpError(404, "lead not found");
  return l;
}

r.post("/:id/contacted", async (c) => {
  const p = c.get("property"); const l = await loadLead(c.env.DB, p.id, c.req.param("id"));
  if (l.status !== "new") throw new HttpError(409, `lead is ${l.status}`);
  const now = nowIso();
  const b = new Batch(c.env.DB, c.get("actor"));
  b.add("UPDATE leads SET status = 'contacted', first_response_at = COALESCE(first_response_at, ?), updated_at = ? WHERE id = ?", now, now, l.id);
  b.audit("lead.contacted", "lead", l.id, { status: l.status }, { status: "contacted" });
  await b.run();
  return c.json({ ok: true });
});

/** Compose a quote from the rate card: rooms × nights at tariff, GST per night. Nothing is held yet. */
r.post("/:id/quote", async (c) => {
  const p = c.get("property"); const l = await loadLead(c.env.DB, p.id, c.req.param("id"));
  if (!["new", "contacted", "quoted"].includes(l.status)) throw new HttpError(409, `lead is ${l.status}`);
  const x = await body(c);
  const checkIn = date(x.check_in ?? l.check_in, "check_in"); const checkOut = date(x.check_out ?? l.check_out, "check_out");
  const roomIds: string[] = Array.isArray(x.room_ids) ? x.room_ids.map(String) : [];
  if (!roomIds.length) throw new HttpError(400, "room_ids required");
  const overrides: Record<string, number> = (x.rates as Record<string, number>) ?? {};
  const cards = await all<RateCardRow>(c.env.DB, "SELECT room_id, rate_paise, from_date, to_date, priority FROM rate_cards WHERE property_id = ?", p.id);
  const rooms = await all<{ id: string; name: string }>(c.env.DB, `SELECT id, name FROM locations WHERE property_id = ? AND kind = 'room' AND id IN (${roomIds.map(() => "?").join(",")})`, p.id, ...roomIds);
  if (rooms.length !== roomIds.length) throw new HttpError(400, "unknown room");
  const taken = await conflicts(c.env.DB, p.id, roomIds, checkIn, checkOut, { ignoreLeadId: l.id });
  const policy = gstPolicy(p);
  const lines = rooms.map((room) => {
    let roomTotal = 0, gst = 0, onTariff = true; const nights = nightsOf(checkIn, checkOut);
    let rate: number | null = null;
    for (const n of nights) {
      const tariff = tariffFor(cards, room.id, n);
      const sold = overrides[room.id] ?? tariff;
      if (sold === null || sold === undefined) throw new HttpError(400, `no tariff for ${room.name} on ${n}; pass rates[${room.id}]`);
      if (tariff !== null && Math.abs(sold - tariff) > 100) onTariff = false;
      const line = computeRoomLine(policy, { roomId: room.id, nights: 1, nightlyRatePaise: sold, declaredTariffPaise: tariff ?? sold });
      roomTotal += line.roomTotalPaise; gst += line.gstPaise; rate = sold;
    }
    return { room_id: room.id, room_name: room.name, nights: nights.length, nightly_rate_paise: rate, room_total_paise: roomTotal, gst_paise: gst, on_tariff: onTariff };
  });
  const total = lines.reduce((a, q) => a + q.room_total_paise + q.gst_paise, 0);
  const expires = addHours(nowIso(), p.quote_valid_hours);
  const quote = { check_in: checkIn, check_out: checkOut, lines, room_total_paise: lines.reduce((a, q) => a + q.room_total_paise, 0), gst_paise: lines.reduce((a, q) => a + q.gst_paise, 0), total_paise: total, gst_applicable: !!p.gstin, on_tariff: lines.every((q) => q.on_tariff), availability_conflicts: taken };
  const b = new Batch(c.env.DB, c.get("actor"));
  b.add("UPDATE leads SET status = 'quoted', check_in = ?, check_out = ?, rooms_wanted = ?, quote_json = ?, quote_total_paise = ?, quote_expires_at = ?, first_response_at = COALESCE(first_response_at, ?), updated_at = ? WHERE id = ?",
    checkIn, checkOut, roomIds.length, JSON.stringify(quote), total, expires, nowIso(), nowIso(), l.id);
  b.audit("lead.quote", "lead", l.id, { status: l.status }, { status: "quoted", total_paise: total, expires_at: expires });
  await b.run();
  const guestFirst = (l.guest_name as string).split(" ")[0];
  const waText = `Hi ${guestFirst}, thank you for your enquiry at ${p.name}. ${lines.map((q) => `${q.room_name} × ${q.nights} night(s) @ ₹${(q.nightly_rate_paise! / 100).toLocaleString("en-IN")}`).join(", ")}. Total ₹${(total / 100).toLocaleString("en-IN")}${p.gstin ? " incl. GST" : ""}, valid ${p.quote_valid_hours} h. Reply to confirm and we will hold the rooms.`;
  const wa = l.guest_phone ? `https://wa.me/${l.guest_phone}?text=${encodeURIComponent(waText)}` : null;
  return c.json({ quote, expires_at: expires, whatsapp_url: wa, whatsapp_text: waText });
});

/** Hold: the quoted rooms occupy inventory until the hold expires (F1/F8). */
r.post("/:id/hold", async (c) => {
  const p = c.get("property"); const l = await loadLead(c.env.DB, p.id, c.req.param("id"));
  if (l.status !== "quoted") throw new HttpError(409, "quote first, then hold");
  const q = JSON.parse(l.quote_json);
  const roomIds = q.lines.map((x: any) => x.room_id);
  const taken = await conflicts(c.env.DB, p.id, roomIds, q.check_in, q.check_out, { ignoreLeadId: l.id });
  if (taken.length) throw new HttpError(409, "room not available", { nights: taken });
  const expires = addHours(nowIso(), p.hold_hours);
  const b = new Batch(c.env.DB, c.get("actor"));
  b.add("DELETE FROM room_nights WHERE property_id = ? AND lead_id = ?", p.id, l.id);
  b.add("DELETE FROM room_nights WHERE property_id = ? AND kind = 'hold' AND expires_at < ?", p.id, nowIso());
  for (const rid of roomIds) for (const n of nightsOf(q.check_in, q.check_out))
    b.add("INSERT INTO room_nights (property_id, room_id, night, kind, lead_id, expires_at) VALUES (?,?,?,'hold',?,?)", p.id, rid, n, l.id, expires);
  b.add("UPDATE leads SET status = 'hold', hold_expires_at = ?, updated_at = ? WHERE id = ?", expires, nowIso(), l.id);
  b.audit("lead.hold", "lead", l.id, { status: "quoted" }, { status: "hold", expires_at: expires, rooms: roomIds });
  await b.run();
  return c.json({ hold_expires_at: expires });
});

/** Won: the quote becomes a booking through the same path as every other booking. */
r.post("/:id/won", async (c) => {
  const p = c.get("property"); const l = await loadLead(c.env.DB, p.id, c.req.param("id"));
  if (!["quoted", "hold"].includes(l.status)) throw new HttpError(409, "quote first");
  const q = JSON.parse(l.quote_json);
  const x = await body(c).catch(() => ({} as Record<string, unknown>));
  const result = await createBooking(c.env.DB, c.get("actor"), p, {
    guest: { id: l.guest_id, name: l.guest_name },
    channelCode: "direct",
    checkIn: q.check_in, checkOut: q.check_out, adults: l.adults, children: l.children,
    rooms: q.lines.map((ln: any) => ({ roomId: ln.room_id, nightlyRatePaise: ln.nightly_rate_paise })),
    leadId: l.id, salespersonId: l.assigned_to, notes: optStr(x.notes, "notes"), isOta: false,
  });
  return c.json({ booking: result }, 201);
});

r.post("/:id/lost", async (c) => {
  const p = c.get("property"); const l = await loadLead(c.env.DB, p.id, c.req.param("id"));
  if (["won", "lost"].includes(l.status)) throw new HttpError(409, `lead is ${l.status}`);
  const x = await body(c);
  const reason = oneOf(x.reason, "reason", LOST);
  const b = new Batch(c.env.DB, c.get("actor"));
  b.add("DELETE FROM room_nights WHERE property_id = ? AND lead_id = ?", p.id, l.id);
  b.add("UPDATE leads SET status = 'lost', lost_reason = ?, hold_expires_at = NULL, updated_at = ? WHERE id = ?", reason, nowIso(), l.id);
  b.audit("lead.lost", "lead", l.id, { status: l.status }, { status: "lost", reason });
  await b.run();
  return c.json({ ok: true });
});

r.patch("/:id", async (c) => {
  const p = c.get("property"); const l = await loadLead(c.env.DB, p.id, c.req.param("id"));
  const x = await body(c);
  const b = new Batch(c.env.DB, c.get("actor"));
  const after: Record<string, unknown> = {};
  if (x.assigned_to !== undefined) { after.assigned_to = optStr(x.assigned_to, "assigned_to"); }
  if (x.notes !== undefined) after.notes = optStr(x.notes, "notes");
  if (x.check_in !== undefined) after.check_in = optStr(x.check_in, "check_in");
  if (x.check_out !== undefined) after.check_out = optStr(x.check_out, "check_out");
  if (x.rooms_wanted !== undefined) after.rooms_wanted = int(x.rooms_wanted, "rooms_wanted", { min: 1 });
  if (!Object.keys(after).length) throw new HttpError(400, "nothing to update");
  const sets = Object.keys(after).map((k) => `${k} = ?`).join(", ");
  b.add(`UPDATE leads SET ${sets}, updated_at = ? WHERE id = ?`, ...Object.values(after), nowIso(), l.id);
  b.audit("lead.update", "lead", l.id, Object.fromEntries(Object.keys(after).map((k) => [k, l[k]])), after);
  await b.run();
  return c.json({ ok: true });
});

export default r;
export { paise as _unused };
