import { Hono } from "hono";
import type { Env } from "./env";
import { authenticate, errorHandler, type AppEnv } from "./app";
import leads from "./routes/leads";
import inbox from "./routes/inbox";
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
import { runCron } from "./cron";
import { handleEmail } from "./email/handler";

const app = new Hono<AppEnv>();
app.onError(errorHandler);

app.get("/api/health", (c) => c.json({ ok: true, env: c.env.APP_ENV }));
app.route("/hooks", hooks as unknown as Hono<AppEnv>);

const api = new Hono<AppEnv>();
api.use("*", authenticate);
api.route("/leads", leads);
api.route("/inbox", inbox);
api.route("/bookings", bookings);
api.route("/payments", payments);
api.route("/invoices", invoices);
api.route("/tasks", tasks);
api.route("/expenses", expenses);
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
