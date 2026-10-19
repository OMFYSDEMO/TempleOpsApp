/**
 * Offline-first quick capture (W5a rule 6): every capture is queued locally with a client-made
 * idempotency key and replayed when the network returns. The server upserts on that key, so a
 * retry can never duplicate an entry.
 */
import { api } from "./api";

export interface QueuedEntry { key: string; method: string; path: string; body: Record<string, unknown>; label: string; created_at: string; attempts: number; last_error?: string; }
const STORE = "avos.queue";
const listeners = new Set<() => void>();

export function readQueue(): QueuedEntry[] { try { return JSON.parse(localStorage.getItem(STORE) ?? "[]"); } catch { return []; } }
function writeQueue(q: QueuedEntry[]) { try { localStorage.setItem(STORE, JSON.stringify(q)); } catch {} listeners.forEach((l) => l()); }
export function onQueueChange(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }

export function newKey(): string { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }

/** Try online first; on network failure queue it. Returns {queued:true} when stored for later. */
export async function submit(method: string, path: string, body: Record<string, unknown>, label: string): Promise<{ queued: boolean; result?: any }> {
  const key = (body.idempotency_key as string) ?? newKey();
  const payload = { ...body, idempotency_key: key };
  try {
    const result = await api(method, path, payload);
    return { queued: false, result };
  } catch (e: any) {
    if (e?.status) throw e; // server rejected it: a real error, not a network problem
    const q = readQueue();
    q.push({ key, method, path, body: payload, label, created_at: new Date().toISOString(), attempts: 0 });
    writeQueue(q);
    return { queued: true };
  }
}

let flushing = false;
export async function flush(): Promise<number> {
  if (flushing) return 0; flushing = true;
  let sent = 0;
  try {
    for (const entry of readQueue()) {
      try { await api(entry.method, entry.path, entry.body); const q = readQueue().filter((x) => x.key !== entry.key); writeQueue(q); sent++; }
      catch (e: any) {
        const q = readQueue(); const it = q.find((x) => x.key === entry.key);
        if (it) { it.attempts++; it.last_error = e?.message ?? String(e); }
        if (e?.status && e.status !== 401 && e.status !== 403 && e.status < 500) { /* server rejected permanently: keep it visible for the user to fix */ }
        writeQueue(q);
        if (!e?.status) break; // still offline
      }
    }
  } finally { flushing = false; }
  return sent;
}
export function dropQueued(key: string) { writeQueue(readQueue().filter((x) => x.key !== key)); }

if (typeof window !== "undefined") { window.addEventListener("online", () => { flush(); }); setInterval(() => { if (navigator.onLine && readQueue().length) flush(); }, 30_000); }
