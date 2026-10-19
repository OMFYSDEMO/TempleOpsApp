# IVOS (Independent Villa Operating System) — process-flow and Cloudflare D1 review

Reviewed against the *AVOS Books Product Tour* mock (`index.html`, 19 guided steps, five roles; `capture.html`, the mobile quick-capture mock). Pilot property: Meadows Varkala, 4 rooms. Reviewer notes are written for the build, so each finding ends with a concrete decision to take.

---

## 1. Verdict in brief

**The Lead → CA chain is in the right order and the role model is sound.** The sequence
Lead → Quote → Hold → Won → Booking → Approval → Check-in → Collect → Check-out → Invoice → (OTA settlement) → Bank reconcile → Pre-close → Lock → GST sheet → Filed
is the correct spine for a small hospitality business, and the "who holds the money decides who records it" split (petty cash = property manager, bank = owner) is a good rule that will survive into SaaS.

**Six things must be decided before build starts** because they change table shapes, not screens:

| # | Gap | Why it matters |
|---|-----|----------------|
| 1 | No room inventory / availability layer | Hold and Won do not consume room-nights; direct holds collide with STAAH/OTA bookings |
| 2 | GST position is unresolved | Invoice charges 5% while GSTIN reads "[when registered]"; slab is per room-night and the Premium rate sits exactly on the ₹7,500 threshold |
| 3 | Every direct booking waits for Trupti | Approval-by-default contradicts "management by results"; makes one person the bottleneck |
| 4 | Gateway/OTA fees can be booked twice | Fees post at payment (W3) and again as "implied fee" at reconciliation (W7) — the same class of error as the duplicate ₹806 |
| 5 | Payout formula omits TCS/TDS | Acceptance test says Expected = Received with no TCS/TDS lines, yet the tour says both post as credits |
| 6 | No cash ledger | Desk cash, bank deposits and petty-cash top-ups have no account; top-up is listed as an *expense* |

**Cloudflare Workers + D1 is feasible and a good fit** for the pilot and for a small SaaS. The constraints that shape the design are listed in §4; none of them block the product.

---

## 2. Process-flow findings, ranked

### 2.1 Blocking (decide before the schema is written)

**F1 · Inventory and availability.**
The tour has no room-night calendar. A lead on *Hold 48 h* must block the rooms, *Won* must consume them, and both must be visible against the OTA bookings that arrive through W1. Today STAAH is the inventory master for OTAs; a direct hold in IVOS that is not closed out in STAAH is a double booking waiting to happen.
*Decision:* add a `room_nights` (or `allocations`) table keyed by room and date, written by W1 (OTA), W2 (direct) and W13 (Hold). The Quote button checks availability first. For v1, a Hold/Won raises a checklist nudge "close out in STAAH"; a STAAH API push is a later step. Hold expiry must release the rows.

**F2 · GST.**
Three separate issues:
- You cannot charge GST without a GSTIN. At roughly ₹1.95 L/month the property is above the ₹20 L services threshold, so registration is required before go-live, not "when registered". The invoice needs a no-GST mode until the GSTIN exists.
- The slab is per room-night on declared tariff: up to ₹7,500 → 5% without input credit; above ₹7,500 → 18% with input credit. *Premium Peak* is ₹7,500 exactly, so any uplift flips the slab. GST must be a computed field per line, never a hard-coded 5%.
- Advances: for services the time of supply includes receipt of an advance, so an advance taken in September for a December stay has a GST consequence in September even though revenue books at check-out. The GST sheet needs an advances line (receipt vouchers) and, on cancellation, refund vouchers. Confirm the treatment with the CA.
- Because the 5% slab carries no input credit, the vendor GST captured on expenses is a cost, not a credit. Say so on the expense screen so nobody expects it to reduce the GST payable.

