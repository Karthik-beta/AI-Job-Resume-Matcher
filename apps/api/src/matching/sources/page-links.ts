import { isAtsHost } from "./detect";

export interface JobLink {
  readonly url: string;
  // The link's anchor text, when it reads as a job title.
  readonly title: string | null;
}

// [text](url "title"), where the text may hold an image or one level of brackets.
const markdownLinkPattern =
  /\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;

export const markdownLinks = (markdown: string) =>
  [...markdown.matchAll(markdownLinkPattern)].map(([, text = "", url = ""]) => ({ text, url }));

// Absolute, without the fragment or a trailing slash, so the same link compares equal.
export const normaliseUrl = (raw: string, base: string) => {
  if (!URL.canParse(raw, base)) return null;
  const url = new URL(raw, base);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
};

const secondLevelLabels: ReadonlySet<string> = new Set(["co", "com", "org", "net", "ac", "gov"]);

// The registrable domain, close enough for careers sites: acme.com, acme.co.uk.
const siteOf = (hostname: string) => {
  const labels = hostname.toLowerCase().split(".");
  const country = (labels.at(-1)?.length ?? 0) === 2;
  const size = labels.length > 2 && country && secondLevelLabels.has(labels.at(-2) ?? "") ? 3 : 2;
  return labels.slice(-size).join(".");
};

const jobPath = /\/(?:jobs?|positions?|openings?|vacancy|vacancies)\/[^/]+|\/careers\/[^/]+\//i;
const idSegment = /^(?:\d{4,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const pagingPath = /\/page\/\d+\/?$/i;
const filterPath =
  /\/(?:categor(?:y|ies)|departments?|locations?|teams?|offices?|search|filters?)(?:\/|$)/i;
const filterParams = [
  "page",
  "p",
  "offset",
  "department",
  "location",
  "category",
  "team",
  "office",
  "q",
  "query",
  "search",
];

const looksLikeJob = (url: URL) => {
  const last = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
  return jobPath.test(url.pathname) || idSegment.test(last);
};

const isListingNavigation = (url: URL) =>
  pagingPath.test(url.pathname) ||
  filterPath.test(url.pathname) ||
  filterParams.some((param) => url.searchParams.has(param));

// A job ad on the careers site itself or on an ATS it links to; not a page of the listing,
// a filter, or the listing page itself.
export const isJobLink = (link: string, pageUrl: string) => {
  const url = normaliseUrl(link, pageUrl);
  if (!url || url === normaliseUrl(pageUrl, pageUrl)) return false;
  const raw = new URL(link, pageUrl);
  const page = new URL(pageUrl);
  const sameSite = siteOf(raw.hostname) === siteOf(page.hostname) || isAtsHost(raw.hostname);
  return sameSite && looksLikeJob(raw) && !isListingNavigation(raw);
};

const genericTitles: ReadonlySet<string> = new Set([
  "apply",
  "apply now",
  "apply here",
  "learn more",
  "read more",
  "more",
  "more info",
  "details",
  "view",
  "view job",
  "view jobs",
  "view role",
  "view details",
  "view all",
  "view all jobs",
  "view openings",
  "see all",
  "see all jobs",
  "see more",
  "see jobs",
  "show more",
  "all jobs",
  "job details",
  "open positions",
  "see open positions",
  "click here",
  "here",
  "careers",
  "jobs",
]);

export const isUsableTitle = (title: string) =>
  title.length >= 3 &&
  title.length <= 120 &&
  /\p{L}/u.test(title) &&
  !genericTitles.has(
    title
      .toLowerCase()
      .replace(/[^\p{L}\s]/gu, "")
      .replace(/\s+/g, " ")
      .trim(),
  );

// The first line of the anchor text, without images or markdown emphasis.
export const anchorTitle = (text: string) => {
  const lines = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, "$1")
    .replace(/[*_`#]+/g, " ")
    .split(/\\?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim());
  return lines.find((line) => /\p{L}/u.test(line)) ?? "";
};

// Job links in the page markdown, once each; a link repeated as "Apply" keeps its title.
export const findJobLinks = (markdown: string, pageUrl: string): JobLink[] => {
  const byUrl = new Map<string, JobLink>();
  for (const { text, url: raw } of markdownLinks(markdown)) {
    if (!isJobLink(raw, pageUrl)) continue;
    const url = normaliseUrl(raw, pageUrl);
    if (!url) continue;
    const title = anchorTitle(text);
    const usable = isUsableTitle(title) ? title : null;
    if (!byUrl.get(url)?.title) byUrl.set(url, { url, title: usable });
  }
  return [...byUrl.values()];
};
