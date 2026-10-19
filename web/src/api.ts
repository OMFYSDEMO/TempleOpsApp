/** Thin API client. Errors carry the server's message so screens can show it verbatim. */
export class ApiError extends Error { constructor(public status: number, message: string, public detail?: unknown) { super(message); } }

export function devUser(): string | null { try { return localStorage.getItem("avos.devUser"); } catch { return null; } }
export function setDevUser(email: string | null) { try { email ? localStorage.setItem("avos.devUser", email) : localStorage.removeItem("avos.devUser"); } catch {} }

export async function api<T = any>(method: string, path: string, body?: unknown, opts: { raw?: BodyInit; contentType?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const dev = devUser(); if (dev) headers["x-dev-user"] = dev;
  let payload: BodyInit | undefined;
  if (opts.raw !== undefined) { payload = opts.raw; if (opts.contentType) headers["content-type"] = opts.contentType; }
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`/api${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new ApiError(res.status, json?.error ?? `HTTP ${res.status}`, json?.detail);
  return json as T;
}
export const get = <T = any>(path: string) => api<T>("GET", path);
export const post = <T = any>(path: string, body?: unknown) => api<T>("POST", path, body ?? {});
export const patch = <T = any>(path: string, body?: unknown) => api<T>("PATCH", path, body ?? {});
export const del = <T = any>(path: string) => api<T>("DELETE", path);

export async function uploadFile(file: File, purpose = "bill"): Promise<string> {
  const r = await api<{ key: string }>("POST", `/files?purpose=${purpose}`, undefined, { raw: file, contentType: file.type || "image/jpeg" });
  return r.key;
}
