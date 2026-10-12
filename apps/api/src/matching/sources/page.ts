import { createHash } from "node:crypto";
import { Effect } from "effect";
import { ScrapeFailed } from "../errors";
import { Firecrawl, type Listing, type ListingPage } from "../firecrawl";
import { ListingExtractor } from "../listing-extractor";
import type { ListingSource, SourceAdapter } from "./adapter";
import { detectEmbeddedBoard } from "./embedded";
import {
  findJobLinks,
  isJobLink,
  isUsableTitle,
  markdownLinks,
  nextPageUrl,
  normaliseUrl,
  slugTitle,
} from "./page-links";

// About 15k tokens, enough for a long careers page.
export const maxExtractionChars = 60_000;
// The JobSource.maxPages default.
const defaultMaxPages = 3;
const mapLimit = 200;

export interface SourcePage extends ListingPage {
  readonly url: string;
}

const hostName = (url: string) => new URL(url).hostname.replace(/^www\./, "");

const listing = (fields: Pick<Listing, "title" | "url" | "company">): Listing => ({
  ...fields,
  locations: [],
  experienceMinYears: null,
  experienceMaxYears: null,
  remote: null,
  postedAt: null,
});

// The model reads the pages only when their links show no titled jobs. It keeps only URLs
// that are on the pages, so a made-up or mangled link is dropped.
const extractWithModel = (sourceUrl: string, pages: readonly SourcePage[], company: string) =>
  Effect.gen(function* () {
    let markdown = pages.map((page) => page.markdown).join("\n\n");
    if (!markdown.trim()) return [];
    if (markdown.length > maxExtractionChars) {
      yield* Effect.logInfo(
        `Listing extraction reads the first ${maxExtractionChars} of ${markdown.length} characters of ${sourceUrl}.`,
      );
      markdown = markdown.slice(0, maxExtractionChars);
    }
    const extractor = yield* ListingExtractor;
    const found = yield* extractor.extract({ url: sourceUrl, markdown }).pipe(
      Effect.mapError(
        (error) =>
          new ScrapeFailed({
            status: null,
            message: `Could not read the listings on ${sourceUrl}: ${error.message}`,
          }),
      ),
    );
    const onPages = new Set(
      pages.flatMap((page) =>
        [...page.links, ...markdownLinks(page.markdown).map(({ url }) => url)].map((url) =>
          normaliseUrl(url, page.url),
        ),
      ),
    );
    return found.flatMap((job) => {
      const url = normaliseUrl(job.url, sourceUrl);
      return url && onPages.has(url)
        ? [{ ...job, url, company: job.company.trim() || company }]
        : [];
    });
  });

// Whitespace changes alone do not count as a changed page.
export const listingHashOf = (markdown: string) =>
  createHash("sha256").update(markdown.trim().replace(/\s+/g, " ")).digest("hex");

export const pageListings = (sourceUrl: string, pages: readonly SourcePage[]) => {
  const company = pages[0]?.siteName ?? hostName(sourceUrl);
  const titled = new Map<string, Listing>();
  for (const page of pages) {
    for (const { url, title } of findJobLinks(page.markdown, page.url)) {
      if (title && !titled.has(url)) titled.set(url, listing({ title, url, company }));
    }
  }
  return titled.size > 0
    ? Effect.succeed([...titled.values()])
    : extractWithModel(sourceUrl, pages, company);
};

// Follows the source's "next page" links up to its page limit, stopping at a repeated page.
const scrapePages = (source: ListingSource) =>
  Effect.gen(function* () {
    const firecrawl = yield* Firecrawl;
    const selector = source.selector ?? null;
    const first = yield* firecrawl.scrapeListingPage(source.url, {
      selector,
      withHtml: source.lastCheckedAt === null,
    });
    const pages: SourcePage[] = [{ ...first, url: source.url }];
    const seen = new Set([listingHashOf(first.markdown)]);
    let last = pages[0];
    while (last && pages.length < (source.maxPages ?? defaultMaxPages)) {
      const next = nextPageUrl(last.markdown, last.url, source.url);
      if (!next || pages.some((page) => normaliseUrl(page.url, page.url) === next)) break;
      const page = yield* firecrawl.scrapeListingPage(next, { selector });
      const hash = listingHashOf(page.markdown);
      if (seen.has(hash)) break;
      seen.add(hash);
      last = { ...page, url: next };
      pages.push(last);
    }
    return pages;
  });

// Job links from Firecrawl's map of the site, titled by their slugs.
const mapListings = (source: ListingSource) =>
  Effect.gen(function* () {
    const firecrawl = yield* Firecrawl;
    const links = yield* firecrawl.map(source.url, { search: "job", limit: mapLimit });
    const company = hostName(source.url);
    const byUrl = new Map<string, Listing>();
    for (const link of links) {
      const url = normaliseUrl(link.url, source.url);
      if (!url || byUrl.has(url) || !isJobLink(link.url, source.url)) continue;
      const title = slugTitle(url);
      if (isUsableTitle(title)) byUrl.set(url, listing({ title, url, company }));
    }
    return [...byUrl.values()];
  });

// Any other careers page: job links are read from its markdown, across its next pages, and
// the model reads the pages when they cannot be. A source can opt in to Firecrawl's map of
// the site instead, falling back to its pages when the map has no job links. The first
// check also fetches the page's HTML (no extra credits) to spot an embedded ATS board.
export const pageAdapter: SourceAdapter = {
  fetchListings: (source, previous) =>
    Effect.gen(function* () {
      if (source.useMap) {
        const mapped = yield* mapListings(source);
        if (mapped.length > 0) return { listings: mapped };
        yield* Effect.logInfo(`Firecrawl's map has no job links for ${source.url}.`);
      }
      const pages = yield* scrapePages(source);
      // Unchanged pages keep their last listings, without reading their links or the model.
      const listingHash = listingHashOf(pages.map(({ markdown }) => markdown).join("\n"));
      const listings =
        previous && source.listingHash === listingHash
          ? previous
          : yield* pageListings(source.url, pages);
      const [first] = pages;
      if (source.lastCheckedAt !== null || !first) return { listings, listingHash };
      return {
        listings,
        listingHash,
        embedded: detectEmbeddedBoard(first.rawHtml ?? "", first.links),
      };
    }),
};
