import type { FirecrawlRequestFailed, PageKind, ScrapedPage } from "./firecrawl";

// ok: use the page. blocked: the site kept the scraper out, so another instance may get in.
// gone: the page no longer exists. failed: any other error, which retrying will not fix.
export type ScrapeOutcome = "ok" | "blocked" | "gone" | "failed";

export type ScrapeResult =
  | { readonly page: ScrapedPage }
  | { readonly error: FirecrawlRequestFailed };

const blockedStatuses: ReadonlySet<number> = new Set([401, 403, 407, 429, 503]);
const goneStatuses: ReadonlySet<number> = new Set([404, 410]);

// Bot checks from Cloudflare, PerimeterX, DataDome, Imperva and others.
const challengeMarkers = [
  "just a moment",
  "attention required! | cloudflare",
  "cf-chl",
  "verify you are human",
  "captcha",
  "access denied",
  "px-captcha",
  "datadome",
  "incapsula",
];

// A job ad has more text than this; a shorter page is a script shell the scraper could not
// render, or a block page without a marker.
export const minJobPageChars = 400;
// Challenge pages are short, so only the start of the text is searched (a job ad that
// mentions a captcha further down is not a block), and only a small page's HTML.
const markerSearchChars = 2_000;
const challengeHtmlChars = 30_000;

const outcomeOfStatus = (status: number): ScrapeOutcome | null => {
  if (blockedStatuses.has(status)) return "blocked";
  if (goneStatuses.has(status)) return "gone";
  if (status >= 400) return "failed";
  return null;
};

const hasMarker = (text: string) => {
  const lower = text.toLowerCase();
  return challengeMarkers.some((marker) => lower.includes(marker));
};

const hasChallenge = ({ markdown, rawHtml, metadata }: ScrapedPage) =>
  hasMarker(metadata?.title ?? "") ||
  hasMarker((markdown ?? "").slice(0, markerSearchChars)) ||
  (rawHtml !== undefined && rawHtml.length < challengeHtmlChars && hasMarker(rawHtml));

// `kind` "map" judges only errors: a map has no page content.
export const classifyScrape = (result: ScrapeResult, kind: PageKind | "map"): ScrapeOutcome => {
  if ("error" in result) {
    const { status } = result.error;
    // No response, a timeout, or every engine failing (Firecrawl's 500) means the scraper
    // did not get past the site. Any other API status is a request the page cannot fix.
    if (status === null || status === 408 || status >= 500) return "blocked";
    return outcomeOfStatus(status) ?? "failed";
  }
  if (kind === "map") return "ok";
  const { page } = result;
  // Firecrawl returns the target page with the status the site answered.
  const status = page.metadata?.statusCode;
  const byStatus = status === undefined ? null : outcomeOfStatus(status);
  if (byStatus !== null) return byStatus;
  if (hasChallenge(page)) return "blocked";
  if (kind === "job" && (page.markdown?.trim().length ?? 0) < minJobPageChars) return "blocked";
  return "ok";
};
