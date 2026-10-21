import PostalMime from "postal-mime";

export interface MailBodies { from: string; subject: string; html?: string; text?: string; messageId: string | null; date: string | null }

/**
 * Read a raw email into from / subject / html / text. A notification forwarded "as attachment" carries the
 * real message as a message/rfc822 part with only the forwarder's signature in the outer body, so attached
 * messages are opened (one level deep, then their own attachments) and their text appended after a
 * "Forwarded message" marker with the inner From line, which is what the detector keys on.
 */
export async function readRawEmail(raw: ArrayBuffer): Promise<MailBodies> {
  const m = await PostalMime.parse(raw);
  let html = m.html ?? undefined, text = m.text ?? undefined;
  const nested: string[] = [];
  const walk = async (atts: any[], depth: number) => {
    for (const a of atts ?? []) {
      const ct = String(a.mimeType ?? "").toLowerCase();
      if (ct !== "message/rfc822" || depth > 2 || !a.content) continue;
      try {
        const inner = await PostalMime.parse(a.content as ArrayBuffer);
        const body = inner.text?.trim() || (inner.html ?? "");
        nested.push(`---------- Forwarded message ----------\nFrom: ${inner.from?.name ?? ""} <${inner.from?.address ?? ""}>\nSubject: ${inner.subject ?? ""}\n\n${body}`);
        await walk(inner.attachments as any[], depth + 1);
      } catch { /* an attachment that is not really a message: ignore */ }
    }
  };
  await walk(m.attachments as any[], 0);
  if (nested.length) {
    // Text wins over HTML downstream, so put the attached messages where they will be read.
    text = `${text ?? ""}\n\n${nested.join("\n\n")}`;
    if (html && !m.text) html = undefined;
  }
  return { from: m.from?.address ?? "", subject: m.subject ?? "", html, text, messageId: m.messageId ?? null, date: m.date ?? null };
}
