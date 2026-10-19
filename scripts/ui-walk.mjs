// UI smoke walk: drives the Lead → CA flow through the real app for every role, screenshots each screen,
// and fails on console errors, page errors or 5xx. Needs a running `npm run dev` on :8787 and a seeded local D1.
//   npx -y playwright-core@1.56.0 node scripts/ui-walk.mjs      (set CHROME=/path/to/chrome if not auto-detected)
import { chromium } from "playwright-core";
const BASE = "http://localhost:8787";
const SHOTS = process.env.SHOTS ?? "./ui-shots";
import { mkdirSync } from "node:fs"; mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? undefined, args: ["--no-sandbox"] });
const errors = [];
async function openAs(user, hash, { mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  await ctx.addInitScript((u) => localStorage.setItem("ivos.devUser", u), `${user}@meadowsvarkala.example`);
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(`[${user}#${hash}] console: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`[${user}#${hash}] pageerror: ${e.message}`));
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 500) errors.push(`[${user}#${hash}] ${r.status()} ${r.url()}`); });
  await page.goto(`${BASE}/#${hash}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  return { ctx, page };
}
async function shot(page, name) { await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); }
const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const tomorrow = new Date(Date.parse(today) + 86400e3).toISOString().slice(0, 10);

// --- Prachi: lead → quote → hold → won (through the UI) ---
{
  const { ctx, page } = await openAs("prachi", "leads");
  await page.getByRole("button", { name: "+ Lead" }).click();
  await page.getByText("WhatsApp", { exact: true }).click();
  await page.getByLabel("Name").fill("Rashmi Shah");
  await page.getByLabel("Phone").fill("9876501234");
  await page.getByLabel("Check-in").fill(today);
  await page.getByLabel("Check-out").fill(tomorrow);
  await page.getByRole("button", { name: "Save lead" }).click();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Mark contacted" }).first().click();
  await page.waitForTimeout(400);
  const card = page.locator(".card", { hasText: "Rashmi Shah" }).first();
  await card.getByRole("button", { name: "Deluxe" }).click();
  await card.getByRole("button", { name: "Superior" }).click();
  const popup = ctx.waitForEvent("page").catch(() => null);
  await card.getByRole("button", { name: /Quote/ }).click();
  await page.waitForTimeout(800);
  const p2 = await popup; if (p2) await p2.close();
  await shot(page, "01-prachi-leads-quoted");
  await card.getByRole("button", { name: "Hold 48 h" }).click();
  await page.waitForTimeout(500);
  await card.getByRole("button", { name: "Won → booking" }).click();
  await page.waitForTimeout(800);
  await page.goto(`${BASE}/#avail`, { waitUntil: "networkidle" }); await page.waitForTimeout(400);
  await shot(page, "02-prachi-availability");
  await page.goto(`${BASE}/#resv`, { waitUntil: "networkidle" }); await page.waitForTimeout(400);
  await shot(page, "03-prachi-reservations");
  await page.goto(`${BASE}/#inbox`, { waitUntil: "networkidle" }); await page.waitForTimeout(300);
  await page.getByLabel("From").fill("noreply@staah.com");
  await page.getByLabel("Subject").fill("STAAH · New reservation · Booking.com");
  await page.getByLabel("Body (text)").fill(`Channel: Booking.com\nRef: 1060900000001336\nGuest: Astha Sharma\nRoom: Premium ×1\nCheck-in: ${today.split("-").reverse().join("/")}\nCheck-out: ${tomorrow.split("-").reverse().join("/")}\nRoom Total: ₹6,500.00 (ex-GST)\nCommission: 23%\nChannel Collect`);
  await page.getByRole("button", { name: "Ingest" }).click(); await page.waitForTimeout(700);
  const item = page.locator(".card", { hasText: "Astha Sharma" }).first();
  await item.getByRole("button", { name: "Premium" }).click();
  await item.getByRole("button", { name: "Approve" }).click(); await page.waitForTimeout(700);
  await shot(page, "04-prachi-inbox");
  await ctx.close();
}
// --- Sindhu (mobile): front desk check-in, quick capture, check-out → collect → invoice ---
{
  const { ctx, page } = await openAs("sindhu", "desk", { mobile: true });
  await shot(page, "05-sindhu-frontdesk-mobile");
  const arrivals = page.locator(".card", { hasText: "Arrivals" });
  const n = await arrivals.getByRole("button", { name: "Check in" }).count();
  for (let i = 0; i < n; i++) { await arrivals.getByRole("button", { name: "Check in" }).first().click(); await page.waitForTimeout(500); }
  // Quick capture: expense via the + button
  await page.locator(".fab").click(); await page.waitForTimeout(200);
  await shot(page, "06-sindhu-quick-capture");
  await page.getByRole("button", { name: /Expense/ }).click();
  for (const k of ["4", "6", "0"]) await page.locator(".keypad button", { hasText: new RegExp(`^${k}$`) }).click();
  await page.getByRole("button", { name: "Housekeeping" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click(); await page.waitForTimeout(600);
  // Task via +
  await page.locator(".fab").click(); await page.getByRole("button", { name: /Task/ }).click();
  await page.getByRole("button", { name: /Garden/ }).click();
  await page.getByRole("button", { name: "Note", exact: true }).click();
  await page.getByLabel("One line (optional)").fill("sprinkler head broken near the gate");
  await page.getByRole("button", { name: "Save note" }).click(); await page.waitForTimeout(600);
  // Check-out the direct guest from the desk → collect → invoice
  await page.goto(`${BASE}/#desk`, { waitUntil: "networkidle" }); await page.waitForTimeout(400);
  const inhouse = page.locator(".card", { hasText: "In house" });
  const rows = inhouse.locator(".row", { hasText: "Rashmi" });
  if (await rows.count()) { await rows.first().getByRole("button", { name: "Check out" }).click(); await page.waitForTimeout(700); }
  await shot(page, "07-sindhu-checkout");
  const collect = page.locator("a.btn.gold", { hasText: "Collect" });
  if (await collect.count()) { await collect.click(); await page.waitForTimeout(800); await shot(page, "08-sindhu-payments-prefilled"); await page.getByRole("button", { name: "UPI", exact: true }).click(); await page.getByRole("button", { name: /^Collected/ }).click(); await page.waitForTimeout(700); }
  await page.goto(`${BASE}/#invoice`, { waitUntil: "networkidle" }); await page.waitForTimeout(400);
  const issue = page.getByRole("button", { name: "Issue invoice" });
  const pop = ctx.waitForEvent("page").catch(() => null);
  if (await issue.count()) { await issue.first().click(); await page.waitForTimeout(900); }
  const inv = await pop; if (inv) { await inv.waitForLoadState(); await inv.screenshot({ path: `${SHOTS}/09-invoice-html.png`, fullPage: true }); await inv.close(); }
  await shot(page, "10-sindhu-invoices");
  await page.goto(`${BASE}/#tasks`, { waitUntil: "networkidle" }); await page.waitForTimeout(400); await shot(page, "11-sindhu-tasks");
  await page.goto(`${BASE}/#pexp`, { waitUntil: "networkidle" }); await page.waitForTimeout(400); await shot(page, "12-sindhu-petty");
  await ctx.close();
}
// --- Trupti: approvals, payouts, reconcile, revenue ---
{
  const { ctx, page } = await openAs("trupti", "appr"); await shot(page, "13-trupti-approvals");
  await page.goto(`${BASE}/#payouts`, { waitUntil: "networkidle" }); await page.waitForTimeout(500);
  // check out the OTA guest first as sindhu is not possible here; settle whatever is unsettled if any
  await shot(page, "14-trupti-payouts");
  await page.goto(`${BASE}/#recon`, { waitUntil: "networkidle" }); await page.waitForTimeout(400);
  await page.locator("textarea").fill(`${today.split("-").reverse().join("/")}\tUPI CR 9876501234 RASHMI\t\t${(await (await fetch(`${BASE}/api/payments`, { headers: { "x-dev-user": "trupti@meadowsvarkala.example" } })).json()).payments[0]?.amount_paise / 100 || 100}\n${today.split("-").reverse().join("/")}\tUNKNOWN CREDIT\t\t999.00`);
  await page.getByRole("button", { name: "Match" }).click(); await page.waitForTimeout(800);
  await shot(page, "15-trupti-reconcile");
  await page.goto(`${BASE}/#revdash`, { waitUntil: "networkidle" }); await page.waitForTimeout(500); await shot(page, "16-trupti-revenue");
  await ctx.close();
}
// --- Shaji: dashboard, bank expenses, admin; CA: close, gst ---
{
  const { ctx, page } = await openAs("shaji", "dash"); await shot(page, "17-shaji-dashboard");
  await page.goto(`${BASE}/#bankexp`, { waitUntil: "networkidle" }); await page.waitForTimeout(400); await shot(page, "18-shaji-bank-expenses");
  await page.goto(`${BASE}/#admin`, { waitUntil: "networkidle" }); await page.waitForTimeout(400); await shot(page, "19-shaji-admin");
  await ctx.close();
}
{
  const { ctx, page } = await openAs("ca", "close"); await shot(page, "20-ca-month-close");
  await page.goto(`${BASE}/#gst`, { waitUntil: "networkidle" }); await page.waitForTimeout(400); await shot(page, "21-ca-gst");
  await ctx.close();
}
// Role wall from the UI: Prachi has no Dashboard; the API says 403.
{
  const { ctx, page } = await openAs("prachi", "dash");
  const r = await page.evaluate(async () => (await fetch("/api/reports/pnl", { headers: { "x-dev-user": "prachi@meadowsvarkala.example" } })).status);
  if (r !== 403) errors.push(`role wall: prachi got ${r} from /api/reports/pnl`);
  const nav = await page.locator("nav.side a").allTextContents();
  if (nav.some((t) => /Dashboard|Month close|GST/.test(t))) errors.push(`prachi nav leaks: ${nav.join(",")}`);
  await ctx.close();
}
await browser.close();
console.log(errors.length ? `ERRORS (${errors.length}):\n${errors.join("\n")}` : "UI walk clean: no console errors, no page errors, no 5xx");
