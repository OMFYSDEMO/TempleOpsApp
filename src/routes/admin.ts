import { newRouter, requireCap, body, str, optStr, int, oneOf, paise, optDate } from "../app";
import { Batch, HttpError, all, one, id } from "../db";
import { gstinFormatValid } from "../domain/gst";
import { CAN } from "../auth";
import { todayIn } from "../domain/dates";
import { setPassword, createPasswordLink } from "./auth";
import { EXPENSE_CATEGORIES, EXPENSE_FAMILIES, COMMON_PETTY, COMMON_BANK } from "../domain/expenseCategories";

const r = newRouter();

/** Who am I, what may I do, and the reference data every screen needs. */
r.get("/me", async (c) => {
  const actor = c.get("actor"); const p = c.get("property");
  const caps = Object.entries(CAN).filter(([, roles]) => roles.includes(actor.role)).map(([k]) => k);
  const unread = await one<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL", actor.id);
  const cred = await one<{ must_change: number }>(c.env.DB, "SELECT must_change FROM credentials WHERE user_id = ?", actor.id);
  return c.json({ must_change_password: !!cred?.must_change, has_password: !!cred, actor, property: { id: p.id, name: p.name, gstin: p.gstin, timezone: p.timezone, today: todayIn(p.timezone), invoice_prefix: p.invoice_prefix, auto_approve_on_tariff: p.auto_approve_on_tariff === 1 }, capabilities: caps, unread_notifications: unread?.n ?? 0 });
});

r.get("/ref", async (c) => {
  const p = c.get("property");
  const [locations, channels, accounts, users, rateCards] = await Promise.all([
    all(c.env.DB, "SELECT id, kind, code, name, sort FROM locations WHERE property_id = ? AND active = 1 ORDER BY kind DESC, sort", p.id),
    all(c.env.DB, "SELECT id, code, name, collection_type, commission_bp, payment_fee_bp, tcs_bp, tds_bp FROM channels WHERE property_id = ? AND active = 1", p.id),
    all(c.env.DB, "SELECT id, kind, name, holder_role FROM money_accounts WHERE property_id = ? AND active = 1", p.id),
    all(c.env.DB, "SELECT id, name, role FROM users WHERE property_id = ? AND active = 1", p.id),
    all(c.env.DB, "SELECT id, room_id, name, rate_paise, from_date, to_date, priority FROM rate_cards WHERE property_id = ? ORDER BY room_id, priority", p.id),
  ]);
  return c.json({ locations, channels, accounts, users, rate_cards: rateCards, expense_categories: EXPENSE_CATEGORIES, expense_families: EXPENSE_FAMILIES, common_categories: { petty: COMMON_PETTY, bank: COMMON_BANK } });
});

r.get("/notifications", async (c) => {
  const actor = c.get("actor");
  const rows = await all(c.env.DB, "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50", actor.id);
  return c.json({ notifications: rows });
});
r.post("/notifications/read", async (c) => {
  const actor = c.get("actor");
  const x = await body(c).catch(() => ({} as Record<string, unknown>));
  const ids: string[] = Array.isArray(x.ids) ? x.ids.map(String) : [];
  const b = new Batch(c.env.DB, actor);
  if (ids.length) b.add(`UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`, actor.id, ...ids);
  else b.add("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL", actor.id);
  await b.run();
  return c.json({ ok: true });
});

