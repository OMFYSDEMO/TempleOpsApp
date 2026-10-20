import type { Env } from "../env";
import { all, one, type PropertyRow } from "../db";
import { nowIso } from "../domain/dates";

/**
 * Google Drive for the ID archive. The owner connects their own Google account once from Settings
 * (OAuth, drive.file scope: the app sees only folders and files it created). The Worker keeps the
 * refresh token and writes under one root folder; each stay gets its own subfolder.
 */
export interface DriveClient {
  ensureFolder(name: string, parentId: string | null): Promise<{ id: string; link: string }>;
  upload(name: string, contentType: string, data: ArrayBuffer, parentId: string): Promise<{ id: string; link: string }>;
}

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const DRIVE_ROOT_FOLDER = "AVOS – Guest IDs";

export function driveConfigured(env: Env): boolean { return !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET; }

/** Must match the redirect URI registered on the Google OAuth client. APP_URL pins it; otherwise the address the owner is using. */
export function driveRedirectUri(env: Env, origin: string): string { return `${(env.APP_URL || origin).replace(/\/$/, "")}/api/admin/integrations/google-drive/callback`; }

export function driveConsentUrl(env: Env, origin: string, state: string): string {
  const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, redirect_uri: driveRedirectUri(env, origin), response_type: "code", scope: `${DRIVE_SCOPE} https://www.googleapis.com/auth/userinfo.email`, access_type: "offline", prompt: "consent", state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export async function exchangeCode(env: Env, origin: string, code: string): Promise<{ refresh_token: string; access_token: string; email: string | null }> {
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, redirect_uri: driveRedirectUri(env, origin), grant_type: "authorization_code" }) });
  const j: any = await res.json();
  if (!res.ok || !j.refresh_token) throw new Error(`Google did not return a refresh token: ${j.error_description ?? j.error ?? res.status}`);
  let email: string | null = null;
  try { const u: any = await (await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { authorization: `Bearer ${j.access_token}` } })).json(); email = u.email ?? null; } catch {}
  return { refresh_token: j.refresh_token, access_token: j.access_token, email };
}

async function accessToken(env: Env, refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ refresh_token: refreshToken, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, grant_type: "refresh_token" }) });
  const j: any = await res.json();
  if (!res.ok) throw new Error(`Google token refresh failed: ${j.error_description ?? j.error ?? res.status}`);
  return j.access_token;
}

export function googleDrive(token: string): DriveClient {
  const h = { authorization: `Bearer ${token}` };
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return {
    async ensureFolder(name, parentId) {
      const q = `name = '${esc(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false${parentId ? ` and '${parentId}' in parents` : ""}`;
      const found: any = await (await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,webViewLink)&pageSize=1`, { headers: h })).json();
      if (found.files?.length) return { id: found.files[0].id, link: found.files[0].webViewLink };
      const res = await fetch("https://www.googleapis.com/drive/v3/files?fields=id,webViewLink", { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: parentId ? [parentId] : undefined }) });
      const j: any = await res.json();
      if (!res.ok) throw new Error(`Drive folder create failed: ${j.error?.message ?? res.status}`);
      return { id: j.id, link: j.webViewLink };
    },
    async upload(name, contentType, data, parentId) {
      const boundary = `avos${crypto.randomUUID()}`;
      const meta = JSON.stringify({ name, parents: [parentId] });
      const head = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: ${contentType}\r\n\r\n`;
      const tail = `\r\n--${boundary}--`;
      const body = new Blob([head, data, tail]);
      const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", { method: "POST", headers: { ...h, "content-type": `multipart/related; boundary=${boundary}` }, body });
      const j: any = await res.json();
      if (!res.ok) throw new Error(`Drive upload failed: ${j.error?.message ?? res.status}`);
      return { id: j.id, link: j.webViewLink };
    },
  };
}

export interface IntegrationRow { property_id: string; kind: string; account_email: string | null; refresh_token: string; folder_id: string | null; folder_link: string | null; connected_by: string; connected_at: string; last_used_at: string | null; last_error: string | null }

export async function driveIntegration(db: D1Database, propertyId: string): Promise<IntegrationRow | null> {
  return one<IntegrationRow>(db, "SELECT * FROM integrations WHERE property_id = ? AND kind = 'google_drive'", propertyId);
}

/** A connected Drive client for the property, or null when the owner has not connected one. */
export async function driveFor(env: Env, propertyId: string): Promise<{ client: DriveClient; row: IntegrationRow } | null> {
  if (!driveConfigured(env)) return null;
  const row = await driveIntegration(env.DB, propertyId);
  if (!row) return null;
  return { client: googleDrive(await accessToken(env, row.refresh_token)), row };
}

export const ARCHIVE_AFTER_HOURS = 48;