**F3 · Approval by exception, not by default.**
Every WhatsApp booking waiting for Trupti adds latency for the guest and makes Trupti the bottleneck. The tour already shows the rule it needs: "rate vs tariff card: on tariff".
*Decision:* auto-approve a direct booking when it is on tariff, within standard terms and (optionally) an advance is received; route only exceptions (off-tariff, discount, manual rate, > N rooms) to Trupti. Keep the approval row in the audit log either way. Separately, approval is approval of *terms*; it must not block Sindhu from recording an advance.

**F4 · Fees are booked once.**
W3 says gateway fees "book themselves" at payment. W7 tier 3 then computes an "implied fee 2.36%" on the same Airpay settlement. W4 creates fee expenses at settlement; W7 tier 4 matches the same payout.
*Decision:* the fee expense is created once, at payment or settlement time, at the contracted rate. Reconciliation may only *adjust* that expense to actual (a variance line linked to it) and may never create a second fee. The acceptance test should include this case.

**F5 · OTA payout formula and collection type.**
The mock's arithmetic checks out (commission on the ex-GST room value, 1.99% fee on gross, net ₹30,836.26), but the settlement has no TCS/TDS lines while the narrative says both post as recoverable credits. If Booking.com deducts them, Expected ≠ Received.
*Decision:* `received = gross − commission(base) − payment fee − TCS − TDS`, with commission base, fee %, TCS % and TDS % as per-channel configuration (the statutory rates changed in 2024 and will change again). Also add the *hotel-collect* OTA path: guest pays at the desk, the OTA invoices commission monthly and Shaji pays it by bank. "Checking out an OTA guest collects nothing" is only true for channel-collect.

**F6 · Cash ledger.**
The unmatched "CASH DEP VARKALA BR ₹17,500" shows the gap: cash collected at the desk has no account, so a bank deposit of that cash has nothing to match. The tour also lists "Petty cash top-up to Sindhu ₹3,000" under *bank expenses*; it is a transfer, and recording it as an expense overstates expenses in the P&L.
*Decision:* model three money accounts (bank, cash in hand, petty cash) and a `transfer` record type (deposit to bank, top-up to petty cash). Reconciliation tier 1 then matches the deposit to the transfer.

### 2.2 Important (fix in v1, smaller blast radius)

- **F7 · Role wall vs Smart Reconcile.** Trupti must not see expenses, but a pasted bank statement contains every debit. Either split reconciliation (credits → Trupti, debits → Shaji or CA) or accept that Trupti sees bank debit amounts but no P&L. Pick one and write it into the role matrix.
- **F8 · Lead state machine needs expiries.** Quote valid 48 h and Hold 48 h have no defined transition on expiry. Add automatic Quoted → Lost (reason: expired) and Hold → Quoted or Lost, and make Hold expiry release inventory (F1). Keep the five visible statuses; expiry is a reason chip, not a sixth state.
- **F9 · Guest identity.** Lead cards say "new guest (no stays yet)", so a guest master exists. Key it on phone number; OTA bookings arrive with masked emails, so dedupe on phone + name and let Sindhu merge at check-in.
- **F10 · Cancellation in v1.** OTA cancellations arrive in W1 from day one, so `Cancelled` and `No-show` booking statuses are v1 even if the refund money movement and credit notes stay v1.5. A cancelled booking must release inventory and reverse any advance-GST position (F2).
- **F11 · Month lock semantics.** Define what "locked" blocks: any record *dated* in the month. A payment received in October for a September stay posts in October with its own date; it never back-dates. Pre-close exception "part-paid stays" already anticipates this.
- **F12 · Revenue date.** "Books date = check-out" is fine and simple; state it as the rule so a 30 Sep → 2 Oct stay is understood to book entirely in October.
- **F13 · Invoice numbering scope.** Sequential per financial year (April–March) *and per property*, surviving deletes; credit notes on their own sequence. The mock already shows this; make it a database constraint, not a UI rule.
- **F14 · Backups via "owner's Gmail".** Gmail API from a Worker means OAuth refresh tokens to maintain. Store the pack immutably in R2 and send a link with Cloudflare's email send or a transactional provider instead.