// ---- Files (bill photos, task photos) in private R2; served only through the role-checked API ----
r.post("/files", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const ct = c.req.header("content-type") ?? "application/octet-stream";
  if (!/^image\/(jpeg|png|webp|heic)|application\/pdf/.test(ct)) throw new HttpError(400, "upload an image or PDF with the right content-type");
  const purpose = c.req.query("purpose") ?? "bill";
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > 8 * 1024 * 1024) throw new HttpError(413, "max 8 MB");
  const key = `${purpose}/${p.id}/${todayIn(p.timezone).slice(0, 7)}/${id("f")}.${ct.includes("pdf") ? "pdf" : ct.split("/")[1].replace("jpeg", "jpg")}`;
  await c.env.FILES.put(key, buf, { httpMetadata: { contentType: ct }, customMetadata: { uploaded_by: actor.id } });
  return c.json({ key }, 201);
});
r.get("/files/*", async (c) => {
  const p = c.get("property");
  const key = c.req.path.replace(/^\/api\/files\//, "");
  if (!key.split("/")[1] || key.split("/")[1] !== p.id) throw new HttpError(403, "not your property's file");
  const obj = await c.env.FILES.get(key);
  if (!obj) throw new HttpError(404, "file not found");
  return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream", "cache-control": "private, max-age=3600" } });
});

// ---- Owner admin: users, property settings, rate cards, channels ----
const admin = newRouter();
admin.use("*", requireCap("admin"));
admin.get("/users", async (c) => c.json({ users: await all(c.env.DB, "SELECT id, email, name, role, phone, active, created_at FROM users WHERE property_id = ? ORDER BY role, name", c.get("property").id) }));
admin.post("/users", async (c) => {
  const p = c.get("property"); const x = await body(c);
  const uid = id("usr");
  const b = new Batch(c.env.DB, c.get("actor"));
  b.add("INSERT INTO users (id, property_id, email, name, role, phone) VALUES (?,?,?,?,?,?)", uid, p.id, str(x.email, "email").toLowerCase(), str(x.name, "name"), oneOf(x.role, "role", ["sales", "property", "revenue", "owner", "accountant"] as const), optStr(x.phone, "phone"));
  b.audit("user.create", "user", uid, null, { email: x.email, role: x.role });
  await b.run();
  return c.json({ id: uid }, 201);
});
admin.patch("/users/:id", async (c) => {
  const p = c.get("property"); const actor = c.get("actor"); const x = await body(c);
  const u: any = await one(c.env.DB, "SELECT * FROM users WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!u) throw new HttpError(404, "user not found");
  const after: Record<string, unknown> = {};
  if (x.role !== undefined) after.role = oneOf(x.role, "role", ["sales", "property", "revenue", "owner", "accountant"] as const);
  if (x.active !== undefined) after.active = x.active ? 1 : 0;
  if (x.name !== undefined) after.name = str(x.name, "name");
  if (x.phone !== undefined) after.phone = optStr(x.phone, "phone");
  if (u.id === actor.id && (after.active === 0 || (after.role && after.role !== "owner"))) throw new HttpError(400, "you cannot demote or deactivate yourself");
  if (!Object.keys(after).length) throw new HttpError(400, "nothing to update");
  const b = new Batch(c.env.DB, actor);
  b.add(`UPDATE users SET ${Object.keys(after).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...Object.values(after), u.id);
  b.audit("user.update", "user", u.id, Object.fromEntries(Object.keys(after).map((k) => [k, u[k]])), after);
  await b.run();
  return c.json({ ok: true });
});
/** Owner sets a temporary password; the user must change it at first sign-in. */
admin.post("/users/:id/set-password", async (c) => {
  const p = c.get("property"); const actor = c.get("actor"); const x = await body(c);
  const u = await one<{ id: string; email: string }>(c.env.DB, "SELECT id, email FROM users WHERE id = ? AND property_id = ? AND active = 1", c.req.param("id"), p.id);
  if (!u) throw new HttpError(404, "user not found");
  await setPassword(c.env.DB, u.id, str(x.password, "password"), x.must_change !== false, actor, "password.set_by_owner");
  return c.json({ ok: true, must_change: x.must_change !== false });
});
/** Owner gets a one-time set-password link to hand to the user (valid 72 h). */
admin.post("/users/:id/password-link", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const u = await one<{ id: string; email: string }>(c.env.DB, "SELECT id, email FROM users WHERE id = ? AND property_id = ? AND active = 1", c.req.param("id"), p.id);
  if (!u) throw new HttpError(404, "user not found");
  const link = await createPasswordLink(c.env.DB, c.env, c.req.raw, u.id, "invite", actor.id);
  const b = new Batch(c.env.DB, actor); b.audit("password.link", "user", u.id, null, { by: actor.id }); await b.run();
  return c.json({ link, expires_in_hours: 72, email: u.email });
});
admin.get("/users/:id/sessions", async (c) => {
  const p = c.get("property");
  const rows = await all(c.env.DB, "SELECT s.created_at, s.last_seen_at, s.expires_at, s.user_agent, s.revoked_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.property_id = ? AND s.user_id = ? ORDER BY s.created_at DESC LIMIT 20", p.id, c.req.param("id"));
  return c.json({ sessions: rows });
});
admin.post("/users/:id/sign-out-everywhere", async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const b = new Batch(c.env.DB, actor);
  b.add("UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE property_id = ?)", c.req.param("id"), p.id);
  b.audit("sessions.revoke_all", "user", c.req.param("id"), null, null);
  await b.run();
  return c.json({ ok: true });
});
admin.get("/property", async (c) => c.json({ property: c.get("property") }));
admin.patch("/property", async (c) => {
  const p = c.get("property"); const x = await body(c);
  const after: Record<string, unknown> = {};
  for (const k of ["name", "legal_name", "address", "state_code", "invoice_prefix"]) if (x[k] !== undefined) after[k] = optStr(x[k], k);
  if (x.gstin !== undefined) { const g = optStr(x.gstin, "gstin"); if (g && !gstinFormatValid(g)) throw new HttpError(400, "GSTIN format invalid"); after.gstin = g?.toUpperCase() ?? null; }
  for (const k of ["gst_threshold_paise", "gst_rate_below_bp", "gst_rate_above_bp", "auto_approve_max_rooms", "quote_valid_hours", "hold_hours", "lead_nudge_minutes", "lead_escalate_minutes", "recon_fee_tolerance_bp", "recon_subset_tolerance_bp"]) if (x[k] !== undefined) after[k] = int(x[k], k, { min: 0 });
  if (x.auto_approve_on_tariff !== undefined) after.auto_approve_on_tariff = x.auto_approve_on_tariff ? 1 : 0;
  if (x.inbox_automation !== undefined) after.inbox_automation = x.inbox_automation ? 1 : 0;
  if (!Object.keys(after).length) throw new HttpError(400, "nothing to update");
  const b = new Batch(c.env.DB, c.get("actor"));
  b.add(`UPDATE properties SET ${Object.keys(after).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...Object.values(after), p.id);
  b.audit("property.update", "property", p.id, Object.fromEntries(Object.keys(after).map((k) => [k, (p as any)[k]])), after);
  await b.run();
  return c.json({ ok: true });
});
admin.post("/rate-cards", async (c) => {
  const p = c.get("property"); const x = await body(c);
  const room = await one(c.env.DB, "SELECT id FROM locations WHERE id = ? AND property_id = ? AND kind = 'room'", str(x.room_id, "room_id"), p.id);
  if (!room) throw new HttpError(400, "unknown room");
  const rid = id("rc");
  const b = new Batch(c.env.DB, c.get("actor"));
  b.add("INSERT INTO rate_cards (id, property_id, room_id, name, rate_paise, from_date, to_date, priority) VALUES (?,?,?,?,?,?,?,?)", rid, p.id, x.room_id, str(x.name, "name"), paise(x.rate_paise, "rate_paise"), optDate(x.from_date, "from_date"), optDate(x.to_date, "to_date"), int(x.priority ?? 0, "priority", { min: 0, optional: true }));
  b.audit("rate_card.create", "rate_card", rid, null, x);
  await b.run();
  return c.json({ id: rid }, 201);
});
admin.delete("/rate-cards/:id", async (c) => {
  const p = c.get("property");
  const b = new Batch(c.env.DB, c.get("actor"));
  b.add("DELETE FROM rate_cards WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  b.audit("rate_card.delete", "rate_card", c.req.param("id"), null, null);
  await b.run();
  return c.json({ ok: true });
});
admin.patch("/channels/:id", async (c) => {
  const p = c.get("property"); const x = await body(c);
  const ch: any = await one(c.env.DB, "SELECT * FROM channels WHERE id = ? AND property_id = ?", c.req.param("id"), p.id);
  if (!ch) throw new HttpError(404, "channel not found");
  const after: Record<string, unknown> = {};
  for (const k of ["commission_bp", "payment_fee_bp", "tcs_bp", "tds_bp"]) if (x[k] !== undefined) after[k] = int(x[k], k, { min: 0, max: 5000 });
  for (const k of ["commission_base", "payment_fee_base", "tcs_base", "tds_base"]) if (x[k] !== undefined) after[k] = oneOf(x[k], k, ["ex_gst", "gross"] as const);
  if (x.collection_type !== undefined) after.collection_type = oneOf(x.collection_type, "collection_type", ["direct", "channel_collect", "hotel_collect"] as const);
  if (x.name !== undefined) after.name = str(x.name, "name");
  if (!Object.keys(after).length) throw new HttpError(400, "nothing to update");
  const b = new Batch(c.env.DB, c.get("actor"));
  b.add(`UPDATE channels SET ${Object.keys(after).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...Object.values(after), ch.id);
  b.audit("channel.update", "channel", ch.id, Object.fromEntries(Object.keys(after).map((k) => [k, ch[k]])), after);
  await b.run();
  return c.json({ ok: true });
});
r.route("/admin", admin);

export default r;