/** Stays whose documents are due to move to Drive: ended (checked out, cancelled, no-show) 48 hours ago or more, still holding files in R2. */
export async function staysDueForArchive(db: D1Database, propertyId: string, now: string) {
  const cutoff = new Date(Date.parse(now) - ARCHIVE_AFTER_HOURS * 3_600_000).toISOString();
  return all<any>(db, `SELECT b.id, b.check_in, b.check_out, b.external_ref, b.drive_folder_id, g.name AS guest_name, COALESCE(b.checked_out_at, b.updated_at) AS ended_at
     FROM bookings b JOIN guests g ON g.id = b.guest_id
     WHERE b.property_id = ? AND b.status IN ('checked_out','cancelled','no_show') AND b.ids_archived_at IS NULL
       AND replace(COALESCE(b.checked_out_at, b.updated_at), ' ', 'T') <= ?
       AND EXISTS (SELECT 1 FROM guest_documents d WHERE d.booking_id = b.id AND d.deleted_at IS NULL AND d.r2_key IS NOT NULL)
     ORDER BY ended_at LIMIT 10`, propertyId, cutoff);
}

/**
 * Move every document of a finished stay to Drive: one subfolder per stay under the root, named by
 * check-in date and guest; then drop the R2 copy. Idempotent: a file already on Drive is skipped.
 */
export async function archiveStay(env: Env, p: PropertyRow, drive: DriveClient, rootFolderId: string, stay: any, now = nowIso()) {
  const folderName = `${stay.check_in} ${stay.guest_name}${stay.external_ref ? ` · ${stay.external_ref}` : ""} · ${stay.id}`;
  const folder = stay.drive_folder_id ? { id: stay.drive_folder_id, link: null } : await drive.ensureFolder(folderName, rootFolderId);
  const docs = await all<any>(env.DB, "SELECT * FROM guest_documents WHERE booking_id = ? AND deleted_at IS NULL AND r2_key IS NOT NULL ORDER BY captured_at", stay.id);
  let moved = 0;
  for (const d of docs) {
    const obj = await env.FILES.get(d.r2_key);
    if (!obj) { await env.DB.prepare("UPDATE guest_documents SET r2_key = NULL, archived_at = ?, note = COALESCE(note || ' · ', '') || 'file missing at archive' WHERE id = ?").bind(now, d.id).run(); continue; }
    const ext = d.content_type.includes("pdf") ? "pdf" : d.content_type.split("/")[1]?.replace("jpeg", "jpg") ?? "bin";
    const name = `${d.person_name} · ${d.doc_type}${d.note ? ` · ${d.note}` : ""} · ${d.id}.${ext}`;
    const up = await drive.upload(name, d.content_type, await obj.arrayBuffer(), folder.id);
    await env.DB.prepare("UPDATE guest_documents SET drive_file_id = ?, drive_link = ?, archived_at = ?, r2_key = NULL WHERE id = ?").bind(up.id, up.link, now, d.id).run();
    await env.FILES.delete(d.r2_key);
    moved++;
  }
  await env.DB.prepare("UPDATE bookings SET ids_archived_at = ?, drive_folder_id = ? WHERE id = ?").bind(now, folder.id, stay.id).run();
  await env.DB.prepare("INSERT INTO audit_log (property_id, actor_id, actor_email, action, entity, entity_id, before_json, after_json) VALUES (?,?,?,?,?,?,?,?)")
    .bind(p.id, null, "id-archive", "iddoc.archive", "booking", stay.id, null, JSON.stringify({ moved, drive_folder_id: folder.id })).run();
  return { moved, folderId: folder.id };
}

/** Cron step: archive what is due, with whatever Drive is connected. Silent when nothing is connected; the work queue says so. */
export async function runIdArchive(env: Env, p: PropertyRow, now = nowIso()) {
  const due = await staysDueForArchive(env.DB, p.id, now);
  if (!due.length) return { archived: 0 };
  const d = await driveFor(env, p.id);
  if (!d) return { archived: 0, reason: "drive not connected" };
  let archived = 0;
  try {
    const root = d.row.folder_id ? { id: d.row.folder_id } : await d.client.ensureFolder(DRIVE_ROOT_FOLDER, null);
    if (!d.row.folder_id) await env.DB.prepare("UPDATE integrations SET folder_id = ?, folder_link = ? WHERE property_id = ? AND kind = 'google_drive'").bind(root.id, (root as any).link ?? null, p.id).run();
    for (const stay of due) { await archiveStay(env, p, d.client, root.id, stay, now); archived++; }
    await env.DB.prepare("UPDATE integrations SET last_used_at = ?, last_error = NULL WHERE property_id = ? AND kind = 'google_drive'").bind(now, p.id).run();
  } catch (e) {
    await env.DB.prepare("UPDATE integrations SET last_error = ? WHERE property_id = ? AND kind = 'google_drive'").bind(String((e as Error).message).slice(0, 300), p.id).run();
    throw e;
  }
  return { archived };
}
