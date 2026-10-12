import { Effect } from "effect";
import { Firecrawl } from "../firecrawl";
import type { SourceAdapter } from "./adapter";
import { detectEmbeddedBoard } from "./embedded";

// Any other careers page: Firecrawl extracts the listings with an LLM prompt. The first check
// also fetches the page's HTML and links (no extra credits) to spot an embedded ATS board.
export const pageAdapter: SourceAdapter = {
  fetchListings: (source) =>
    Effect.gen(function* () {
      const firecrawl = yield* Firecrawl;
      const withPage = source.lastCheckedAt === null;
      const page = yield* firecrawl.scrapeListings(source.url, { withPage });
      if (!withPage) return { listings: page.listings };
      return {
        listings: page.listings,
        embedded: detectEmbeddedBoard(page.rawHtml ?? "", page.links),
      };
    }),
};
