# Deploying IVOS to Cloudflare, step by step

Everything runs in one Cloudflare account: a Worker (API + web app + email handler + cron), a D1 database, an R2 bucket, Cloudflare Access for logins and Email Routing for the inbox. Budget about an hour the first time. Steps 1–7 are the minimum for a working pilot; 8–10 switch on the inbox, lead hooks and backups.

Replace `YOUR-DOMAIN` with a domain that is on Cloudflare DNS (for example `meadowsvarkala.com`) and `YOUR-TEAM` with the Zero Trust team name you pick in step 6.

---

## 1. Prepare the account

1. Sign in at <https://dash.cloudflare.com>.
2. **Workers & Pages → Plans**: upgrade to **Workers Paid** (US$5/month). Since 1 September 2026, D1 on the free plan fails queries once the daily limits are exceeded, so a live property should not run on it.
3. **Workers & Pages → Overview**: note your `workers.dev` subdomain (it is also usable for a first test before you attach a custom domain).
4. Make sure your domain is an active zone on Cloudflare (**Websites** shows it as *Active*). Email Routing and custom domains need this.

## 2. Install the tooling on your computer

```sh
git clone https://github.com/OMFYSDEMO/TempleOpsApp.git ivos
cd ivos
git checkout claude/confident-hamilton-x510u1
npm install --legacy-peer-deps
npx wrangler login            # opens a browser, authorises Wrangler against your account
npx wrangler whoami           # confirm the account id shown is yours
```

## 3. Create the database and the bucket

```sh
npx wrangler d1 create ivos
npx wrangler r2 bucket create ivos-files
```

The database and bucket already exist in the account (created 19 Oct 2026) and `wrangler.jsonc` already carries the database id `a34a52c8-60bf-4940-9606-8b64512a7cbb`, so these two commands report that the resources exist. If you ever recreate them, replace the id in **both** places in `wrangler.jsonc`.

Then create the tables and the pilot data:

```sh
npm run db:migrate:remote
```

Before seeding, open `seed/meadows-varkala.sql` and change the five `@meadowsvarkala.example` emails to the real addresses your team will sign in with (the Access login email must match exactly). Then:

```sh
npm run db:seed:remote
```

## 4. First deploy (no logins yet)

```sh
npm run deploy
```

This builds the web app and deploys the Worker as `ivos` to `https://ivos.<your-subdomain>.workers.dev`. In production the API refuses every request until Access is in front of it (step 6), so opening the URL now shows "not signed in". That is expected.

## 5. Attach your own hostname

1. **Workers & Pages → ivos → Settings → Domains & Routes → Add → Custom Domain**.
2. Enter `ivos.YOUR-DOMAIN` and select **Add domain**. Cloudflare creates the DNS record and certificate.
3. Optional but recommended: in the same panel disable the `workers.dev` route and Preview URLs so the app is reachable only on your domain.

## 6. Put Cloudflare Access in front (logins)

Access gives you Google / one-time-PIN logins for up to 50 users at no cost, and the Worker trusts only the signed token Access adds to each request.

1. **Zero Trust** (left menu). The first visit asks you to choose a **team name**: pick something like `meadows`. Your team domain is then `meadows.cloudflareaccess.com`. Choose the Free plan.
2. **Zero Trust → Settings → Authentication → Login methods**: **One-time PIN** is on by default. Add **Google** if your team uses Google accounts (follow the on-screen OAuth steps).
3. **Zero Trust → Access controls → Applications → Add an application → Self-hosted**.
   - Application name: `IVOS`
   - **Add public hostname**: `ivos.YOUR-DOMAIN` (leave path empty)
   - Session duration: `24 hours` is sensible for a front desk tablet.
4. **Add a policy**: name `Team`, action **Allow**, include **Emails** and list the five team emails you put in the seed file. Save the application.
5. Open the application again: the **Overview** tab shows the **Application Audience (AUD) Tag**. Copy it.
6. **Bypass for the lead hooks.** Website and Meta webhooks cannot log in, so add a second application:
   **Add an application → Self-hosted**, name `IVOS hooks`, public hostname `ivos.YOUR-DOMAIN` with path `hooks`, policy action **Bypass**, include **Everyone**. (Those endpoints are protected by `HOOK_SECRET` instead, step 9.)
7. Back in the repo, edit `wrangler.jsonc` under `env.production.vars`:
   - `ACCESS_TEAM_DOMAIN`: `meadows.cloudflareaccess.com` (no `https://`)
   - `ACCESS_AUD`: the AUD tag you copied
8. Redeploy:

```sh
npm run deploy
```

9. Open `https://ivos.YOUR-DOMAIN`. Access shows the login page; sign in with one of the seeded emails. You land in IVOS as that role. If you see "no active user for …", the login email does not match the `users` table: fix the email under **Settings & users** (as the owner) or in the seed.

