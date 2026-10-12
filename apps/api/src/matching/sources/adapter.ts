import type { SourceKind } from "@job-matcher/shared";
import { Effect } from "effect";
import type { HttpFetch } from "../download";
import { type FirecrawlBlocked, ScrapeFailed } from "../errors";
import type { Firecrawl, Listing } from "../firecrawl";
import type { DetectedSource } from "./detect";
import type { HostLimiter } from "./http";

export interface ListingSource {
  readonly url: string;
  readonly kind: SourceKind;
  readonly adapterKey: string | null;
  // Null until the source is first checked.
  readonly lastCheckedAt?: Date | null;
}

export interface SourceListings {
  readonly listings: readonly Listing[];
  // An ATS board embedded in a page source, when its HTML was scanned; see embedded.ts.
  readonly embedded?: DetectedSource | null;
}

export type AdapterServices = Firecrawl | HttpFetch | HostLimiter;

export interface SourceAdapter {
  readonly fetchListings: (
    source: ListingSource,
  ) => Effect.Effect<SourceListings, ScrapeFailed | FirecrawlBlocked, AdapterServices>;
  // Reads the job ad for a listing that came without one, instead of scraping its page.
  readonly fetchDescription?: (
    listing: Listing,
  ) => Effect.Effect<string, ScrapeFailed, AdapterServices>;
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
