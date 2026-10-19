import { applyD1Migrations, env } from "cloudflare:test";

// Runs once per test file before anything else: applies migrations/ to the isolated D1.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
