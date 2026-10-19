# Deploying AVOS to Cloudflare, step by step

Everything runs in one Cloudflare account: a Worker (API + web app + email handler + cron), a D1 database, an R2 bucket, Cloudflare Access for logins and Email Routing for the inbox. Budget about an hour the first time. Steps 1–7 are the minimum for a working pilot; 8–10 switch on the inbox, lead hooks and backups.

The app's hostname is `avos.shajianandan.com`. Replace `YOUR-DOMAIN` below with the domain you use for inbound email (step 8) and `YOUR-TEAM` with the Zero Trust team name you pick in step 6.

---

## 1. Prepare the account

1. Sign in at <https://dash.cloudflare.com>.
2. **Workers & Pages → Plans**: upgrade to **Workers Paid** (US$5/month). Since 1 September 2026, D1 on the free plan fails queries once the daily limits are exceeded, so a live property should not run on it.
3. **Workers & Pages → Overview**: note your `workers.dev` subdomain (it is also usable for a first test before you attach a custom domain).
4. Make sure your domain is an active zone on Cloudflare (**Websites** shows it as *Active*). Email Routing and custom domains need this.

## 2. Install the tooling on your computer

```sh
git clone https://github.com/OMFYSDEMO/TempleOpsApp.git avos
cd avos
git checkout claude/confident-hamilton-x510u1
npm install --legacy-peer-deps
npx wrangler login            # opens a browser, authorises Wrangler against your account
npx wrangler whoami           # confirm the account id shown is yours
```

## 3. Create the database and the bucket

```sh
npx wrangler d1 create avos
npx wrangler r2 bucket create avos-files
```

The bucket `avos-files` and a D1 database already exist in the account (created 19 Oct 2026). The database is still *named* `ivos` (D1 databases cannot be renamed; the name is internal and never shown to users) and `wrangler.jsonc` already carries its id `a34a52c8-60bf-4940-9606-8b64512a7cbb`, so skip the two create commands. If you would rather have the database named `avos`, run `npx wrangler d1 create avos`, put the new id in **both** places in `wrangler.jsonc`, change `database_name` to `avos` in `wrangler.jsonc` and the four `db:*` scripts in `package.json`, and delete the old one with `npx wrangler d1 delete ivos`.

**Already done on 19 Oct 2026:** the schema (`0001_init.sql`) and the pilot seed were applied to the live database and the migration is recorded, so `npm run db:migrate:remote` reports nothing to apply. The five users carry the real login addresses (set 19 Oct 2026; they must match the Access login emails exactly). To change one later, use **Settings & users** as the owner, or directly:

```sh
npx wrangler d1 execute ivos --remote --env production --command "UPDATE users SET email='you@example.com' WHERE id='usr_shaji'"
```

(ids: `usr_shaji` owner, `usr_prachi` sales, `usr_sindhu` property, `usr_trupti` revenue, `usr_ca` accountant.) For a fresh database the commands are `npm run db:migrate:remote` then `npm run db:seed:remote` after editing the emails in `seed/meadows-varkala.sql`.

## 4. First deploy (no logins yet)

**Done on 19 Oct 2026** via GitHub Actions: the Worker `avos` is live at `https://avos.shajianandan.workers.dev` (version `d3b1d06c`). Every later push to the working branch redeploys automatically.

Two ways. **A** needs nothing on your computer and is what later deploys use too.

**A. From GitHub Actions (recommended).** The repository carries `.github/workflows/deploy.yml`, which runs the tests, builds the web app, applies any new D1 migrations and deploys the Worker on every push to the working branch.

1. Cloudflare dashboard → profile icon (top right) → **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template**. Under *Permissions* add two rows: **Account · D1 · Edit** and **Account · Workers R2 Storage · Edit**. Under *Account Resources* pick your account. Create it and copy the token (shown once).
2. **Workers & Pages → Overview**: copy the **Account ID** from the right-hand column.
3. GitHub → the `TempleOpsApp` repository → **Settings → Secrets and variables → Actions → New repository secret**, twice: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. GitHub → **Actions → Deploy → Run workflow** (or just push a commit). The run takes about two minutes; the last step prints the `workers.dev` URL.

**B. From your computer.**

```sh
npm run deploy
```

This builds the web app and deploys the Worker as `avos` to `https://avos.<your-subdomain>.workers.dev`. In production the API refuses every request until Access is in front of it (step 6), so opening the URL now shows "not signed in". That is expected.

## 5. Attach your own hostname

