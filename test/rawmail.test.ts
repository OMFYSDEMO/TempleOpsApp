import { describe, it, expect } from "vitest";
import { readRawEmail } from "../src/email/raw";
import { parseInboundEmail } from "../src/email/parsers";

/** A notification forwarded "as attachment": the real message rides inside a message/rfc822 part. */
describe("raw email with an attached message", () => {
  const inner = ["From: IDFC FIRST Bank <transaction.alerts@idfcfirstbank.com>", "To: bookings@meadowsvarkala.com", "Subject: Transaction alert from IDFC FIRST Bank", "Content-Type: text/plain; charset=utf-8", "",
    "Dear Midhurst Hospitality Pvt Ltd,", "Your A/C XXXXXXX3390 has been credited with INR 32,729.33 on 21-10-2026 17:02:09 vide NEFT payment reference CMS2942643026507 received from AIRPAY PAYMENT SERVICES PRIVATE .", "New balance is INR 503,881.33.", ""].join("\r\n");
  const outer = ["From: Meadows Varkala <bookings@meadowsvarkala.com>", "To: inbox@shajianandan.com", "Subject: Airpay Clearance to IDFC", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b1"', "",
    "--b1", "Content-Type: text/plain; charset=utf-8", "", "Kind Regards,", "Shaji Anandan", "", "--b1", "Content-Type: message/rfc822", "Content-Disposition: attachment; filename=\"alert.eml\"", "", inner, "--b1--", ""].join("\r\n");
  it("opens the attached message so the bank alert is read, not the forwarder's signature", async () => {
    const m = await readRawEmail(new TextEncoder().encode(outer).buffer as ArrayBuffer);
    expect(m.from).toBe("bookings@meadowsvarkala.com"); expect(m.subject).toBe("Airpay Clearance to IDFC");
    expect(m.text).toContain("Forwarded message"); expect(m.text).toContain("transaction.alerts@idfcfirstbank.com"); expect(m.text).toContain("has been credited with INR 32,729.33");
    const p = parseInboundEmail(m.from, m.subject, m.html, m.text);
    expect(p.kind).toBe("bank_alert"); expect(p.confidence).toBe("high");
    expect(p.data).toMatchObject({ amount_paise: 3272933, counterparty: "AIRPAY PAYMENT SERVICES PRIVATE", reference: "CMS2942643026507", balance_paise: 50388133 });
  });
});
