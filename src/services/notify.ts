import type { Batch } from "../db";
import { newId } from "../domain/ids";

/** Queue an in-app notification for every active user with a role, inside the caller's batch. */
export async function notifyRole(b: Batch, propertyId: string, role: string, kind: string, message: string, ref?: { kind: string; id: string }) {
  const users = await b.db.prepare("SELECT id FROM users WHERE property_id = ? AND role = ? AND active = 1").bind(propertyId, role).all<{ id: string }>();
  for (const u of users.results) {
    b.add("INSERT INTO notifications (id, property_id, user_id, kind, ref_kind, ref_id, message) VALUES (?,?,?,?,?,?,?)",
      newId("ntf"), propertyId, u.id, kind, ref?.kind ?? null, ref?.id ?? null, message);
  }
}

export function notifyUser(b: Batch, propertyId: string, userId: string, kind: string, message: string, ref?: { kind: string; id: string }) {
  b.add("INSERT INTO notifications (id, property_id, user_id, kind, ref_kind, ref_id, message) VALUES (?,?,?,?,?,?,?)",
    newId("ntf"), propertyId, userId, kind, ref?.kind ?? null, ref?.id ?? null, message);
}