**Done on 19 Oct 2026:** the app answers on `https://avos.shajianandan.com`. The hostname is declared in `wrangler.jsonc` (`env.production.routes`) so every deploy keeps it, and the post-deploy smoke test runs against it.

1. **Workers & Pages → avos → Settings → Domains & Routes → Add → Custom Domain**.
2. Enter the hostname and select **Add domain**. Cloudflare creates the DNS record and certificate.
3. Optional but recommended: in the same panel disable the `workers.dev` route and Preview URLs so the app is reachable only on your domain. (Keep `workers.dev` on while the deploy workflow's first smoke test uses it.)
4. **Zone security must let automated callers through.** The first live test on 19 Oct 2026 was answered with a Cloudflare "Just a moment…" challenge page. In the `shajianandan.com` zone go to **Security → Settings**: set **Security level** to *Medium* (not *I'm Under Attack*) and turn **Bot Fight Mode** off, or add a **WAF custom rule** (Security → WAF → Custom rules) with expression `http.host eq "avos.shajianandan.com"` and action **Skip** → all remaining custom rules and *Bot Fight Mode / Super Bot Fight Mode* where offered. Without this, the Meta webhook, the website form and the deploy smoke test are all challenged. Browser users are unaffected either way.

## 6. Put Cloudflare Access in front (logins)

**Done on 19 Oct 2026:** the account's existing Zero Trust team is `kshetrom` (team domain `kshetrom.cloudflareaccess.com`) and an Access application protects `avos.shajianandan.com`. The Worker pins that team domain in `env.production.vars.ACCESS_TEAM_DOMAIN`; `ACCESS_AUD` is optional and blank. Still to do when the lead hooks go live (step 9): a second self-hosted application on `avos.shajianandan.com` with paths `hooks` and `api/health` and a **Bypass** policy for Everyone, otherwise webhooks are sent to the login page.

Access gives you Google / one-time-PIN logins for up to 50 users at no cost, and the Worker trusts only the signed token Access adds to each request.

1. **Zero Trust** (left menu). The first visit asks you to choose a **team name**: pick something like `meadows`. Your team domain is then `meadows.cloudflareaccess.com`. Choose the Free plan.
2. **Zero Trust → Settings → Authentication → Login methods**: **One-time PIN** is on by default. Add **Google** if your team uses Google accounts (follow the on-screen OAuth steps).
3. **Zero Trust → Access controls → Applications → Add an application → Self-hosted**.
   - Application name: `AVOS`
   - **Add public hostname**: `avos.YOUR-DOMAIN` (leave path empty)
   - Session duration: `24 hours` is sensible for a front desk tablet.
4. **Add a policy**: name `Team`, action **Allow**, include **Emails** and list the five login addresses (these are already in the live `users` table):
   - `shajianandan@gmail.com` (owner)
   - `bookings@meadowsvarkala.com` (sales)
   - `meadowsvarkala@gmail.com` (property manager)
   - `trupti@truvic.co.in` (revenue)
   - `shubham.kandalkar@gmail.com` (CA)

   Save the application.
5. Open the application again: the **Overview** tab shows the **Application Audience (AUD) Tag**. Copy it.
6. **Bypass for the lead hooks.** Website and Meta webhooks cannot log in, so add a second application:
   **Add an application → Self-hosted**, name `AVOS hooks`, public hostname `avos.YOUR-DOMAIN` with path `hooks`, policy action **Bypass**, include **Everyone**. (Those endpoints are protected by `HOOK_SECRET` instead, step 9.)
7. Back in the repo, edit `wrangler.jsonc` under `env.production.vars`:
   - `ACCESS_TEAM_DOMAIN`: `meadows.cloudflareaccess.com` (no `https://`)
   - `ACCESS_AUD`: the AUD tag you copied
8. Redeploy:

```sh
npm run deploy
```

9. Open `https://avos.YOUR-DOMAIN`. Access shows the login page; sign in with one of the seeded emails. You land in AVOS as that role. If you see "no active user for …", the login email does not match the `users` table: fix the email under **Settings & users** (as the owner) or in the seed.

Why a hostname application and not the one-click "Protect this Worker"? The one-click option protects every route on the Worker, including `/hooks/*`, which would block the lead webhooks.

## 7. Verify the pilot

1. As the owner: **Settings & users** → check the team list, the tariff card and the channel terms (Booking.com commission, payment fee).
2. As sales: create a lead, quote, hold, win it → it appears in **Availability**.
3. As property: check in, record a UPI payment, check out, issue the invoice. The invoice says *GST not applicable* until step 10.
4. As revenue: **Approvals** is empty (on-tariff bookings approve themselves). Paste two bank lines into **Smart Reconcile**.
5. **Workers & Pages → avos → Logs** streams errors if anything misbehaves.

## 8. Email Routing: STAAH, SwiftBook and Airpay mail into the inbox

1. **Compute → Email Service → Email Routing → Onboard domain**, pick `YOUR-DOMAIN`, accept the MX/SPF/DKIM records Cloudflare adds. If the domain already receives mail elsewhere (Google Workspace), do **not** onboard it; use a subdomain instead, e.g. onboard `mail.YOUR-DOMAIN`.
2. **Routing Rules → Create routing rule**: email pattern `inbox`, action **Send to a Worker**, Worker `avos`. Save.
   (Alternative: uncomment `"addresses": ["inbox@YOUR-DOMAIN"]` under `env.production` in `wrangler.jsonc`; Wrangler then manages the rule on deploy.)
3. In the mailbox that currently receives STAAH, SwiftBook and Airpay notifications (usually Gmail), add a filter: *from staah.com OR swiftbook OR airpay → forward to `inbox@YOUR-DOMAIN`*. Gmail asks you to confirm the forwarding address: the confirmation email arrives in AVOS **Inbox** as an "unknown" item; open it there, copy the code, and finish the Gmail confirmation.
4. Send yourself a test: forward an old STAAH reservation email. It appears under **Inbox — bookings** parsed; a payment email appears under **Payments → From inbox**.

Every email's raw `.eml` is kept in R2 (`inbox/…`), so if a template changes and the parser misreads it, nothing is lost: edit the fields on the card or dismiss it.

## 9. Lead hooks (website form, Instagram and Facebook lead forms)

1. Create the hook secret (a long random string):

```sh
npx wrangler secret put HOOK_SECRET --env production
```

2. **Website form**: point it at `https://avos.YOUR-DOMAIN/hooks/leads/website?key=<HOOK_SECRET>` with fields `name`, `phone`, `email`, `check_in`, `check_out`, `rooms`, `adults`, `message` (JSON or form-encoded). Each submission becomes a lead card assigned to sales.
3. **Meta lead forms**: in the Meta developer app add a Webhook for the Page `leadgen` field, callback URL `https://avos.YOUR-DOMAIN/hooks/leads/meta?key=<HOOK_SECRET>`, verify token = the same secret. Meta requires the `leads_retrieval` permission and App Review before it sends real leads; start that early.
4. WhatsApp quotes need no setup: the Quote button opens WhatsApp with the message prefilled.

## 10. GST, TCS/TDS and backups

1. **GSTIN**: when the registration arrives, the owner enters it under **Settings & users → Property & GST**. From that moment invoices carry GST per room-night and the GST filing sheet is live. Until then the sheet is empty and invoices say *GST not applicable*.
2. **TCS / TDS**: when the first Booking.com statement shows deductions, enter the percentages on the channel under **Settings & users → Channels** (basis points: 50 = 0.50 %). The payout formula and the recoverable credits pick them up immediately.
3. **Backups**: D1 keeps 30 days of point-in-time history (**Workers & Pages → D1 → avos → Time Travel**). Month-close packs are written to R2 under `packs/` and never overwritten. For an extra off-platform copy, run monthly:

```sh
npx wrangler d1 export ivos --remote --env production --output avos-$(date +%F).sql
```

## 11. Updating the app later

```sh
git pull
npm install --legacy-peer-deps
npm run db:migrate:remote      # applies any new migrations
npm run deploy
```

Wrangler keeps previous versions; **Workers & Pages → avos → Deployments → Rollback** restores the last one in seconds.

## Troubleshooting

| Symptom | Cause | Fix |
|--------|-------|-----|
| `not signed in` on the custom domain | Access application not covering the hostname, or `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` wrong | Check the AUD tag on the Access app's Overview; redeploy |
| `no active user for x@y` | Login email not in `users` | Owner adds it under Settings & users |
| Website form gets `bad hook key` | Missing or wrong `?key=` | Match it to `HOOK_SECRET` |
| Emails not arriving in Inbox | Routing rule disabled or forwarding unconfirmed | Email Routing → Routing Rules status; finish the Gmail confirmation |
| `period … is locked` (HTTP 423) | Writing a dated record into a locked month | The CA unlocks it; re-lock makes a revised pack |
| D1 "exceeded free tier" errors | Still on Workers Free | Upgrade to Workers Paid (step 1) |
