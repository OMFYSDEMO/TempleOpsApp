import { Hono } from "hono";
import type { Env } from "./env";
import { authenticate, errorHandler, type AppEnv } from "./app";
import leads from "./routes/leads";
import inbox from "./routes/inbox";
import income from "./routes/income";
import bookings from "./routes/bookings";
import payments from "./routes/payments";
import invoices from "./routes/invoices";
import tasks from "./routes/tasks";
import expenses from "./routes/expenses";
import approvals from "./routes/approvals";
import settlements from "./routes/settlements";
import recon from "./routes/recon";
import reports from "./routes/reports";
import close from "./routes/close";
import admin from "./routes/admin";
import hooks from "./routes/hooks";
import auth from "./routes/auth";
import { runCron } from "./cron";
import { handleEmail } from "./email/handler";

const app = new Hono<AppEnv>();
app.onError(errorHandler);

app.get("/api/health", async (c) => {
  // Shallow by default; ?deep=1 pings D1 and R2 so a smoke test can prove the bindings work.
  const out: Record<string, unknown> = { ok: true, env: c.env.APP_ENV };
  if (c.req.query("deep")) {
    try { const r = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM properties").first<{ n: number }>(); out.db = r ? "ok" : "empty"; } catch (e) { out.ok = false; out.db = String((e as Error).message); }
    try { await c.env.FILES.head("health-probe"); out.r2 = "ok"; } catch (e) { out.ok = false; out.r2 = String((e as Error).message); }
  }
  return c.json(out, out.ok ? 200 : 503);
});
app.route("/hooks", hooks as unknown as Hono<AppEnv>);
app.route("/api/auth", auth as unknown as Hono<AppEnv>);

const api = new Hono<AppEnv>();
api.use("*", authenticate);
api.route("/leads", leads);
api.route("/inbox", inbox);
api.route("/bookings", bookings);
api.route("/payments", payments);
api.route("/invoices", invoices);
api.route("/tasks", tasks);
api.route("/expenses", expenses);
api.route("/income", income);
api.route("/approvals", approvals);
api.route("/settlements", settlements);
api.route("/recon", recon);
api.route("/reports", reports);
api.route("/close", close);
api.route("/", admin);
app.route("/api", api);

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(runCron(env)); },
  async email(message: ForwardableEmailMessage, env: Env) { await handleEmail(message, env); },
} satisfies ExportedHandler<Env>;
