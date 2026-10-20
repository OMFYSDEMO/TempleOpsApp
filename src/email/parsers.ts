import { rupeesToPaise } from "../domain/money";
import { parseLooseDate } from "../domain/dates";

export const PARSER_VERSION = "2026-10-2";

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

/** "Fwd: Fwd: subject" → "subject". */
export function stripForwardPrefixes(subject: string): string {
  let s = subject.trim();
  for (;;) { const t = s.replace(/^\s*(?:fwd?|fw|re)\s*:\s*/i, ""); if (t === s) return s; s = t; }
}

/** A Gmail/Outlook forward carries the sender's signature first; the notification sits after the "Forwarded message" marker. */
export function forwardedPart(body: string): string {
  const parts = body.split(/[-=_]{3,}\s*Forwarded message\s*[-=_]{3,}/i);
  return parts.length > 1 ? parts[parts.length - 1] : body;
}

/** Amount after a label, e.g. "Room Total : INR 11,704.50" or "Total: ₹6,000". */
function money(body: string, label: string): string | null {
  return grab(body, new RegExp(label + "\\s*:?\\s*(?:₹|INR|Rs\\.?)?\\s*([\\d,]+(?:\\.\\d+)?)", "i"));
}

const DATE = "[0-9]{1,2}[\\/-][0-9]{1,2}[\\/-][0-9]{2,4}|[0-9]{4}-[0-9]{2}-[0-9]{2}|\\d{1,2} [A-Za-z]{3,}(?: \\d{4})?";

/**
 * STAAH channel-manager notification ("New Reservation Goibibo for kumar Reservation No:0190589681 (1060900000001400)").
 * The body is a label-above-value table: CHANNEL NAME, BOOKING ID# <ota ref> (<staah ref>), ROOM TYPE, NO OF ROOMS,
 * CHECK-IN, CHECK-OUT, GUEST NAME, ADULTS, CHILDREN, then Payment Type / Commission / Room Total / Total Taxes / Total.
 * Older "Label: value" layouts are still read.
 */
