export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  APP_ENV: string;              // development | test | production
  ACCESS_TEAM_DOMAIN: string;   // optional: Cloudflare Access team whose logins are also accepted
  ACCESS_AUD: string;           // optional: pin one Access application
  DEV_USER_EMAIL: string;       // used only outside production when no session or Access token is present
  INBOX_PROPERTY_ID?: string;   // property that owns the routed mailbox (single-tenant pilot)
  HOOK_SECRET?: string;         // shared key in lead-hook URLs (?key=) and the Meta webhook verify token (secret)
  META_APP_SECRET?: string;     // Meta app secret: verifies X-Hub-Signature-256 on lead webhooks (secret)
  META_PAGE_TOKEN?: string;     // long-lived Page access token with leads_retrieval: fetches lead answers from the Graph API (secret)
  META_GRAPH_VERSION?: string;  // optional, e.g. v21.0
  WORK_QUEUE_LIVE_SINCE?: string; // ISO time: items already waiting before it are listed but not raised with a notification
  APP_URL?: string;             // public base URL used in password links, e.g. https://avos.shajianandan.com
  EMAIL?: { send(msg: { from: string; to: string; subject: string; text: string; html?: string }): Promise<unknown> }; // Cloudflare Email Sending binding (optional)
  EMAIL_FROM?: string;          // verified sender, e.g. avos@shajianandan.com
  GOOGLE_CLIENT_ID?: string;    // OAuth web client for the Drive ID archive (secret)
  GOOGLE_CLIENT_SECRET?: string; // its client secret (secret)
}
