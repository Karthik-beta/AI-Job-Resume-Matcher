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

const pageParams = ["page", "p", "offset"];
const pagedPath = /\/page\/(\d+)$/i;
// "Next", "Next page", "Next ›", "›", "»" and the like.
const nextLabel = /^(?:next(?:\s+page)?)?\s*[›»>→]*$/i;

// The position of a page of listings: its page, p or offset parameter, or its /page/N suffix.
const pageNumber = (url: URL) => {
  const param = pageParams.map((name) => url.searchParams.get(name)).find((value) => value);
  return Number(param ?? pagedPath.exec(url.pathname)?.[1] ?? 0) || 0;
};

const listPath = (url: URL) => url.pathname.replace(pagedPath, "").replace(/\/+$/, "");

// The link to the next page of the source's listings: one labelled "Next" on the same host,
// or else the nearest later page of the source's own path.
export const nextPageUrl = (markdown: string, pageUrl: string, sourceUrl: string) => {
  const page = new URL(pageUrl);
  const source = new URL(sourceUrl);
  const candidates = markdownLinks(markdown).flatMap(({ text, url: raw }) => {
    const href = normaliseUrl(raw, pageUrl);
    if (!href || href === normaliseUrl(pageUrl, pageUrl)) return [];
    const url = new URL(href);
    if (url.host !== source.host) return [];
    const label = text
      .replace(/[*_`\\]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const isNext = label !== "" && nextLabel.test(label);
    const isPage =
      listPath(url) === listPath(source) &&
      (pageParams.some((name) => url.searchParams.has(name)) || pagedPath.test(url.pathname));
    return isNext || isPage ? [{ href, isNext, number: pageNumber(url) }] : [];
  });
  const later = candidates
    .filter(({ number }) => number > pageNumber(page))
    .sort((a, b) => a.number - b.number);
  return (candidates.find(({ isNext }) => isNext) ?? later[0])?.href ?? null;
};

const decodeSegment = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

const uuidSuffix = /[-_]?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A title from the URL's slug: /jobs/senior-backend-engineer-123 reads "Senior Backend Engineer".
export const slugTitle = (link: string) => {
  const segments = new URL(link).pathname.split("/").filter(Boolean).map(decodeSegment);
  const slug = segments.reverse().find((segment) => !idSegment.test(segment)) ?? "";
  return slug
    .replace(/\.[a-z]+$/i, "")
    .replace(uuidSuffix, "")
    .split(/[-_+\s]+/)
    .filter((word) => word && !/^\d{4,}$/.test(word))
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};
