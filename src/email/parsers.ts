import { rupeesToPaise } from "../domain/money";
import { parseLooseDate } from "../domain/dates";

export const PARSER_VERSION = "2026-10-1";

export interface ParsedEmail {
  source: "staah" | "swiftbook" | "airpay" | "unknown";
  kind: "new_reservation" | "modification" | "cancellation" | "payment" | "unknown";
  external_ref: string | null;
  data: Record<string, unknown>;
  confidence: "high" | "low";
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function textOf(html: string | undefined, text: string | undefined): string {
  if (text && text.trim()) return text;
  if (!html) return "";
  return html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/[ \t]+/g, " ");
}

function grab(body: string, re: RegExp): string | null {
  const m = body.match(re);
  return m ? clean(m[1]) : null;
}

/** STAAH channel-manager notification: "New reservation" / "Modified" / "Cancelled" from an OTA. */
export function parseStaah(subject: string, body: string, year: number): ParsedEmail {
  const kind: ParsedEmail["kind"] = /cancel/i.test(subject) ? "cancellation" : /modif|amend|change/i.test(subject) ? "modification" : /new|reservation|booking/i.test(subject) ? "new_reservation" : "unknown";
  const channel = grab(body, /(?:Channel|Source|OTA)\s*:?\s*([A-Za-z.\- ]+?)(?:\n|Ref|Guest|$)/i) ?? grab(subject, /(Booking\.com|Agoda|Expedia|MakeMyTrip|Goibibo|Airbnb)/i);
  const ref = grab(body, /(?:Ref(?:erence)?|Reservation (?:ID|No\.?)|Booking (?:ID|No\.?))\s*:?\s*#?\s*([0-9]{6,})/i);
  const guest = grab(body, /Guest(?: Name)?\s*:?\s*([^\n·]+?)(?:\s*·|\n|$)/i);
  const room = grab(body, /Room(?: Type)?\s*:?\s*([A-Za-z ]+?)\s*(?:×|x|\n|·)/i);
  const roomsN = Number(grab(body, /(?:×|x)\s*(\d+)/) ?? "1");
  const dates = body.match(/(\d{1,2}(?:\s+[A-Za-z]{3,})?)\s*(?:→|->|to|–|-)\s*(\d{1,2}\s+[A-Za-z]{3,}(?:\s+\d{4})?)/);
  let checkIn: string | null = null, checkOut: string | null = null;
  if (dates) {
    checkOut = parseLooseDate(dates[2], year);
    const inRaw = /[A-Za-z]/.test(dates[1]) ? dates[1] : `${dates[1]} ${dates[2].split(" ").slice(1).join(" ")}`;
    checkIn = parseLooseDate(inRaw, year);
  }
  const ci = grab(body, /Check[- ]?in\s*:?\s*([0-9]{1,2}[\/-][0-9]{1,2}[\/-][0-9]{2,4}|[0-9]{4}-[0-9]{2}-[0-9]{2}|\d{1,2} [A-Za-z]{3,}(?: \d{4})?)/i);
  const co = grab(body, /Check[- ]?out\s*:?\s*([0-9]{1,2}[\/-][0-9]{1,2}[\/-][0-9]{2,4}|[0-9]{4}-[0-9]{2}-[0-9]{2}|\d{1,2} [A-Za-z]{3,}(?: \d{4})?)/i);
  if (ci) checkIn = parseLooseDate(ci, year); if (co) checkOut = parseLooseDate(co, year);
  const roomTotal = grab(body, /Room Total\s*:?\s*₹?\s*([\d,]+\.?\d*)/i) ?? grab(body, /Total(?: Amount)?\s*:?\s*₹?\s*([\d,]+\.?\d*)/i);
  const commission = grab(body, /Commission\s*:?\s*([\d.]+)\s*%/i);
  const collect = /channel collect|prepaid|paid online|virtual card/i.test(body) ? "channel_collect" : /hotel collect|pay at (?:hotel|property)/i.test(body) ? "hotel_collect" : null;
  const exGst = /ex[- ]?GST|excl/i.test(body);
  const data = { channel, guest_name: guest, room_name: room, rooms: roomsN, check_in: checkIn, check_out: checkOut,
    room_total_paise: roomTotal ? rupeesToPaise(roomTotal) : null, room_total_is_ex_gst: exGst, commission_bp: commission ? Math.round(Number(commission) * 100) : null, collection_type: collect };
  const confidence = guest && checkIn && checkOut && (kind === "cancellation" || data.room_total_paise !== null) ? "high" : "low";
  return { source: "staah", kind, external_ref: ref, data, confidence };
}

/** SwiftBook (direct website booking engine) confirmation. */
export function parseSwiftbook(subject: string, body: string, year: number): ParsedEmail {
  const kind: ParsedEmail["kind"] = /cancel/i.test(subject) ? "cancellation" : "new_reservation";
  const guest = grab(body, /Guest(?: Name)?\s*:?\s*([^\n·]+?)(?:\s*·|\n|$)/i);
  const itin = grab(body, /Itinerary(?: (?:No|Number|ID))?\.?\s*:?\s*#?\s*([0-9]{6,})/i) ?? grab(body, /Booking (?:ID|No\.?)\s*:?\s*#?\s*([0-9]{6,})/i);
  const rooms = Number(grab(body, /(\d+)\s*rooms?/i) ?? "1");
  const nights = Number(grab(body, /(\d+)\s*nights?/i) ?? "1");
  const rate = grab(body, /@\s*₹?\s*([\d,]+\.?\d*)\s*\/\s*night/i);
  const total = grab(body, /Total\s*:?\s*₹?\s*([\d,]+\.?\d*)/i);
  const ci = grab(body, /Check[- ]?in\s*:?\s*([0-9]{1,2}[\/-][0-9]{1,2}[\/-][0-9]{2,4}|[0-9]{4}-[0-9]{2}-[0-9]{2}|\d{1,2} [A-Za-z]{3,}(?: \d{4})?)/i);
  const co = grab(body, /Check[- ]?out\s*:?\s*([0-9]{1,2}[\/-][0-9]{1,2}[\/-][0-9]{2,4}|[0-9]{4}-[0-9]{2}-[0-9]{2}|\d{1,2} [A-Za-z]{3,}(?: \d{4})?)/i);
  const payOnline = /pay online|paid online|payment received/i.test(body);
  const data = { guest_name: guest, rooms, nights, nightly_rate_paise: rate ? rupeesToPaise(rate) : null, total_incl_gst_paise: total ? rupeesToPaise(total) : null,
    check_in: ci ? parseLooseDate(ci, year) : null, check_out: co ? parseLooseDate(co, year) : null, pay_online: payOnline, room_name: grab(body, /Room(?: Type)?\s*:?\s*([A-Za-z ]+?)\s*(?:×|x|\n|·)/i) };
  const confidence = guest && itin && data.check_in && data.check_out ? "high" : "low";
  return { source: "swiftbook", kind, external_ref: itin, data, confidence };
}

/** Airpay payment-gateway "transaction successful" email → routes to the Payments screen, never the booking inbox. */
export function parseAirpay(subject: string, body: string): ParsedEmail {
  const order = grab(body, /Order(?: (?:ID|No\.?))?\s*:?\s*#?\s*([0-9]{8,})/i) ?? grab(subject, /([0-9]{10,})/);
  const amount = grab(body, /(?:Amount|₹)\s*:?\s*₹?\s*([\d,]+\.?\d*)/i);
  const payer = grab(body, /Payer(?: Name)?\s*:?\s*([^\n]+)/i) ?? grab(body, /Customer(?: Name)?\s*:?\s*([^\n]+)/i);
  const success = /success/i.test(subject + body);
  const data = { order_id: order, amount_paise: amount ? rupeesToPaise(amount) : null, payer_name: payer, success };
  return { source: "airpay", kind: "payment", external_ref: order, data, confidence: order && data.amount_paise && success ? "high" : "low" };
}

export function parseInboundEmail(from: string, subject: string, html?: string, text?: string, now = new Date()): ParsedEmail {
  const body = textOf(html, text);
  const year = now.getUTCFullYear();
  const f = from.toLowerCase();
  if (f.includes("staah") || /staah/i.test(subject)) return parseStaah(subject, body, year);
  if (f.includes("swiftbook") || /swiftbook/i.test(subject)) return parseSwiftbook(subject, body, year);
  if (f.includes("airpay") || /airpay/i.test(subject)) return parseAirpay(subject, body);
  return { source: "unknown", kind: "unknown", external_ref: null, data: { preview: body.slice(0, 500) }, confidence: "low" };
}
