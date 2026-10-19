import PostalMime from "postal-mime";
import type { Env } from "../env";
import { ingestEmail } from "../routes/inbox";

/** Email Worker entry: STAAH / SwiftBook / Airpay mail forwarded to the routed address lands in the inbox. */
export async function handleEmail(message: ForwardableEmailMessage, env: Env) {
  const propertyId = env.INBOX_PROPERTY_ID;
  if (!propertyId) { console.error("INBOX_PROPERTY_ID not set; dropping email"); return; }
  const raw = await new Response(message.raw).arrayBuffer();
  const parsed = await PostalMime.parse(raw);
  await ingestEmail(env, propertyId, {
    message_id: parsed.messageId ?? message.headers.get("Message-ID"),
    from: parsed.from?.address ?? message.from,
    subject: parsed.subject ?? "",
    html: parsed.html ?? undefined,
    text: parsed.text ?? undefined,
    raw,
    received_at: parsed.date ?? new Date().toISOString(),
  });
}
