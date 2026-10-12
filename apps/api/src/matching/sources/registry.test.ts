import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Firecrawl } from "../firecrawl";
import { adapterFor } from "./registry";

const unusedFirecrawl = Firecrawl.of({
  scrapeMarkdown: () => Effect.die("unused"),
  scrapeListings: () => Effect.die("unused"),
});

test("fails a search source until search is supported", async () => {
  const source = { url: "https://example.com", kind: "SEARCH", adapterKey: null } as const;
  const error = await Effect.runPromise(
    adapterFor("SEARCH")
      .fetchListings(source)
      .pipe(Effect.flip, Effect.provideService(Firecrawl, unusedFirecrawl)),
  );
  expect(error.message).toBe("Search sources are not supported yet.");
});
