import { newRouter, requireCap, body, str, optStr, oneOf } from "../app";
import { Batch, HttpError, all, one, id } from "../db";
import { nowIso, todayIn } from "../domain/dates";
import { loadBooking as loadBookingRow } from "../services/bookings";

/** The booking with its guest's name, which the audit lines and the default person name need. */
async function loadBooking(db: D1Database, propertyId: string, bookingId: string): Promise<any> {
  const bk: any = await loadBookingRow(db, propertyId, bookingId);
  const g = await one<{ name: string }>(db, "SELECT name FROM guests WHERE id = ?", bk.guest_id);
  return { ...bk, guest_name: g?.name ?? "Guest" };
}
import { notifyRole } from "../services/notify";
import { ARCHIVE_AFTER_HOURS, driveConfigured, driveIntegration } from "../services/drive";

/**
 * Proof of identity at the front desk and Form C for foreign nationals.
 *
 * Property desk photographs the documents at check-in (Aadhaar, passport, driving licence or voter ID for
 * Indian guests; passport photo page, visa and arrival stamp for foreigners). Foreign stays need Form C on
 * the FRRO portal within 24 hours of arrival: sales files it and records the acknowledgement here. Files
 * stay in private R2 while the guest is in house and move to the owner's Google Drive 48 hours after the
 * stay ends (see services/drive.ts). Sales, property, revenue and owner may view; accountant may not.
 */
const r = newRouter();

export const DOC_TYPES = ["aadhaar", "passport", "driving_licence", "voter_id", "visa", "arrival_stamp", "other"] as const;
export const FORM_C_HOURS = 24;

const docCols = "id, booking_id, person_name, nationality, doc_type, note, content_type, bytes, captured_by, captured_at, drive_link, archived_at, (r2_key IS NOT NULL) AS on_file_here";

async function idState(db: D1Database, bookingId: string) {
  const bk: any = await one(db, "SELECT guest_nationality, form_c_status, form_c_reference, form_c_filed_at, form_c_filed_by, ids_archived_at, drive_folder_id, status, check_in, checked_in_at FROM bookings WHERE id = ?", bookingId);
  const docs = await all<any>(db, `SELECT ${docCols} FROM guest_documents WHERE booking_id = ? AND deleted_at IS NULL ORDER BY captured_at`, bookingId);
  return { ...bk, documents: docs };
}

/** What the desk and sales see for one stay. */
r.get("/bookings/:id", requireCap("ids_view"), async (c) => {
  const p = c.get("property");
  const bk = await loadBooking(c.env.DB, p.id, c.req.param("id"));
  return c.json(await idState(c.env.DB, bk.id));
});

/** Indian or foreign national: foreign switches Form C on (due), back to Indian switches it off unless already filed. */
r.post("/bookings/:id/nationality", requireCap("ids_capture"), async (c) => {
  const p = c.get("property"); const actor = c.get("actor"); const x = await body(c);
  const bk: any = await loadBooking(c.env.DB, p.id, c.req.param("id"));
  const nat = oneOf(x.nationality, "nationality", ["indian", "foreign"] as const);
  const formC = nat === "foreign" ? (bk.form_c_status === "filed" ? "filed" : "due") : (bk.form_c_status === "filed" ? "filed" : "none");
  const b = new Batch(c.env.DB, actor);
  b.add("UPDATE bookings SET guest_nationality = ?, form_c_status = ?, updated_at = ? WHERE id = ?", nat, formC, nowIso(), bk.id);
  b.audit("booking.nationality", "booking", bk.id, { guest_nationality: bk.guest_nationality, form_c_status: bk.form_c_status }, { guest_nationality: nat, form_c_status: formC });
  // Marked foreign by mistake and switched back: withdraw the Form C messages it sent (unread ones), including the overdue escalation.
  if (bk.form_c_status === "due" && formC === "none") {
    b.add("DELETE FROM notifications WHERE read_at IS NULL AND ((kind = 'form_c_due' AND ref_id = ?) OR (ref_kind = 'work' AND ref_id = ?))", bk.id, `formc:${bk.id}`);
  }
  if (nat === "foreign" && bk.form_c_status !== "due" && formC === "due") await notifyRole(b, p.id, "sales", "form_c_due", `Form C to file for ${bk.guest_name ?? "a foreign guest"} · within ${FORM_C_HOURS} h of arrival`, { kind: "booking", id: bk.id });
  await b.run();
  return c.json({ ok: true, guest_nationality: nat, form_c_status: formC });
});

