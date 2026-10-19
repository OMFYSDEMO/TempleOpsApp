export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  APP_ENV: string;              // development | test | production
  ACCESS_TEAM_DOMAIN: string;   // optional: Cloudflare Access team whose logins are also accepted
  ACCESS_AUD: string;           // optional: pin one Access application
  DEV_USER_EMAIL: string;       // used only outside production when no session or Access token is present
  INBOX_PROPERTY_ID?: string;   // property that owns the routed mailbox (single-tenant pilot)
  APP_URL?: string;             // public base URL used in password links, e.g. https://avos.shajianandan.com
  EMAIL?: { send(msg: { from: string; to: string; subject: string; text: string; html?: string }): Promise<unknown> }; // Cloudflare Email Sending binding (optional)
  EMAIL_FROM?: string;          // verified sender, e.g. avos@shajianandan.com
}
