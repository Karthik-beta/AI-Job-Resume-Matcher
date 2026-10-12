import { Effect } from "effect";
import { Firecrawl } from "../firecrawl";
import type { SourceAdapter } from "./adapter";

// Any other careers page: Firecrawl extracts the listings with an LLM prompt.
export const pageAdapter: SourceAdapter = {
  fetchListings: (source) =>
    Effect.gen(function* () {
      const firecrawl = yield* Firecrawl;
      return yield* firecrawl.scrapeListings(source.url);
    }),
};