### 2.3 Build-order comment

The proposed order (auth & roles → parity with the live books → payouts & reconcile → inbox → role walls & tasks → invoices → month close → migrate → leads) is sensible. Two moves: pull **inventory (F1)** and the **GST decision (F2)** into the parity step, because they change the booking and invoice shapes that everything else depends on; and include `Cancelled` (F10) in W2 from the start.

---

## 3. The flow as it should read (Lead → CA)

```
Lead (W13)        New → Contacted → Quoted → Hold → Won | Lost(reason)
                  Quote checks availability; Hold blocks room-nights; expiry releases them
Booking (W2/W1)   Provisional → Approved (auto if on-tariff, else Trupti) → Cancelled | No-show
                  OTA bookings from inbox; collection type = channel-collect | hotel-collect
Stay              Check-in → Check-out  (check-out of direct guest chains Collect → Invoice)
Money             Advance / balance (UPI, cash, card, Airpay link) → fee booked once
                  Cash in hand → deposit to bank (transfer) ; bank → petty cash (transfer)
Invoice (W6)      Sequential per FY per property; GST computed per line; credit note links
OTA (W4)          Settlement: gross − commission − fee − TCS − TDS = received; undo removes all
Reconcile (W7)    Credits (Trupti) / debits (Shaji) ; nothing writes until accepted
Pre-close         Trupti clears exceptions → CA locks (pack v1 to R2) → GST sheet → Filed
```

---

## 4. Cloudflare D1 feasibility

### 4.1 Verdict

Feasible, and a good fit. A 4-room villa produces a few thousand rows a month; the whole pilot sits comfortably inside D1's smallest limits. The design has to respect three D1 facts, all verified against Cloudflare's current documentation:

1. **No interactive transactions.** There is no `BEGIN … COMMIT` across round-trips. `batch()` runs its statements sequentially as one SQLite transaction and rolls back the whole list if any statement fails. Every multi-row write (booking + inventory + audit; payment + fee + audit; settlement + N expenses) must be one `batch()` call. Build the data layer around this from day one.
2. **Billing is by rows read and written, and free-tier limits now fail queries.** Since 1 September 2026, exceeding the free daily limits (5 M rows read, 100 k rows written) returns errors until midnight UTC. For a live property use the Workers Paid plan from day one (US$5/month, 25 B reads and 50 M writes a month included, 5 GB storage included). Index every column you filter on (`property_id`, status, dates) so the reconcile and dashboard queries do not scan.
3. **Backups exist but need belt and braces.** D1 Time Travel gives point-in-time restore (via API/`wrangler`). Add a scheduled `d1 export` to R2 for the month-close pack so the "immutable statement pack" requirement is met by an object you control.

### 4.2 Mapping each workflow to a Cloudflare primitive

