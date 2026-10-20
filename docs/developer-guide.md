# AVOS developer guide

For React and Node.js developers joining the project. One repository, one deployable: a Cloudflare Worker that serves the API, handles inbound email, runs a cron, and serves the React app as static assets.

## Stack

| Layer | What | Where |
|---|---|---|
| Front end | React 19 + TypeScript, built by Vite 7, PWA with an offline queue | `web/src` |
| API | Hono 4 on Cloudflare Workers (Express-style routing; `c.req`, `c.json`) | `src/routes/*.ts` |
| Business rules | Plain TypeScript, no framework | `src/domain/*.ts`, `src/services/*.ts` |
| Database | Cloudflare D1 (SQLite). Migrations are plain SQL, applied in order | `migrations/*.sql` |
| Files | Cloudflare R2 (bill photos, stored emails, month-close packs) | binding `FILES` |
| Email in | Cloudflare Email Routing → `src/email/handler.ts` → `src/email/parsers.ts` | |
| Scheduled | Cron every 5 minutes: holds, quotes, nudges, inbox re-reads | `src/cron.ts` |
| Tests | Vitest 4 running inside the Workers runtime against a seeded D1 | `test/*.test.ts` |
| Deploy | GitHub Actions on push: typecheck, test, build, migrate, deploy, smoke-test | `.github/workflows/deploy.yml` |

Money is always an integer in paise. Dates are ISO strings in the property's timezone (Asia/Kolkata). Every write that touches more than one table goes through `Batch` (`src/db.ts`), which runs the statements as one D1 batch and writes the audit row in the same batch.

## Run it locally

```sh
npm install --legacy-peer-deps
npx wrangler d1 migrations apply ivos --local     # creates the local SQLite
npx wrangler d1 execute ivos --local --file=seed/meadows-varkala.sql   # demo property, users, rooms, channels
npm run build:web                                  # the Worker serves web/dist
npx wrangler dev --port 8787                       # API + app at http://localhost:8787
```

For front-end work with hot reload, run `npx vite --config web/vite.config.ts` in a second terminal; it proxies `/api` to port 8787.

Locally there is no login wall: send the header `x-dev-user: <email of a seeded user>` and you are that user (`seed/meadows-varkala.sql` lists them: owner, sales, property, revenue, accountant). In production the header is ignored and the app's own email + password login applies.

## Where things are

- `src/index.ts` mounts every router under `/api/*` and `/hooks/*`, the email handler and the cron.
- `src/app.ts` is the request context: property, actor (the signed-in user), `requireCap("…")` role gate, input helpers (`str`, `int`, `paise`, `date`, `oneOf`).
- `src/auth.ts` lists the capabilities per role. A screen in `web/src/app.tsx` is shown when the user has its `cap`.
- `web/src/api.ts` is the fetch wrapper (`get`, `post`, `patch`, `del`); `web/src/offline.ts` queues writes when offline.
- `web/src/ui.tsx` holds the small component kit (Card, Row, Btn, Chips, Field, Status, Keypad, `useLoad`, `run`, `toast`) and formatting (`inr`, `fmtDate`).
- `web/src/screens/` one file per area: `sales.tsx` (leads, inbox, reservations, availability), `property.tsx` (front desk, payments, invoices, tasks, expenses), `management.tsx` (approvals, payouts, reconcile, reports, dashboard, admin, close, GST, audit), `ids.tsx` (guest IDs, Form C, Drive settings), `auth.tsx`.
- Money accounts: `defaultBank()` / `bankAccount()` in `src/db.ts`; owner CRUD under `/api/admin/accounts`; `BankPick` in `web/src/ui.tsx` renders only when there is more than one bank.
- Marketing scorecard: `marketingScorecard()` in `src/services/reports.ts`, served at `/api/reports/marketing`; campaign fields come in on leads (website UTM, Meta `campaign_name`/`ad_name`, or typed) and on expenses. Screen in `web/src/screens/marketing.tsx`.
- Guest IDs: `src/routes/ids.ts` (capture, view, Form C), `src/services/drive.ts` (Google OAuth, Drive client, the 48-hour archive run from `src/cron.ts`); process and setup in `docs/guest-ids.md`.

## Adding a feature, the usual shape

1. Migration: `migrations/000N_name.sql` (never edit an applied one).
2. Route: a handler in `src/routes/<area>.ts`, behind `requireCap`. Validate with the helpers, write through `Batch`, audit with `b.audit(...)`.
3. Test: `test/<area>.test.ts` using `seed()`, `ok(user, method, path, body)` and `sql(...)` from `test/helpers.ts`. `npm test`.
4. Screen: a component in `web/src/screens/<area>.tsx`, loaded with `useLoad(() => get("/…"))`, actions through `run(async () => { … }, "toast text")`.
5. Push to the working branch. CI deploys and smoke-tests; the log shows the deployed version.

## Things that differ from a Node server

- The Worker has no filesystem and no long-lived process. Anything persistent is D1 or R2; anything periodic is the cron.
- `nodejs_compat` is on, so most of `node:` works, but prefer Web APIs (`fetch`, `crypto.subtle`, `TextEncoder`).
- Secrets come from `wrangler secret put` (locally `.dev.vars`); plain settings are `vars` in `wrangler.jsonc`.
- D1 is SQLite: no `RETURNING` games, no temp tables in the HTTP API, keep statements simple and batched.
