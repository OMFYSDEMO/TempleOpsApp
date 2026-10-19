export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  APP_ENV: string;              // development | test | production
  ACCESS_TEAM_DOMAIN: string;   // e.g. meadows.cloudflareaccess.com
  ACCESS_AUD: string;           // Access application audience tag
  DEV_USER_EMAIL: string;       // used only outside production when Access is not configured
  INBOX_PROPERTY_ID?: string;   // property that owns the routed mailbox (single-tenant pilot)
}
