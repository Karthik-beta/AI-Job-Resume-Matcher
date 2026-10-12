import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import type { ScrapeBackend, ScrapedPage } from "./firecrawl";
import { makeScrapeRouter } from "./scrape-router";
import { memoryScrapeRouteStore, noteLocalBlock, prefersCloud } from "./scrape-routes";

const domain = "careers.acme.com";
const url = `https://${domain}/jobs/1`;
const jobPage: ScrapedPage = {
  markdown: `# Engineer\n\n${"Build payment APIs in TypeScript. ".repeat(20)}`,
  metadata: { statusCode: 200 },
};
const challenge: ScrapedPage = { markdown: "Just a moment...", metadata: { statusCode: 403 } };

const runTest = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.provide(TestClock.layer()), Effect.runPromise);

describe("route policy", () => {
  test("prefers the cloud for a week after two local blocks in a row", () =>
    runTest(
      Effect.gen(function* () {
        const { store, routes } = memoryScrapeRouteStore();
        yield* noteLocalBlock(store, domain);
        expect(yield* prefersCloud(store, domain)).toBe(false);
        yield* noteLocalBlock(store, domain);
        expect(yield* prefersCloud(store, domain)).toBe(true);
        expect(routes.get(domain)).toEqual({
          localBlocks: 2,
          preferCloudUntil: new Date(7 * 24 * 60 * 60 * 1000),
        });
        yield* TestClock.adjust("7 days");
        expect(yield* prefersCloud(store, domain)).toBe(false);
      }),
    ));

  test("a local success resets the count", () =>
    runTest(
      Effect.gen(function* () {
        const { store, routes } = memoryScrapeRouteStore();
        yield* store.localWorked(domain);
        expect(routes.has(domain)).toBe(false);
        yield* noteLocalBlock(store, domain);
        yield* store.localWorked(domain);
        yield* noteLocalBlock(store, domain);
        expect(yield* prefersCloud(store, domain)).toBe(false);
        expect(routes.get(domain)?.localBlocks).toBe(1);
      }),
    ));
});

describe("hybrid routing by domain", () => {
  test("skips the local instance for a site that keeps blocking it, then tries it again", () =>
    runTest(
      Effect.gen(function* () {
        let localReply = challenge;
        const calls: string[] = [];
        const backend = (via: "local" | "cloud"): ScrapeBackend => ({
          via,
          scrape: () =>
            Effect.sync(() => {
              calls.push(via);
              return via === "local" ? localReply : jobPage;
            }),
          map: () => Effect.succeed({ links: [] }),
          creditUsage: Effect.die("unused"),
        });
        const { store, routes } = memoryScrapeRouteStore();
        const firecrawl = makeScrapeRouter({
          mode: "hybrid",
          local: backend("local"),
          cloud: backend("cloud"),
          routes: store,
        });
        const scrape = Effect.gen(function* () {
          calls.length = 0;
          const page = yield* firecrawl.scrapeJob(url);
          return { via: page.usage.via, calls: [...calls] };
        });

        expect(yield* scrape).toEqual({ via: "cloud", calls: ["local", "cloud"] });
        expect(yield* scrape).toEqual({ via: "cloud", calls: ["local", "cloud"] });
        expect(yield* scrape).toEqual({ via: "cloud", calls: ["cloud"] });
        // A week later local is tried again; it works now, so the site is local again.
        yield* TestClock.adjust("7 days");
        localReply = jobPage;
        expect(yield* scrape).toEqual({ via: "local", calls: ["local"] });
        expect(routes.get(domain)).toEqual({ localBlocks: 0, preferCloudUntil: null });
      }),
    ));
});