export function parseStaah(rawSubject: string, body: string, year: number): ParsedEmail {
  const subject = stripForwardPrefixes(rawSubject);
  const cancelled = /cancel/i.test(subject) || /Bookings?\s*Status\s*:?\s*Cancel/i.test(body);
  const kind: ParsedEmail["kind"] = cancelled ? "cancellation" : /modif|amend|change/i.test(subject) ? "modification" : /new|reservation|booking/i.test(subject) ? "new_reservation" : "unknown";
  const channel = grab(body, /Channel Name\s*:?\s*([A-Za-z.\- ]+?)\s*(?:\n|Bookings?\s*Status|$)/i)
    ?? grab(subject, /(?:New|Modified|Amended|Cancelled|Cancel)\s+(?:Reservation|Booking)\s+([A-Za-z.\-]+)\s+for/i)
    ?? grab(body, /(?:Channel|Source|OTA)\s*:?\s*([A-Za-z.\- ]+?)(?:\n|Ref|Guest|$)/i)
    ?? grab(subject, /(Booking\.com|Agoda|Expedia|MakeMyTrip|Goibibo|Airbnb|Cleartrip|Yatra)/i);
  // Booking Id#: <OTA reference> (<STAAH reservation id>). The STAAH id is the one that stays stable across OTAs.
  const ids = body.match(/Booking\s*Id#?\s*:?\s*([A-Za-z0-9\-]+)\s*\((\d{6,})\)/i) ?? subject.match(/Reservation\s*No\.?\s*:?\s*([A-Za-z0-9\-]+)\s*\((\d{6,})\)/i);
  const ref = ids ? ids[2] : grab(body, /(?:Ref(?:erence)?|Reservation (?:ID|No\.?)|Booking (?:ID|No\.?))\s*:?\s*#?\s*([0-9]{6,})/i);
  const otaRef = ids ? ids[1] : null;
  const guest = grab(body, /GUEST NAME\s*\n?\s*([^\n]+)/i) ?? grab(body, /CONTACT NAME\s*\n?\s*([^\n]+)/i) ?? grab(body, /Guest(?: Name)?\s*:?\s*([^\n·]+?)(?:\s*·|\n|$)/i) ?? grab(subject, /for\s+(.+?)\s+Reservation\s*No/i);
  const roomFull = grab(body, /ROOM TYPE\s*\n?\s*([^\n]+)/i) ?? grab(body, /Room(?: Type)?\s*:?\s*([A-Za-z][A-Za-z ]*?)\s*(?:×|x|\n|·)/i);
  const room = roomFull ? roomFull.split(/\s+-\s+|\s*\(/)[0].trim() : null;
  const roomsN = Number(grab(body, /NO\.? OF ROOMS\s*\n?\s*(\d+)/i) ?? grab(body, /(?:×|x)\s*(\d+)/) ?? "1");
  const nightsN = Number(grab(body, /NO\.? OF NIGHTS\s*\n?\s*(\d+)/i) ?? "0") || null;
  const ci = grab(body, new RegExp("Check[- ]?in\\s*:?\\s*(" + DATE + ")", "i"));
  const co = grab(body, new RegExp("Check[- ]?out\\s*:?\\s*(" + DATE + ")", "i"));
  let checkIn = ci ? parseLooseDate(ci, year) : null, checkOut = co ? parseLooseDate(co, year) : null;
  if (!checkIn || !checkOut) {
    const dates = body.match(/(\d{1,2}(?:\s+[A-Za-z]{3,})?)\s*(?:→|->|to|–|-)\s*(\d{1,2}\s+[A-Za-z]{3,}(?:\s+\d{4})?)/);
    if (dates) { checkOut = parseLooseDate(dates[2], year); checkIn = parseLooseDate(/[A-Za-z]/.test(dates[1]) ? dates[1] : `${dates[1]} ${dates[2].split(" ").slice(1).join(" ")}`, year); }
  }
  const roomTotal = money(body, "Room Total") ?? money(body, "Total(?: Amount)?");
  const taxes = money(body, "Total Taxes");
  const totalIncl = money(body, "Total \\(All Inclusive\\)");
  const commissionPct = grab(body, /Commission\s*:?\s*([\d.]+)\s*%/i);
  const commissionAmt = commissionPct ? null : money(body, "Commission");
  const collect = /channel collect|prepaid|paid online|virtual card/i.test(body) ? "channel_collect" : /hotel collect|pay at (?:hotel|property)/i.test(body) ? "hotel_collect" : null;
  const data = {
    channel, ota_ref: otaRef, vendor: grab(body, /VendorName\s*::?\s*([A-Za-z.\- ]+?)\s*(?:,|\n|$)/i), guest_name: guest, room_name: room, room_name_full: roomFull, rooms: roomsN, nights: nightsN,
    adults: Number(grab(body, /ADULTS\s*\n?\s*(\d+)/i) ?? "0") || null, children: Number(grab(body, /CHILDREN\s*\n?\s*(\d+)/i) ?? "0") || null,
    check_in: checkIn, check_out: checkOut,
    room_total_paise: roomTotal ? rupeesToPaise(roomTotal) : null, room_total_is_ex_gst: taxes !== null || /ex[- ]?GST|excl/i.test(body),
    taxes_paise: taxes ? rupeesToPaise(taxes) : null, total_incl_gst_paise: totalIncl ? rupeesToPaise(totalIncl) : null,
    commission_bp: commissionPct ? Math.round(Number(commissionPct) * 100) : null, commission_paise: commissionAmt ? rupeesToPaise(commissionAmt) : null,
    collection_type: collect, status_text: grab(body, /Bookings?\s*Status\s*:?\s*([A-Za-z ]+?)\s*(?:\n|$)/i),
  };
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
    check_in: ci ? parseLooseDate(ci, year) : null, check_out: co ? parseLooseDate(co, year) : null, pay_online: payOnline, room_name: grab(body, /Room(?: Type)?\s*:?\s*([A-Za-z][A-Za-z ]*?)\s*(?:×|x|\n|·)/i) };
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

export function parseInboundEmail(from: string, rawSubject: string, html?: string, text?: string, now = new Date()): ParsedEmail {
  const whole = textOf(html, text);
  const body = forwardedPart(whole);          // a forwarded notification is read past the forwarder's signature
  const subject = stripForwardPrefixes(rawSubject);
  const year = now.getUTCFullYear();
  const f = from.toLowerCase();
  const fwdFrom = (body.match(/From\s*:\s*.*?([\w.+-]+@[\w-]+\.[\w.-]+)/i)?.[1] ?? "").toLowerCase();
  const looksStaah = f.includes("staah") || fwdFrom.includes("staah") || /staah/i.test(subject) || (/Channel Name\s*:/i.test(body) && /Booking\s*Id#?/i.test(body));
  const looksSwiftbook = f.includes("swiftbook") || fwdFrom.includes("swiftbook") || /swiftbook/i.test(subject) || /Itinerary(?: (?:No|Number|ID))?\.?\s*:?\s*#?\s*\d{6,}/i.test(body);
  const looksAirpay = f.includes("airpay") || fwdFrom.includes("airpay") || /airpay/i.test(subject);
  if (looksStaah) return parseStaah(subject, body, year);
  if (looksSwiftbook) return parseSwiftbook(subject, body, year);
  if (looksAirpay) return parseAirpay(subject, body);
  return { source: "unknown", kind: "unknown", external_ref: null, data: { preview: body.slice(0, 500) }, confidence: "low" };
}
