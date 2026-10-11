import { defineConfig, devices } from "@playwright/test";

// The API and worker run with fake providers, so the suite never calls Firecrawl,
// OpenRouter or Discord.
const env = { PROVIDERS: "fake" };

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
      command: "bun run --cwd apps/api --parallel start start:worker",
      url: "http://localhost:4000/api/health",
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
