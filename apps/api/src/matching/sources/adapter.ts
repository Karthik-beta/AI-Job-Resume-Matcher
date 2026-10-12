import type { SourceKind } from "@job-matcher/shared";
import type { Effect } from "effect";
import type { FirecrawlBlocked, ScrapeFailed } from "../errors";
import type { Firecrawl, Listing } from "../firecrawl";

export interface ListingSource {
  readonly url: string;
  readonly kind: SourceKind;
  readonly adapterKey: string | null;
}

export type AdapterServices = Firecrawl;

export interface SourceAdapter {
  readonly fetchListings: (
    source: ListingSource,
  ) => Effect.Effect<readonly Listing[], ScrapeFailed | FirecrawlBlocked, AdapterServices>;
}