| Workflow | Primitive | Notes |
|----------|-----------|-------|
| Web + mobile UI (W5a quick capture) | Workers with static assets, PWA | Offline queue in IndexedDB with a client-generated UUID per entry as idempotency key; the Worker upserts on that key so retries never duplicate (rule 6) |
| Auth and role walls | Cloudflare Access (Zero Trust) in front + role check in every API route | Access is free for up to 50 users and gives Google/OTP login without writing auth. Role enforcement stays in the Worker so "test the API, not the menu" is testable |
| Books | D1 | One database for the pilot; `property_id` on every table from day one (see §4.4) |
| Bill photos, invoice PDFs, statement packs | R2 private bucket | Served through the Worker with role checks; never a public bucket |
| Inbox W1 (STAAH, SwiftBook, Airpay emails) | Email Routing → Email Worker (`postal-mime`) | Auto-forward the current mailbox to `inbox@<your-domain>`; the Worker parses to an `inbox_items` table, stores the raw `.eml` in R2, and anything it cannot parse becomes a manual-review card (the mock already has Approve / Edit / Dismiss) |
| Leads W13 | Worker endpoints | Meta Lead Ads webhook and website form post to the Worker. WhatsApp quote in v1 is a `wa.me` deep link with prefilled text (zero integration); WhatsApp Cloud API later |
| Nudges 15/60 min, Hold and quote expiry, morning summaries | Cron Triggers | One-minute granularity is available; a 5-minute cron is enough |
| Sequential invoice and credit-note numbers | `sequences` table updated inside the same `batch()` as the insert | D1 has a single writer per database, so `UPDATE … RETURNING` in the batch is race-free |
| Audit log (who/when/before/after) | `audit_log` table written in the same batch as every mutation | Append-only; the GST change log is a view over it |
| Invoice PDF | Browser Run `/pdf` quick action (Workers binding) or pure-JS `pdf-lib` | Browser Run keeps `invoice.html` as the single reference; free plan allows 10 browser-minutes a day, paid plan is fine. `pdf-lib` avoids the dependency if volume is tiny |
| Month lock | `period_locks` table checked in every write path | Pack v1/v2 stored in R2 with immutable names (`2026-09/pack-v1.pdf`) |
| Bill OCR ("vendor & bill no. later from the photo") | Workers AI vision model or Claude API | Optional; keep as P2 |
| Email sends (invoice, pack) | Cloudflare email send from Workers or a transactional provider | Avoid Gmail OAuth (F14) |

### 4.3 D1 data rules for a book-keeping system

- **Money as INTEGER paisa.** Never `REAL`. The "to the paisa" golden tests depend on it.
- **Dates as ISO text.** Workers run in UTC; compute `books_date`, financial year and "today" explicitly in Asia/Kolkata.
- **Every table carries `property_id`.** Costs nothing now; makes the SaaS turn a configuration change rather than a migration.
- **Soft rows, not deletes, for anything numbered or locked.** Invoice numbers survive deletes; locked months reject writes at the API.
- **Keep statements small.** D1 caps bound parameters per statement; bulk inserts (migration, payout settlement) go through batches of prepared statements, not one giant `INSERT`.
- **Migrations through `wrangler d1 migrations`**, never schema changes on the hot path (D1 bills index builds as writes).

### 4.4 Path to SaaS

Start single-tenant with `property_id` everywhere. For the first few dozen customers a shared database with row-level scoping in the data layer is simplest. If a customer later needs isolation, D1 databases can be created per tenant via the API and the Worker can route by tenant; the per-database size cap (10 GB on paid plans) is many years of villa data. Billing, user admin and the approval matrix (which events need approval, by which role) should be per-property configuration from the start so Trupti's "approves every instance" is one tenant's setting rather than a product rule.

### 4.5 Risks and external dependencies

| Risk | Mitigation |
|------|-----------|
| STAAH / SwiftBook / Airpay change their email templates | Store every raw email in R2, version the parsers, keep golden email fixtures in tests, and fall back to a manual-review card |
| Email Routing requires a domain on Cloudflare and authenticated senders (SPF/DKIM) | Forward from the existing mailbox; forwarded mail from Gmail is authenticated |
| Meta Lead Ads webhook needs app review for lead retrieval | Start the review early; it takes weeks, and W13 is the last build step anyway |
| WhatsApp Cloud API templates and cost | `wa.me` deep links for v1; Cloud API only when notifications (W12) arrive |
| Free-tier D1 now hard-fails over limits | Workers Paid from go-live |
| Single primary D1 per database | Fine for one property; read replication via the Sessions API is available at no extra cost if dashboards ever need it |

---

## 5. Questions for Shaji and the CA before build

1. GST registration date and the treatment of advances (F2).
2. Which direct-booking exceptions need Trupti, and which auto-approve (F3).
3. Does Booking.com deduct TCS and TDS from the payout, and is the commission base ex-GST for every channel (F5).
4. Does the property take hotel-collect OTA bookings today (F5).
5. Who sees bank debits during reconciliation (F7).
