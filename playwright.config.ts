import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// CI sets DATABASE_URL; locally it comes from .env.
if (!process.env["DATABASE_URL"] && existsSync(".env")) process.loadEnvFile(".env");

// The e2e run gets its own database next to the dev one (job_matcher_e2e), so the users,
// sources and matches it creates never land in dev data. `migrate deploy` creates it.
const databaseUrl = new URL(process.env["DATABASE_URL"] ?? "");
databaseUrl.pathname += "_e2e";

// The API and worker run with fake providers, so the suite never calls Firecrawl,
// OpenRouter or Discord.
const env = { PROVIDERS: "fake", DATABASE_URL: databaseUrl.href };

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: process.env["CI"] ? 1 : 0,
  // CI keeps an HTML report, uploaded with the traces when the job fails.
  reporter: process.env["CI"] ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://localhost:3000", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command:
        "bun x --bun prisma migrate deploy && bun run --cwd apps/api --parallel start start:worker",
      // Up once the worker has connected, so a run started by the test is picked up at once.
      url: "http://localhost:4000/api/health/worker",
      env,
      // Never reuse a running API: a dev worker would be on live providers.
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // A production build in CI, so page compiles don't count against the test timeout.
      command: process.env["CI"]
        ? "bun run --cwd apps/web build && bun run --cwd apps/web start"
        : "bun run --cwd apps/web dev",
      url: "http://localhost:3000",
      reuseExistingServer: !process.env["CI"],
      timeout: 180_000,
    },
  ],
});