/** One photo or PDF of one document. Body is the file; details ride on the query string so a phone can post the camera capture straight. */
r.post("/bookings/:id/documents", requireCap("ids_capture"), async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const bk: any = await loadBooking(c.env.DB, p.id, c.req.param("id"));
  if (["cancelled", "no_show"].includes(bk.status)) throw new HttpError(409, `booking is ${bk.status}`);
  if (bk.ids_archived_at) throw new HttpError(409, "this stay's documents were already archived to Drive");
  const ct = c.req.header("content-type") ?? "application/octet-stream";
  if (!/^image\/(jpeg|png|webp|heic)|application\/pdf/.test(ct)) throw new HttpError(400, "upload a photo (JPEG/PNG/WebP/HEIC) or a PDF with the right content-type");
  const q = c.req.query();
  const docType = oneOf(q.doc_type, "doc_type", DOC_TYPES);
  const nationality = oneOf(q.nationality ?? bk.guest_nationality, "nationality", ["indian", "foreign"] as const);
  const person = str(q.person_name ?? bk.guest_name, "person_name", { max: 120 });
  const note = optStr(q.note ?? null, "note");
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength < 100) throw new HttpError(400, "empty file");
  if (buf.byteLength > 12 * 1024 * 1024) throw new HttpError(413, "max 12 MB");
  const did = id("doc");
  const key = `ids/${p.id}/${bk.id}/${did}.${ct.includes("pdf") ? "pdf" : ct.split("/")[1].replace("jpeg", "jpg")}`;
  await c.env.FILES.put(key, buf, { httpMetadata: { contentType: ct }, customMetadata: { uploaded_by: actor.id, booking_id: bk.id } });
  const b = new Batch(c.env.DB, actor);
  b.add("INSERT INTO guest_documents (id, property_id, booking_id, person_name, nationality, doc_type, note, r2_key, content_type, bytes, captured_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)", did, p.id, bk.id, person, nationality, docType, note, key, ct, buf.byteLength, actor.id);
  // A foreign document on a stay still marked Indian flips the stay to foreign and opens Form C.
  if (nationality === "foreign" && bk.guest_nationality !== "foreign") {
    const formC = bk.form_c_status === "filed" ? "filed" : "due";
    b.add("UPDATE bookings SET guest_nationality = 'foreign', form_c_status = ?, updated_at = ? WHERE id = ?", formC, nowIso(), bk.id);
    if (formC === "due") await notifyRole(b, p.id, "sales", "form_c_due", `Form C to file for ${bk.guest_name} · within ${FORM_C_HOURS} h of arrival`, { kind: "booking", id: bk.id });
  }
  b.audit("iddoc.capture", "guest_document", did, null, { booking_id: bk.id, person_name: person, nationality, doc_type: docType, bytes: buf.byteLength });
  await b.run();
  return c.json(await idState(c.env.DB, bk.id), 201);
});

/** The file itself, streamed from R2 (in house) or redirected to Drive (archived). Never cached by shared caches. */
r.get("/documents/:id/file", requireCap("ids_view"), async (c) => {
  const p = c.get("property");
  const d: any = await one(c.env.DB, "SELECT * FROM guest_documents WHERE id = ? AND property_id = ? AND deleted_at IS NULL", c.req.param("id"), p.id);
  if (!d) throw new HttpError(404, "document not found");
  if (!d.r2_key) { if (d.drive_link) return c.redirect(d.drive_link, 302); throw new HttpError(410, "archived; file no longer held here"); }
  const obj = await c.env.FILES.get(d.r2_key);
  if (!obj) throw new HttpError(404, "file missing");
  return new Response(obj.body, { headers: { "content-type": d.content_type, "cache-control": "private, no-store", "content-disposition": `inline; filename="${d.person_name.replace(/[^\w .-]/g, "")}-${d.doc_type}"` } });
});

/** Remove a wrong capture (blurred, wrong guest). Only while the file is still here. */
r.delete("/documents/:id", requireCap("ids_capture"), async (c) => {
  const p = c.get("property"); const actor = c.get("actor");
  const d: any = await one(c.env.DB, "SELECT * FROM guest_documents WHERE id = ? AND property_id = ? AND deleted_at IS NULL", c.req.param("id"), p.id);
  if (!d) throw new HttpError(404, "document not found");
  if (!d.r2_key) throw new HttpError(409, "already archived to Drive; remove it there");
  await c.env.FILES.delete(d.r2_key);
  const b = new Batch(c.env.DB, actor);
  b.add("UPDATE guest_documents SET deleted_at = ?, r2_key = NULL WHERE id = ?", nowIso(), d.id);
  b.audit("iddoc.delete", "guest_document", d.id, { booking_id: d.booking_id, doc_type: d.doc_type, person_name: d.person_name }, null);
  await b.run();
  return c.json({ ok: true });
});

