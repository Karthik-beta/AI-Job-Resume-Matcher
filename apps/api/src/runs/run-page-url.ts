import { config } from "../config";

// A run's page in the web app, for links sent outside it. BETTER_AUTH_URL is the origin people
// open the app on (see deploy/README.md).
export const runPageUrl = (runId: string) =>
  new URL(`/runs/${encodeURIComponent(runId)}`, config.BETTER_AUTH_URL).href;
