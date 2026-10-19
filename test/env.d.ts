import type { Env as Bindings } from "../src/env";
import type { D1Migration } from "@cloudflare/vitest-plugin";

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
declare module "*.sql?raw" { const sql: string; export default sql; }
export {};