/** Sales files Form C on the FRRO portal and records the acknowledgement here. */
r.post("/bookings/:id/form-c", requireCap("form_c"), async (c) => {
  const p = c.get("property"); const actor = c.get("actor"); const x = await body(c);
  const bk: any = await loadBooking(c.env.DB, p.id, c.req.param("id"));
  if (bk.guest_nationality !== "foreign") throw new HttpError(409, "Form C applies to foreign nationals; mark the stay foreign first");
  const ref = str(x.reference, "reference", { max: 80 });
  const now = nowIso();
  const b = new Batch(c.env.DB, actor);
  b.add("UPDATE bookings SET form_c_status = 'filed', form_c_reference = ?, form_c_filed_at = ?, form_c_filed_by = ?, updated_at = ? WHERE id = ?", ref, now, actor.id, now, bk.id);
  b.audit("booking.form_c_filed", "booking", bk.id, { form_c_status: bk.form_c_status }, { form_c_status: "filed", reference: ref });
  await b.run();
  return c.json({ ok: true, form_c_status: "filed", form_c_reference: ref, form_c_filed_at: now });
});

/** The ID desk: who still needs documents, which Form Cs are open, what is waiting to archive, and a guest search over stays with documents. */
r.get("/overview", requireCap("ids_view"), async (c) => {
  const p = c.get("property"); const today = todayIn(p.timezone);
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const base = `SELECT b.id, b.status, b.check_in, b.check_out, b.checked_in_at, b.guest_nationality, b.form_c_status, b.form_c_reference, b.form_c_filed_at, b.ids_archived_at, b.drive_folder_id, b.external_ref, g.name AS guest_name, g.phone AS guest_phone,
      (SELECT GROUP_CONCAT(l.name, ', ') FROM booking_rooms br JOIN locations l ON l.id = br.room_id WHERE br.booking_id = b.id) AS room_names,
      (SELECT COUNT(*) FROM guest_documents d WHERE d.booking_id = b.id AND d.deleted_at IS NULL) AS doc_count
     FROM bookings b JOIN guests g ON g.id = b.guest_id WHERE b.property_id = ?`;
  const [inHouse, formC, archiveWait, found] = await Promise.all([
    all<any>(c.env.DB, `${base} AND b.status IN ('approved','checked_in') AND b.check_in <= ? AND b.check_out >= ? ORDER BY b.check_in`, p.id, today, today),
    all<any>(c.env.DB, `${base} AND b.form_c_status = 'due' ORDER BY b.check_in`, p.id),
    all<any>(c.env.DB, `${base} AND b.status IN ('checked_out','cancelled','no_show') AND b.ids_archived_at IS NULL AND EXISTS (SELECT 1 FROM guest_documents d WHERE d.booking_id = b.id AND d.deleted_at IS NULL AND d.r2_key IS NOT NULL) ORDER BY b.check_out DESC`, p.id),
    q.length >= 2 ? all<any>(c.env.DB, `${base} AND (lower(g.name) LIKE ? OR g.phone LIKE ? OR lower(COALESCE(b.external_ref,'')) LIKE ?) AND EXISTS (SELECT 1 FROM guest_documents d WHERE d.booking_id = b.id AND d.deleted_at IS NULL) ORDER BY b.check_in DESC LIMIT 30`, p.id, `%${q}%`, `%${q}%`, `%${q}%`) : Promise.resolve([]),
  ]);
  const drive = await driveIntegration(c.env.DB, p.id);
  return c.json({ today, in_house: inHouse, form_c_due: formC, archive_waiting: archiveWait, found, archive_after_hours: ARCHIVE_AFTER_HOURS, form_c_hours: FORM_C_HOURS,
    drive: { configured: driveConfigured(c.env), connected: !!drive, account_email: drive?.account_email ?? null, folder_link: drive?.folder_link ?? null, last_used_at: drive?.last_used_at ?? null, last_error: drive?.last_error ?? null } });
});

export default r;
