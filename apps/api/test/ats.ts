import { Effect, Layer } from "effect";
import { type Download, HttpFetch } from "../src/matching/download";
import { ScrapeFailed } from "../src/matching/errors";
import { Firecrawl } from "../src/matching/firecrawl";
import { ListingExtractor } from "../src/matching/listing-extractor";
import type { ListingSource, SourceAdapter } from "../src/matching/sources/adapter";
import { HostLimiter, makeHostLimiter } from "../src/matching/sources/http";

const fixtures = new URL("./fixtures/ats/", import.meta.url);

export const fixture = (name: string) => Bun.file(new URL(name, fixtures)).text();

export type Reply = string | { readonly status: number; readonly body?: string };

// Serves each URL's scripted reply; any other URL fails like an offline network.
export const fakeHttp = (replies: Record<string, Reply>) => {
  const requests: string[] = [];
  const http = HttpFetch.of({
    request: (url) =>
      Effect.suspend(() => {
        requests.push(url);
        const reply = replies[url];
        if (reply === undefined) {
          return Effect.fail(new ScrapeFailed({ status: null, message: `offline: ${url}` }));
        }
        const { status, body = "" } =
          typeof reply === "string" ? { status: 200, body: reply } : reply;
        const download: Download = {
          status,
          headers: new Headers(),
          body: new TextEncoder().encode(body),
        };
        return Effect.succeed(download);
      }),
  });
  return { http, requests };
};

const unusedFirecrawl = Firecrawl.of({
  scrapeMarkdown: () => Effect.die("Firecrawl is not used by ATS adapters"),
  scrapeListingPage: () => Effect.die("Firecrawl is not used by ATS adapters"),
});

const unusedExtractor = ListingExtractor.of({
  extract: () => Effect.die("The listing extractor is not used by ATS adapters"),
});

export const atsLayer = (http: HttpFetch["Service"]) =>
  Layer.mergeAll(
    Layer.succeed(HttpFetch, http),
    Layer.succeed(Firecrawl, unusedFirecrawl),
    Layer.succeed(ListingExtractor, unusedExtractor),
    Layer.effect(HostLimiter, makeHostLimiter(0)),
  );

export const fetchListings = async (
  adapter: SourceAdapter,
  source: ListingSource,
  replies: Record<string, Reply>,
) => {
  const { http, requests } = fakeHttp(replies);
  const result = await adapter.fetchListings(source).pipe(
    Effect.map(({ listings }) => listings),
    Effect.result,
    Effect.provide(atsLayer(http)),
    Effect.runPromise,
  );
  return { result, requests };
};
