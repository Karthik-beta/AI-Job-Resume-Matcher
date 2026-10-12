import type { SourceKind } from "@job-matcher/shared";
import { Effect } from "effect";
import type { HttpFetch } from "../download";
import { type FirecrawlBlocked, ScrapeFailed } from "../errors";
import type { Firecrawl, Listing } from "../firecrawl";
import type { ListingExtractor } from "../listing-extractor";
import type { DetectedSource } from "./detect";
import type { HostLimiter } from "./http";

export interface ListingSource {
  readonly url: string;
  readonly kind: SourceKind;
  readonly adapterKey: string | null;
  // Null until the source is first checked.
  readonly lastCheckedAt?: Date | null;
  // A CSS selector for the part of a page source that lists the jobs.
  readonly selector?: string | null;
  // Pages of a page source's listings to read, counting the first.
  readonly maxPages?: number;
  // Read a page source's job links from Firecrawl's map of the site.
  readonly useMap?: boolean;
  // The hash of the page source's markdown when its listings were last read.
  readonly listingHash?: string | null;
  // A search source's query.
  readonly query?: string | null;
}

export interface SourceListings {
  readonly listings: readonly Listing[];
  // An ATS board embedded in a page source, when its HTML was scanned; see embedded.ts.
  readonly embedded?: DetectedSource | null;
  // Saved on a page source as its listingHash; see page.ts.
  readonly listingHash?: string;
}

export type AdapterServices = Firecrawl | HttpFetch | HostLimiter | ListingExtractor;

export interface SourceAdapter {
  // `previous` holds the source's last listings, when the cache still has them.
  readonly fetchListings: (
    source: ListingSource,
    previous?: readonly Listing[] | null,
  ) => Effect.Effect<SourceListings, ScrapeFailed | FirecrawlBlocked, AdapterServices>;
  // Reads the job ad for a listing that came without one, instead of scraping its page.
  readonly fetchDescription?: (
    listing: Listing,
  ) => Effect.Effect<string, ScrapeFailed, AdapterServices>;
  // Whether fetchDescription can read the ad at this URL (all URLs when missing); other
  // listings are scraped.
  readonly describes?: (url: string) => boolean;
}

export const boardKey = (source: ListingSource, label: string) =>
  source.adapterKey
    ? Effect.succeed(source.adapterKey)
    : Effect.fail(
        new ScrapeFailed({
          status: null,
          message: `Set the ${label} board name for ${source.url}.`,
        }),
      );

// The host of the source URL picks the EU data centre for ATSs that run one.
export const isEuSource = (source: ListingSource) =>
  URL.canParse(source.url) && new URL(source.url).hostname.toLowerCase().includes(".eu.");

// The text handed to the evaluator for a listing that came with its job ad.
export const listingPage = (listing: Listing & { readonly description: string }) =>
  [
    `# ${listing.title}`,
    [listing.company, ...listing.locations].filter(Boolean).join(" · "),
    listing.remote === true ? "Remote" : "",
    listing.description,
  ]
    .filter(Boolean)
    .join("\n\n");
