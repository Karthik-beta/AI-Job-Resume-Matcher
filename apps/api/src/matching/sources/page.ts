import { Effect } from "effect";
import { ScrapeFailed } from "../errors";
import { Firecrawl, type Listing, type ListingPage } from "../firecrawl";
import { ListingExtractor } from "../listing-extractor";
import type { SourceAdapter } from "./adapter";
import { detectEmbeddedBoard } from "./embedded";
import { findJobLinks, markdownLinks, normaliseUrl } from "./page-links";

// About 15k tokens, enough for a long careers page.
export const maxExtractionChars = 60_000;

const companyOf = (pageUrl: string, page: ListingPage) =>
  page.siteName ?? new URL(pageUrl).hostname.replace(/^www\./, "");

const listing = (fields: Pick<Listing, "title" | "url" | "company">): Listing => ({
  ...fields,
  locations: [],
  experienceMinYears: null,
  experienceMaxYears: null,
  remote: null,
  postedAt: null,
});

// The model reads the page only when its links show no titled jobs. It keeps only URLs that
// are on the page, so a made-up or mangled link is dropped.
const extractWithModel = (pageUrl: string, page: ListingPage) =>
  Effect.gen(function* () {
    if (!page.markdown.trim()) return [];
    let markdown = page.markdown;
    if (markdown.length > maxExtractionChars) {
      yield* Effect.logInfo(
        `Listing extraction reads the first ${maxExtractionChars} of ${markdown.length} characters of ${pageUrl}.`,
      );
      markdown = markdown.slice(0, maxExtractionChars);
    }
    const extractor = yield* ListingExtractor;
    const found = yield* extractor.extract({ url: pageUrl, markdown }).pipe(
      Effect.mapError(
        (error) =>
          new ScrapeFailed({
            status: null,
            message: `Could not read the listings on ${pageUrl}: ${error.message}`,
          }),
      ),
    );
    const onPage = new Set(
      [...page.links, ...markdownLinks(page.markdown).map(({ url }) => url)].map((url) =>
        normaliseUrl(url, pageUrl),
      ),
    );
    const company = companyOf(pageUrl, page);
    return found.flatMap((job) => {
      const url = normaliseUrl(job.url, pageUrl);
      return url && onPage.has(url)
        ? [{ ...job, url, company: job.company.trim() || company }]
        : [];
    });
  });

export const pageListings = (pageUrl: string, page: ListingPage) => {
  const company = companyOf(pageUrl, page);
  const titled = findJobLinks(page.markdown, pageUrl).flatMap(({ url, title }) =>
    title ? [listing({ title, url, company })] : [],
  );
  return titled.length > 0 ? Effect.succeed(titled) : extractWithModel(pageUrl, page);
};

// Any other careers page: job links are read from its markdown, and the model reads the page
// when they cannot be. The first check also fetches the page's HTML (no extra credits) to
// spot an embedded ATS board.
export const pageAdapter: SourceAdapter = {
  fetchListings: (source) =>
    Effect.gen(function* () {
      const firecrawl = yield* Firecrawl;
      const withHtml = source.lastCheckedAt === null;
      const page = yield* firecrawl.scrapeListingPage(source.url, {
        selector: source.selector ?? null,
        withHtml,
      });
      const listings = yield* pageListings(source.url, page);
      if (!withHtml) return { listings };
      return { listings, embedded: detectEmbeddedBoard(page.rawHtml ?? "", page.links) };
    }),
};
