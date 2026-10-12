import type { FirecrawlRequestFailed, PageKind, ScrapedPage } from "./firecrawl";

// ok: use the page. blocked: the page itself shows the site kept the scraper out, so another
// instance may get in. unreachable: the scraping instance gave no answer about the page (no
// response, a timeout, or its own 5xx); another instance may get in, but the site is not to
// blame. gone: the page no longer exists. failed: any other error, which retrying will not fix.
export type ScrapeOutcome = "ok" | "blocked" | "unreachable" | "gone" | "failed";

export type ScrapeResult =
  | { readonly page: ScrapedPage }
  | { readonly error: FirecrawlRequestFailed };

const blockedStatuses: ReadonlySet<number> = new Set([401, 403, 407, 429, 503]);
const goneStatuses: ReadonlySet<number> = new Set([404, 410]);

// Bot checks from Cloudflare, PerimeterX, Akamai and others: phrases that appear only on
// challenge pages.
const challengeMarkers = [
  "just a moment",
  "attention required! | cloudflare",
  "cf-chl",
  "verify you are human",
  "access denied",
  "px-captcha",
];

// Names a normal page also carries, in a reCAPTCHA on its form or a DataDome or Imperva
// script, so they count only on a page that otherwise looks like a challenge.
const vendorMarkers = ["captcha", "recaptcha", "hcaptcha", "datadome", "incapsula"];
const challengeTitle =
  /just a moment|attention required|access denied|captcha|are you a robot|are you human|verify you|human verification|security check|pardon our interruption|one more step|request blocked|forbidden/i;
// A challenge page is short; a job ad with its details is longer than this.
const challengePageChars = 1_500;

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

const hasMarker = ({ markdown, rawHtml, metadata }: ScrapedPage, markers: readonly string[]) => {
  const found = (text: string) => {
    const lower = text.toLowerCase();
    return markers.some((marker) => lower.includes(marker));
  };
  return (
    found(metadata?.title ?? "") ||
    found((markdown ?? "").slice(0, markerSearchChars)) ||
    (rawHtml !== undefined && rawHtml.length < challengeHtmlChars && found(rawHtml))
  );
};

const looksLikeChallenge = ({ markdown, metadata }: ScrapedPage) =>
  challengeTitle.test(metadata?.title ?? "") || (markdown ?? "").trim().length < challengePageChars;

const hasChallenge = (page: ScrapedPage) =>
  hasMarker(page, challengeMarkers) || (looksLikeChallenge(page) && hasMarker(page, vendorMarkers));

// `kind` "map" judges only errors: a map has no page content.
export const classifyScrape = (result: ScrapeResult, kind: PageKind | "map"): ScrapeOutcome => {
  if ("error" in result) {
    const { status } = result.error;
    // No response, a timeout, or every engine failing (Firecrawl's 500) says nothing about
    // the site: the instance may be down. Any other API status is a request the page cannot fix.
    if (status === null || status === 408 || status >= 500) return "unreachable";
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
