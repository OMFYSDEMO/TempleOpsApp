import { readRawEmail } from "./raw";
import type { Env } from "../env";
import { ingestEmail } from "../routes/inbox";

/** Email Worker entry: STAAH / SwiftBook / Airpay mail forwarded to the routed address lands in the inbox. */
export async function handleEmail(message: ForwardableEmailMessage, env: Env) {
  const propertyId = env.INBOX_PROPERTY_ID;
  if (!propertyId) { console.error("INBOX_PROPERTY_ID not set; dropping email"); return; }
  const raw = await new Response(message.raw).arrayBuffer();
  const parsed = await readRawEmail(raw);
  await ingestEmail(env, propertyId, {
    message_id: parsed.messageId ?? message.headers.get("Message-ID"),
    from: parsed.from || message.from,
    subject: parsed.subject,
    html: parsed.html,
    text: parsed.text,
    raw,
    received_at: parsed.date ?? new Date().toISOString(),
  });
}
