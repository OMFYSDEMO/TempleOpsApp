import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";
import { seed, api, ok, sql, USERS } from "./helpers";
import { archiveStay, staysDueForArchive, type DriveClient } from "../src/services/drive";
import { loadProperty } from "../src/db";

/** Guest IDs: capture at the desk, Form C for foreigners, work-queue items, and the move to Drive 48 h after the stay. */
describe("Guest IDs", () => {
  beforeAll(seed);
  let bookingId: string, foreignId: string, docId: string;
  const png = () => { const b = new Uint8Array(400); b.set([0x89, 0x50, 0x4e, 0x47]); return b; };
  const upload = async (user: keyof typeof USERS, bk: string, qs: string) => {
    const res = await SELF.fetch(`http://avos.test/api/ids/bookings/${bk}/documents?${qs}`, { method: "POST", headers: { "x-dev-user": USERS[user], "content-type": "image/png" }, body: png() });
    return { status: res.status, json: await res.json() as any };
  };

  it("desk photographs an Aadhaar at check-in; sales and owner can see it; the accountant cannot", async () => {
    const today = (await ok("prachi", "GET", "/api/me")).property.today;
    const b = await ok("prachi", "POST", "/api/bookings", { guest_name: "Id Guest", guest_phone: "9300000001", check_in: today, check_out: today.slice(0, 8) + String(Number(today.slice(8)) + 1).padStart(2, "0"), rooms: [{ room_id: "loc_r3", nightly_rate_paise: 550000 }] });
    bookingId = b.booking.id;
    await ok("sindhu", "POST", `/api/bookings/${bookingId}/check-in`);
    // Property desk sees the stay with no ID on its queue.
    const q = await ok("sindhu", "GET", "/api/work");
    expect(q.items.find((i: any) => i.key === `idproof:${bookingId}`)).toBeTruthy();
    expect((await upload("prachi", bookingId, "doc_type=aadhaar")).status).toBe(403);
    expect((await upload("sindhu", bookingId, "doc_type=pan_card")).status).toBe(400);
    const r = await upload("sindhu", bookingId, "doc_type=aadhaar&note=front");
    expect(r.status).toBe(201);
    expect(r.json.documents).toHaveLength(1);
    docId = r.json.documents[0].id;
    expect(r.json.documents[0]).toMatchObject({ doc_type: "aadhaar", person_name: "Id Guest", nationality: "indian", on_file_here: 1 });
    // Queue item clears once a document is on file.
    expect((await ok("sindhu", "GET", "/api/work")).items.find((i: any) => i.key === `idproof:${bookingId}`)).toBeUndefined();
    // Viewing: sales, owner yes; accountant no.
    for (const u of ["prachi", "shaji"] as const) expect((await SELF.fetch(`http://avos.test/api/ids/documents/${docId}/file`, { headers: { "x-dev-user": USERS[u] } })).status).toBe(200);
    expect((await SELF.fetch(`http://avos.test/api/ids/documents/${docId}/file`, { headers: { "x-dev-user": USERS.ca } })).status).toBe(403);
    expect((await api("ca", "GET", `/api/ids/bookings/${bookingId}`)).status).toBe(403);
    // The front desk list shows the count.
    const desk = await ok("sindhu", "GET", "/api/bookings/frontdesk/today");
    expect(desk.in_house.concat(desk.departures).find((x: any) => x.id === bookingId).doc_count).toBe(1);
    // Audited without the image.
    const audit = await sql("SELECT action, after_json FROM audit_log WHERE entity_id = ?", docId);
    expect(audit[0].action).toBe("iddoc.capture");
    expect(audit[0].after_json).toContain("aadhaar");
  });

  it("a wrong capture can be removed by the desk; removing is audited", async () => {
    const r2 = await upload("sindhu", bookingId, "doc_type=driving_licence&person_name=Second%20Guest");
    const second = r2.json.documents.find((d: any) => d.doc_type === "driving_licence");
    expect(second.person_name).toBe("Second Guest");
    expect((await api("prachi", "DELETE", `/api/ids/documents/${second.id}`)).status).toBe(403);
    await ok("sindhu", "DELETE", `/api/ids/documents/${second.id}`);
    expect((await ok("sindhu", "GET", `/api/ids/bookings/${bookingId}`)).documents).toHaveLength(1);
    expect((await SELF.fetch(`http://avos.test/api/ids/documents/${second.id}/file`, { headers: { "x-dev-user": USERS.shaji } })).status).toBe(404);
  });

  it("a foreign national opens Form C for sales within 24 h; a passport+visa+stamp pack, then sales records the acknowledgement", async () => {
    const b = await ok("prachi", "POST", "/api/bookings", { guest_name: "Anna Schmidt", guest_phone: "4915200000000", check_in: "2026-10-20", check_out: "2026-10-23", rooms: [{ room_id: "loc_r4", nightly_rate_paise: 700000 }] });
    foreignId = b.booking.id;
    // Form C cannot be filed on an Indian stay.
    expect((await api("prachi", "POST", `/api/ids/bookings/${foreignId}/form-c`, { reference: "X1" })).status).toBe(409);
    await ok("sindhu", "POST", `/api/bookings/${foreignId}/check-in`);
    await ok("sindhu", "POST", `/api/ids/bookings/${foreignId}/nationality`, { nationality: "foreign" });
    const st = await ok("prachi", "GET", `/api/ids/bookings/${foreignId}`);
    expect(st).toMatchObject({ guest_nationality: "foreign", form_c_status: "due" });
    // Sales queue carries it with a 24 h tolerance; property's does not.
    const sales = await ok("prachi", "GET", "/api/work");
    const item = sales.items.find((i: any) => i.key === `formc:${foreignId}`);
    expect(item).toBeTruthy(); expect(item.tolerance_hours).toBe(24);
    expect((await ok("sindhu", "GET", "/api/work")).items.find((i: any) => i.key === `formc:${foreignId}`)).toBeUndefined();
    expect((await sql("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'form_c_due'"))[0].n).toBeGreaterThan(0);
    for (const t of ["passport", "visa", "arrival_stamp"]) expect((await upload("sindhu", foreignId, `doc_type=${t}&nationality=foreign`)).status).toBe(201);
    const ov = await ok("prachi", "GET", "/api/ids/overview");
    expect(ov.form_c_due.map((x: any) => x.id)).toContain(foreignId);
    expect(ov.form_c_due.find((x: any) => x.id === foreignId).doc_count).toBe(3);
    // Property cannot file Form C; sales can.
    expect((await api("sindhu", "POST", `/api/ids/bookings/${foreignId}/form-c`, { reference: "FRRO-2026-001" })).status).toBe(403);
    const filed = await ok("prachi", "POST", `/api/ids/bookings/${foreignId}/form-c`, { reference: "FRRO-2026-001" });
    expect(filed.form_c_status).toBe("filed");
    expect((await ok("prachi", "GET", "/api/work")).items.find((i: any) => i.key === `formc:${foreignId}`)).toBeUndefined();
    expect((await ok("prachi", "GET", "/api/ids/overview")).form_c_due.find((x: any) => x.id === foreignId)).toBeUndefined();
    // Switching back to Indian keeps a filed Form C on record.
    await ok("sindhu", "POST", `/api/ids/bookings/${foreignId}/nationality`, { nationality: "indian" });
    expect((await ok("prachi", "GET", `/api/ids/bookings/${foreignId}`)).form_c_status).toBe("filed");
    await ok("sindhu", "POST", `/api/ids/bookings/${foreignId}/nationality`, { nationality: "foreign" });
  });

  it("48 h after the stay ends the documents move to Drive, the copies here go, and the record keeps the links", async () => {
    await ok("sindhu", "POST", `/api/bookings/${foreignId}/check-out`);
    const p = await loadProperty(env.DB, "prop_meadows");
    // Not yet: checked out just now.
    expect(await staysDueForArchive(env.DB, p.id, new Date().toISOString())).toHaveLength(0);
    // Owner's queue says documents are waiting once 48 h pass with no Drive connected.
    await sql("UPDATE bookings SET checked_out_at = ? WHERE id = ?", new Date(Date.now() - 49 * 3_600_000).toISOString(), foreignId);
    const owner = await ok("shaji", "GET", "/api/work");
    expect(owner.items.find((i: any) => i.kind === "idarchive")?.title).toMatch(/1 finished stay/);
    expect((await ok("shaji", "GET", "/api/ids/overview")).archive_waiting.map((x: any) => x.id)).toContain(foreignId);
    const due = await staysDueForArchive(env.DB, p.id, new Date().toISOString());
    expect(due.map((s) => s.id)).toEqual([foreignId]);
    // A fake Drive records what it was given.
    const uploads: any[] = []; const folders: any[] = [];
    const fake: DriveClient = {
      async ensureFolder(name, parentId) { folders.push({ name, parentId }); return { id: `fld_${folders.length}`, link: `https://drive.test/folder/${folders.length}` }; },
      async upload(name, contentType, data, parentId) { uploads.push({ name, contentType, bytes: data.byteLength, parentId }); return { id: `file_${uploads.length}`, link: `https://drive.test/file/${uploads.length}` }; },
    };
    const keysBefore = await sql("SELECT r2_key FROM guest_documents WHERE booking_id = ? AND deleted_at IS NULL", foreignId);
    expect(keysBefore.every((k: any) => k.r2_key)).toBe(true);
    const r = await archiveStay(env, p, fake, "root", due[0]);
    expect(r.moved).toBe(3);
    expect(folders[0]).toMatchObject({ name: expect.stringContaining("2026-10-20 Anna Schmidt"), parentId: "root" });
    expect(uploads.map((u) => u.contentType)).toEqual(["image/png", "image/png", "image/png"]);
    expect(uploads[0].name).toMatch(/Anna Schmidt · passport/);
    const after = await sql("SELECT r2_key, drive_file_id, drive_link, archived_at FROM guest_documents WHERE booking_id = ? AND deleted_at IS NULL", foreignId);
    expect(after.every((d: any) => d.r2_key === null && d.drive_file_id && d.archived_at)).toBe(true);
    for (const k of keysBefore) expect(await env.FILES.head(k.r2_key)).toBeNull();
    // The file route now sends the viewer to Drive; nothing more can be captured or removed here.
    const res = await SELF.fetch(`http://avos.test/api/ids/documents/${(await sql("SELECT id FROM guest_documents WHERE booking_id = ? LIMIT 1", foreignId))[0].id}/file`, { headers: { "x-dev-user": USERS.shaji }, redirect: "manual" });
    expect(res.status).toBe(302); expect(res.headers.get("location")).toMatch(/drive\.test/);
    expect((await upload("sindhu", foreignId, "doc_type=passport")).status).toBe(409);
    expect((await ok("shaji", "GET", "/api/work")).items.find((i: any) => i.kind === "idarchive")).toBeUndefined();
    expect((await sql("SELECT ids_archived_at, drive_folder_id FROM bookings WHERE id = ?", foreignId))[0]).toMatchObject({ drive_folder_id: "fld_1" });
    // Second run is a no-op.
    expect(await staysDueForArchive(env.DB, p.id, new Date().toISOString())).toHaveLength(0);
  });

  it("owner's Drive settings report not configured until the OAuth client secrets exist", async () => {
    const s = await ok("shaji", "GET", "/api/admin/integrations/google-drive");
    expect(s).toMatchObject({ configured: false, connected: false });
    expect(s.redirect_uri).toBe("http://avos.test/api/admin/integrations/google-drive/callback");
    expect((await api("shaji", "POST", "/api/admin/integrations/google-drive/connect")).status).toBe(409);
    expect((await api("prachi", "GET", "/api/admin/integrations/google-drive")).status).toBe(403);
  });
});
