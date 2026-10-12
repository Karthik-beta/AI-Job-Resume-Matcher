import type { SourceKind } from "@job-matcher/shared";
import { Effect } from "effect";
import { ScrapeFailed } from "../errors";
import { Firecrawl, type Listing, type SearchOptions, type SearchResult } from "../firecrawl";
import type { SourceAdapter } from "./adapter";
import { detectSource } from "./detect";
import { slugTitle } from "./page-links";

// The /search request a search source sends. Checked 2026-10-12 against
// https://docs.firecrawl.dev/api-reference/endpoint/search: the domain filter is
// `includeDomains` (bare domains; it cannot be combined with excludeDomains), `tbs` takes
// Google's "qdr:w" for the past week, and without `scrapeOptions` the results are not
// scraped, so a search of 10 results costs 2 credits. A self-hosted instance searches
// through SearXNG and only adds `site:` operators for the domains.
export const searchOptions: SearchOptions = {
  includeDomains: [
    "job-boards.greenhouse.io",
    "job-boards.eu.greenhouse.io",
    "boards.greenhouse.io",
    "jobs.lever.co",
    "jobs.eu.lever.co",
    "jobs.ashbyhq.com",
    "jobs.smartrecruiters.com",
    "recruitee.com",
  ],
  tbs: "qdr:w",
  limit: 10,
};

// The synthetic URL a search source is stored under, so (userId, url) stays unique per query.
export const searchSourceUrl = (query: string) => `search:${query.toLowerCase()}`;

// How a search result's job ad is read: by its ATS's adapter, or as a scraped page.
export const listingKind = (sourceKind: SourceKind, url: string): SourceKind =>
  sourceKind === "SEARCH" ? detectSource(url).kind : sourceKind;

const hostName = (url: string) => new URL(url).hostname.replace(/^www\./, "");

// An ATS result needs a path below the board (a job, not the board itself).
const isJobResult = (url: string) =>
  URL.canParse(url) &&
  (detectSource(url).kind === "PAGE" ||
    new URL(url).pathname.split("/").filter(Boolean).length >= 2);

// Greenhouse titles its job pages "Job Application for {title} at {company}".
const cleanTitle = (title: string) =>
  title.trim().replace(/^Job Application for (.+) at .+$/i, "$1");

export const searchListings = (results: readonly SearchResult[]): Listing[] => {
  const byUrl = new Map<string, Listing>();
  for (const { url, title } of results) {
    if (byUrl.has(url) || !isJobResult(url)) continue;
    const { adapterKey } = detectSource(url);
    byUrl.set(url, {
      title: (title && cleanTitle(title)) || slugTitle(url),
      url,
      company: adapterKey ?? hostName(url),
      locations: [],
      experienceMinYears: null,
      experienceMaxYears: null,
      remote: null,
      postedAt: null,
    });
  }
  return [...byUrl.values()];
};

// A web search for the source's query, limited to the ATS hosts and the past week.
export const searchAdapter: SourceAdapter = {
  fetchListings: (source) =>
    Effect.gen(function* () {
      const query = source.query?.trim();
      if (!query) {
        return yield* new ScrapeFailed({ status: null, message: "The search has no query." });
      }
      const firecrawl = yield* Firecrawl;
      const { results } = yield* firecrawl.search(query, searchOptions);
      return { listings: searchListings(results) };
    }),
};
