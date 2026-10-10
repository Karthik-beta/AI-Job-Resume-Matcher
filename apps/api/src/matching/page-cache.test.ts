import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { ScrapeFailed } from "./errors";
import { Firecrawl, type Listing } from "./firecrawl";
import {
  type CachedPage,
  PageCacheStore,
  type PageKey,
  scrapeJobPage,
  scrapeResume,
  scrapeSourceListings,
} from "./page-cache";

const listing: Listing = {
  title: "Engineer",
  url: "https://example.com/job/1",
  company: "Example",
  locations: ["Bengaluru"],
  experienceMinYears: 3,
  experienceMaxYears: null,
};

const memoryStore = () => {
  const rows = new Map<string, CachedPage>();
  const id = ({ userId, url, kind }: PageKey) => `${userId} ${kind} ${url}`;
  const store = PageCacheStore.of({
    get: (key) => Effect.sync(() => rows.get(id(key)) ?? null),
    set: (key, content, expiresAt) =>
      Effect.sync(() => {
        rows.set(id(key), { content: JSON.parse(JSON.stringify(content)), expiresAt });
      }),
  });
  return { rows, store, id };
};

const fakeFirecrawl = (fail = false) => {
  const scraped: string[] = [];
  const firecrawl = Firecrawl.of({
    scrapeMarkdown: (url) =>
      Effect.suspend(() => {
        scraped.push(url);
        return fail
          ? Effect.fail(new ScrapeFailed({ status: 500, message: "Server error" }))
          : Effect.succeed(`Markdown ${scraped.length}`);
      }),
    scrapeListings: (url) =>
      Effect.sync(() => {
        scraped.push(url);
        return [listing];
      }),
  });
  return { scraped, firecrawl };
};

const setup = (options: { fail?: boolean } = {}) => {
  const memory = memoryStore();
  const fake = fakeFirecrawl(options.fail);
  const layer = Layer.mergeAll(
    Layer.succeed(PageCacheStore, memory.store),
    Layer.succeed(Firecrawl, fake.firecrawl),
    TestClock.layer(),
  );
  const run = <A, E>(program: Effect.Effect<A, E, PageCacheStore | Firecrawl>) =>
    program.pipe(Effect.provide(layer), Effect.runPromise);
  return { ...memory, ...fake, run };
};

describe("page cache", () => {
  test("reuses a scraped resume and job page until cleared", async () => {
    const { run, scraped } = setup();
    const program = Effect.gen(function* () {
      const first = yield* scrapeResume("alice", "https://example.com/resume.pdf");
      yield* TestClock.adjust("30 days");
      const second = yield* scrapeResume("alice", "https://example.com/resume.pdf");
      const job = yield* scrapeJobPage("alice", "https://example.com/job/1");
      const jobAgain = yield* scrapeJobPage("alice", "https://example.com/job/1");
      return [first, second, job, jobAgain];
    });
    expect(await run(program)).toEqual(["Markdown 1", "Markdown 1", "Markdown 2", "Markdown 2"]);
    expect(scraped).toEqual(["https://example.com/resume.pdf", "https://example.com/job/1"]);
  });

  test("keeps resume and job page entries apart for the same URL", async () => {
    const { run, scraped } = setup();
    const url = "https://example.com/page";
    await run(Effect.all([scrapeResume("alice", url), scrapeJobPage("alice", url)]));
    expect(scraped).toEqual([url, url]);
  });

  test("caches source listings for 15 minutes", async () => {
    const { run, scraped } = setup();
    const url = "https://example.com/jobs";
    const program = Effect.gen(function* () {
      const first = yield* scrapeSourceListings("alice", url);
      yield* TestClock.adjust("14 minutes");
      yield* scrapeSourceListings("alice", url);
      yield* TestClock.adjust("1 minute");
      yield* scrapeSourceListings("alice", url);
      return first;
    });
    expect(await run(program)).toEqual([listing]);
    expect(scraped).toEqual([url, url]);
  });

  test("stores the listings expiry 15 minutes after the scrape", async () => {
    const { run, rows, id } = setup();
    const url = "https://example.com/jobs";
    await run(scrapeSourceListings("alice", url));
    const row = rows.get(id({ userId: "alice", url, kind: "SOURCE_LISTING" }));
    expect(row?.expiresAt?.getTime()).toBe(15 * 60 * 1000);
  });

  test("keeps each user's cache separate", async () => {
    const { run, scraped } = setup();
    const url = "https://example.com/job/1";
    await run(Effect.all([scrapeJobPage("alice", url), scrapeJobPage("bob", url)]));
    expect(scraped).toEqual([url, url]);
  });

  test("does not cache a failed scrape", async () => {
    const { run, rows } = setup({ fail: true });
    const error = await run(Effect.flip(scrapeJobPage("alice", "https://example.com/job/1")));
    expect(error._tag).toBe("ScrapeFailed");
    expect(rows.size).toBe(0);
  });

  test("scrapes again when a cached row cannot be read", async () => {
    const { run, rows, id, scraped } = setup();
    const url = "https://example.com/jobs";
    rows.set(id({ userId: "alice", url, kind: "SOURCE_LISTING" }), {
      content: [{ title: "Old shape" }],
      expiresAt: null,
    });
    expect(await run(scrapeSourceListings("alice", url))).toEqual([listing]);
    expect(scraped).toEqual([url]);
  });
});
