# AVOS — Autonomous Villa Operating System

Books-first operations for an independent villa: leads, bookings, front desk, collections, invoices, tasks, petty cash, OTA payouts, bank reconciliation, month close and the GST filing sheet — one Cloudflare Worker, one D1 database, one R2 bucket.

Pilot property: Meadows Varkala (4 rooms). Every table carries `property_id`, so the SaaS turn is configuration, not migration.

## Stack

| Layer | Choice |
|-------|--------|
| API | Cloudflare Workers · [Hono](https://hono.dev) · TypeScript |
| Books | D1 (SQLite). Money is integer paise. Multi-row writes are one `batch()` (one transaction). |
| Files | R2 (bill photos, invoice PDFs, month-close packs) served only through the role-checked API |
| Inbox | Email Routing → Email Worker (`postal-mime`) parses STAAH / SwiftBook / Airpay mail; confident, consistent emails book, cancel and record payments on arrival, the rest wait with a reason |
| Nudges | Cron Trigger every 5 min: hold & quote expiry, 15/60-minute lead nudges |
| Auth | AVOS's own email + password login (PBKDF2, D1 sessions, secure cookie, lockout, forced change, reset links); Cloudflare Access accepted as an optional second layer. Role walls are enforced per API route. |
| UI | React + Vite PWA served as Worker static assets; quick capture is offline-first with idempotency keys |

## Run locally

```sh
npm install --legacy-peer-deps
npm run db:migrate:local
npm run db:seed:local            # Meadows Varkala: users, rooms, tariff card, channels, money accounts
npm run build:web
npm run dev                      # http://localhost:8787
```

Sign in with email and password. Outside production the sign-in screen also offers the seeded users (dev header), and `DEV_USER_EMAIL` in `wrangler.jsonc` (empty by default) can pin a default identity for API tools like curl. In production only a session cookie or a Cloudflare Access token is accepted; the owner sets passwords or hands out set-password links under Settings & users.

```sh
npm test                         # domain tests + the Lead → CA flow against an isolated D1
npm run typecheck
```

## Deploy

Follow `docs/deploy-cloudflare.md` — eleven numbered steps from a fresh Cloudflare account to a live pilot with Access logins, Email Routing and lead hooks. Short version:

```sh
npx wrangler login
npx wrangler d1 create avos && npx wrangler r2 bucket create avos-files   # put the D1 id in wrangler.jsonc (both places)
npm run db:migrate:remote && npm run db:seed:remote                        # edit the seed emails first
npm run deploy                                                              # wrangler deploy --env production
```

Then attach a custom domain, create the Access application (team domain + AUD tag into `env.production.vars`), set `HOOK_SECRET`, and redeploy.

## The rules the code enforces

- **Inventory.** `room_nights` has one row per room per night; a Hold or a booking occupies it, the primary key makes a double booking impossible, holds expire by cron.
- **GST per room-night.** The slab comes from the declared tariff (≤ threshold → 5 % no ITC, above → 18 %), computed per night, and no GST at all until the property has a GSTIN. Invoices say so.
- **Approval by exception.** On-tariff direct bookings and parsed OTA reservations approve themselves (audited); off-tariff, oversize or manual-rate bookings wait for the revenue desk.
- **Fees once.** A gateway fee is created with its payment at the contracted rate and voided with it. Reconciliation may add a variance line, never a second fee. Settlement expenses are created on Mark settled and removed by Undo.
- **Payout formula.** `received = gross − commission − payment fee − TCS − TDS`, every rate and base from the channel row; TCS/TDS post as recoverable credits for the GST sheet and 26AS.
- **Cash ledger.** Bank, cash in hand, petty cash and the gateway clearing account; deposits and top-ups are transfers, never expenses. Who holds the money records its movements.
- **Period lock.** Any write dated inside a locked month is refused (HTTP 423) for every role, the owner included. Lock stores pack v1 in R2; unlock → re-lock stores v2 "revised".
- **Sequential numbers.** Invoices `MV/26-27/001` and credit notes `MV/CN/26-27/001` per property per financial year, allocated atomically; invoices are never deleted, only credited.
- **Audit.** Every mutation writes an `audit_log` row (who, when, before, after) in the same batch.

See `docs/avos-process-and-d1-review.md` for the process review that led here.

## Other income

Money earned outside room stays (meals for day guests, photoshoots, events) is recorded under Payments → Other income, inclusive of GST with the slab chosen at entry. It reaches the money-account balances, the revenue overview, the P&L, the GST filing sheet and the month-close statement pack.