Why a hostname application and not the one-click "Protect this Worker"? The one-click option protects every route on the Worker, including `/hooks/*`, which would block the lead webhooks.

## 7. Verify the pilot

1. As the owner: **Settings & users** → check the team list, the tariff card and the channel terms (Booking.com commission, payment fee).
2. As sales: create a lead, quote, hold, win it → it appears in **Availability**.
3. As property: check in, record a UPI payment, check out, issue the invoice. The invoice says *GST not applicable* until step 10.
4. As revenue: **Approvals** is empty (on-tariff bookings approve themselves). Paste two bank lines into **Smart Reconcile**.
5. **Workers & Pages → ivos → Logs** streams errors if anything misbehaves.

## 8. Email Routing: STAAH, SwiftBook and Airpay mail into the inbox

1. **Compute → Email Service → Email Routing → Onboard domain**, pick `YOUR-DOMAIN`, accept the MX/SPF/DKIM records Cloudflare adds. If the domain already receives mail elsewhere (Google Workspace), do **not** onboard it; use a subdomain instead, e.g. onboard `mail.YOUR-DOMAIN`.
2. **Routing Rules → Create routing rule**: email pattern `inbox`, action **Send to a Worker**, Worker `ivos`. Save.
   (Alternative: uncomment `"addresses": ["inbox@YOUR-DOMAIN"]` under `env.production` in `wrangler.jsonc`; Wrangler then manages the rule on deploy.)
3. In the mailbox that currently receives STAAH, SwiftBook and Airpay notifications (usually Gmail), add a filter: *from staah.com OR swiftbook OR airpay → forward to `inbox@YOUR-DOMAIN`*. Gmail asks you to confirm the forwarding address: the confirmation email arrives in IVOS **Inbox** as an "unknown" item; open it there, copy the code, and finish the Gmail confirmation.
4. Send yourself a test: forward an old STAAH reservation email. It appears under **Inbox — bookings** parsed; a payment email appears under **Payments → From inbox**.

Every email's raw `.eml` is kept in R2 (`inbox/…`), so if a template changes and the parser misreads it, nothing is lost: edit the fields on the card or dismiss it.

## 9. Lead hooks (website form, Instagram and Facebook lead forms)

1. Create the hook secret (a long random string):

```sh
npx wrangler secret put HOOK_SECRET --env production
```

2. **Website form**: point it at `https://ivos.YOUR-DOMAIN/hooks/leads/website?key=<HOOK_SECRET>` with fields `name`, `phone`, `email`, `check_in`, `check_out`, `rooms`, `adults`, `message` (JSON or form-encoded). Each submission becomes a lead card assigned to sales.
3. **Meta lead forms**: in the Meta developer app add a Webhook for the Page `leadgen` field, callback URL `https://ivos.YOUR-DOMAIN/hooks/leads/meta?key=<HOOK_SECRET>`, verify token = the same secret. Meta requires the `leads_retrieval` permission and App Review before it sends real leads; start that early.
4. WhatsApp quotes need no setup: the Quote button opens WhatsApp with the message prefilled.

## 10. GST, TCS/TDS and backups

1. **GSTIN**: when the registration arrives, the owner enters it under **Settings & users → Property & GST**. From that moment invoices carry GST per room-night and the GST filing sheet is live. Until then the sheet is empty and invoices say *GST not applicable*.
2. **TCS / TDS**: when the first Booking.com statement shows deductions, enter the percentages on the channel under **Settings & users → Channels** (basis points: 50 = 0.50 %). The payout formula and the recoverable credits pick them up immediately.
3. **Backups**: D1 keeps 30 days of point-in-time history (**Workers & Pages → D1 → ivos → Time Travel**). Month-close packs are written to R2 under `packs/` and never overwritten. For an extra off-platform copy, run monthly:

```sh
npx wrangler d1 export ivos --remote --env production --output ivos-$(date +%F).sql
```

## 11. Updating the app later

```sh
git pull
npm install --legacy-peer-deps
npm run db:migrate:remote      # applies any new migrations
npm run deploy
```

Wrangler keeps previous versions; **Workers & Pages → ivos → Deployments → Rollback** restores the last one in seconds.

## Troubleshooting

| Symptom | Cause | Fix |
|--------|-------|-----|
| `not signed in` on the custom domain | Access application not covering the hostname, or `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` wrong | Check the AUD tag on the Access app's Overview; redeploy |
| `no active user for x@y` | Login email not in `users` | Owner adds it under Settings & users |
| Website form gets `bad hook key` | Missing or wrong `?key=` | Match it to `HOOK_SECRET` |
| Emails not arriving in Inbox | Routing rule disabled or forwarding unconfirmed | Email Routing → Routing Rules status; finish the Gmail confirmation |
| `period … is locked` (HTTP 423) | Writing a dated record into a locked month | The CA unlocks it; re-lock makes a revised pack |
| D1 "exceeded free tier" errors | Still on Workers Free | Upgrade to Workers Paid (step 1) |
