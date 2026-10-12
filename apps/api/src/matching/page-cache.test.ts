import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { pageFixture } from "../../test/pages";
import { type Download, HttpFetch } from "./download";
import { ScrapeFailed } from "./errors";
import { Firecrawl, type Listing } from "./firecrawl";
import { parseJobPosting } from "./job-posting";
import { ListingExtractor } from "./listing-extractor";
import {
  type CachedPage,
  jobPageFor,
  PageCacheStore,
  type PageKey,
  scrapeJobPage,
  scrapeSourceListings,
} from "./page-cache";
import { liteParseText, makePdfParser, PdfParser } from "./pdf";
import { HostLimiter, makeHostLimiter } from "./sources/http";
import { listingHashOf } from "./sources/page";

const jobAd = new Uint8Array(
  await Bun.file(new URL("../../test/fixtures/job-ad.pdf", import.meta.url)).arrayBuffer(),
);
const pdfResponse: Download = {
  status: 200,
  headers: new Headers({ "content-type": "application/pdf" }),
  body: jobAd,
};
const htmlResponse: Download = {
  status: 200,
  headers: new Headers({ "content-type": "text/html" }),
  body: new TextEncoder().encode("<html>"),
};

type Respond = (url: string, method: "GET" | "HEAD") => Download | null;

const listing: Listing = {
  title: "Engineer",
  url: "https://example.com/job/1",
  company: "Example",
  locations: ["Bengaluru"],
  experienceMinYears: 3,
  experienceMaxYears: null,
  remote: null,
  postedAt: null,
};

// The listing a page source reads from its link.
const pageListing: Listing = { ...listing, locations: [], experienceMinYears: null };

// A job page without structured data.
const plain = (markdown: string) => ({ markdown, posting: null });

const pageSource = (url: string) => ({ url, kind: "PAGE", adapterKey: null }) as const;

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

const fakeFirecrawl = (
  fail = false,
  markdown?: string,
  listingMarkdown = "[Engineer](/job/1)",
  rawHtml: string | null = null,
) => {
  const scraped: string[] = [];
  const firecrawl = Firecrawl.of({
    scrapeMarkdown: () => Effect.die("unused"),
    scrapeJob: (url) =>
      Effect.suspend(() => {
        scraped.push(url);
        return fail
          ? Effect.fail(new ScrapeFailed({ status: 500, message: "Server error" }))
          : Effect.succeed({
              markdown: markdown ?? `Markdown ${scraped.length}`,
              rawHtml,
              usage: { via: "cloud", credits: 1 } as const,
            });
      }),
    scrapeListingPage: (url) =>
      Effect.sync(() => {
        scraped.push(url);
        return {
          markdown: listingMarkdown,
          links: [],
          rawHtml: null,
          siteName: "Example",
          usage: { via: "cloud", credits: 1 } as const,
        };
      }),
    map: () => Effect.die("unused"),
  });
  return { scraped, firecrawl };
};

const setup = (
  options: {
    fail?: boolean;
    markdown?: string;
    listingMarkdown?: string;
    rawHtml?: string;
    respond?: Respond;
  } = {},
) => {
  const memory = memoryStore();
  const fake = fakeFirecrawl(
    options.fail,
    options.markdown,
    options.listingMarkdown,
    options.rawHtml,
  );
  const extractions: string[] = [];
  const extractor = ListingExtractor.of({
    extract: ({ url }) =>
      Effect.sync(() => {
        extractions.push(url);
        return [pageListing];
      }),
  });
  const requests: string[] = [];
  const http = HttpFetch.of({
    request: (url, { method = "GET" } = {}) =>
      Effect.suspend(() => {
        requests.push(`${method} ${url}`);
        const response = options.respond?.(url, method);
        return response
          ? Effect.succeed(response)
          : Effect.fail(new ScrapeFailed({ status: null, message: "offline" }));
      }),
  });
  const layer = Layer.mergeAll(
    Layer.succeed(PageCacheStore, memory.store),
    Layer.succeed(Firecrawl, fake.firecrawl),
    Layer.succeed(ListingExtractor, extractor),
    Layer.succeed(HttpFetch, http),
    Layer.succeed(PdfParser, makePdfParser(liteParseText)),
    Layer.effect(HostLimiter, makeHostLimiter(0)),
    TestClock.layer(),
  );
  const run = <A, E>(
    program: Effect.Effect<
      A,
      E,
      PageCacheStore | Firecrawl | ListingExtractor | HttpFetch | PdfParser | HostLimiter
    >,
  ) => program.pipe(Effect.provide(layer), Effect.runPromise);
  return { ...memory, ...fake, requests, extractions, run };
};

describe("page cache", () => {
  test("reuses a scraped job page until cleared", async () => {
    const { run, scraped } = setup();
    const program = Effect.gen(function* () {
      const first = yield* scrapeJobPage("alice", "https://example.com/job/1");
      yield* TestClock.adjust("30 days");
      const second = yield* scrapeJobPage("alice", "https://example.com/job/1");
      return [first, second];
    });
    expect(await run(program)).toEqual([plain("Markdown 1"), plain("Markdown 1")]);
    expect(scraped).toEqual(["https://example.com/job/1"]);
  });

  test("caches source listings for 15 minutes", async () => {
    const { run, scraped } = setup();
    const url = "https://example.com/jobs";
    const program = Effect.gen(function* () {
      const first = yield* scrapeSourceListings("alice", pageSource(url));
      yield* TestClock.adjust("14 minutes");
      yield* scrapeSourceListings("alice", pageSource(url));
      yield* TestClock.adjust("1 minute");
      yield* scrapeSourceListings("alice", pageSource(url));
      return first;
    });
    expect(await run(program)).toEqual({
      listings: [pageListing],
      embedded: null,
      listingHash: listingHashOf("[Engineer](/job/1)"),
    });
    expect(scraped).toEqual([url, url]);
  });

  test("keeps expired listings without reading them again when the page is unchanged", async () => {
    // The link has no title, so only the model can read this page.
    const { run, scraped, extractions } = setup({ listingMarkdown: "Engineer [Apply](/job/1)" });
    const url = "https://example.com/jobs";
    const program = Effect.gen(function* () {
      const first = yield* scrapeSourceListings("alice", pageSource(url));
      yield* TestClock.adjust("20 minutes");
      const unchanged = { ...pageSource(url), listingHash: first.listingHash };
      const second = yield* scrapeSourceListings("alice", unchanged);
      yield* TestClock.adjust("20 minutes");
      const changed = { ...pageSource(url), listingHash: "an older page" };
      yield* scrapeSourceListings("alice", changed);
      return [first, second];
    });
    const [first, second] = await run(program);
    expect(first).toEqual({
      listings: [pageListing],
      embedded: null,
      // Whitespace changes alone keep the hash.
      listingHash: listingHashOf(" Engineer\n\t[Apply](/job/1) "),
    });
    expect(second).toEqual(first);
    expect(scraped).toEqual([url, url, url]);
    expect(extractions).toEqual([url, url]);
  });

  test("stores the listings expiry 15 minutes after the scrape", async () => {
    const { run, rows, id } = setup();
    const url = "https://example.com/jobs";
    await run(scrapeSourceListings("alice", pageSource(url)));
    const row = rows.get(id({ userId: "alice", url, kind: "SOURCE_LISTING" }));
    expect(row?.expiresAt?.getTime()).toBe(15 * 60 * 1000);
  });

  test("keeps each user's cache separate", async () => {
    const { run, scraped } = setup();
    const url = "https://example.com/job/1";
    await run(Effect.all([scrapeJobPage("alice", url), scrapeJobPage("bob", url)]));
    expect(scraped).toEqual([url, url]);
  });

  test("reads a job page's structured data and keeps it with the page", async () => {
    const rawHtml = await pageFixture("lever-job.html");
    const { run, rows, id, scraped } = setup({ markdown: "# Customer Success Manager", rawHtml });
    const url = "https://jobs.lever.co/leverdemo/1";
    const program = Effect.all([scrapeJobPage("alice", url), scrapeJobPage("alice", url)]);
    const [first, second] = await run(program);
    expect(first).toEqual({
      markdown: "# Customer Success Manager",
      posting: parseJobPosting(rawHtml),
    });
    expect(first.posting?.locations).toEqual(["Atlanta, Georgia"]);
    expect(second).toEqual(first);
    expect(scraped).toEqual([url]);
    expect(rows.get(id({ userId: "alice", url, kind: "JOB_PAGE" }))?.content as unknown).toEqual(
      first,
    );
  });

  test("reads a job page cached as plain markdown", async () => {
    const { run, rows, id, scraped } = setup();
    const url = "https://example.com/job/1";
    rows.set(id({ userId: "alice", url, kind: "JOB_PAGE" }), { content: "Old", expiresAt: null });
    expect(await run(scrapeJobPage("alice", url))).toEqual(plain("Old"));
    expect(scraped).toEqual([]);
  });

  test("does not cache a failed scrape", async () => {
    const { run, rows } = setup({ fail: true });
    const error = await run(Effect.flip(scrapeJobPage("alice", "https://example.com/job/1")));
    expect(error._tag).toBe("ScrapeFailed");
    expect(rows.size).toBe(0);
  });

  test("reads listings cached before remote and postedAt existed", async () => {
    const { run, rows, id, scraped } = setup();
    const url = "https://example.com/jobs";
    const { remote: _remote, postedAt: _postedAt, ...old } = listing;
    rows.set(id({ userId: "alice", url, kind: "SOURCE_LISTING" }), {
      content: [{ ...old, locations: [...old.locations] }],
      expiresAt: null,
    });
    expect(await run(scrapeSourceListings("alice", pageSource(url)))).toEqual({
      listings: [listing],
      embedded: null,
      listingHash: null,
    });
    expect(scraped).toEqual([]);
  });

  test("scrapes again when a cached row cannot be read", async () => {
    const { run, rows, id, scraped } = setup();
    const url = "https://example.com/jobs";
    rows.set(id({ userId: "alice", url, kind: "SOURCE_LISTING" }), {
      content: [{ title: "Old shape" }],
      expiresAt: null,
    });
    expect(await run(scrapeSourceListings("alice", pageSource(url)))).toEqual({
      listings: [pageListing],
      embedded: null,
      listingHash: listingHashOf("[Engineer](/job/1)"),
    });
    expect(scraped).toEqual([url]);
  });
});

describe("job pages for listings", () => {
  const jobUrl = "https://jobs.smartrecruiters.com/BoschGroup/744000154933569";
  const apiUrl = "https://api.smartrecruiters.com/v1/companies/BoschGroup/postings/744000154933569";
  const job: Listing = { ...listing, url: jobUrl, title: "Intern", company: "Bosch Group" };

  test("uses the listing's own job ad without scraping or caching", async () => {
    const { run, scraped, requests, rows } = setup();
    const page = await run(jobPageFor("alice", { ...job, description: "Ad text" }, "LEVER"));
    expect(page.posting).toBeNull();
    expect(page.via).toBe("ATS");
    expect(page.markdown).toBe("# Intern\n\nBosch Group · Bengaluru\n\nAd text");
    expect([...scraped, ...requests]).toEqual([]);
    expect(rows.size).toBe(0);
  });

  test("reads a missing job ad from the source's API once", async () => {
    const posting = await Bun.file(
      new URL("../../test/fixtures/ats/smartrecruiters-posting.json", import.meta.url),
    ).text();
    const { run, scraped, requests } = setup({
      respond: (url) =>
        url === apiUrl
          ? { status: 200, headers: new Headers(), body: new TextEncoder().encode(posting) }
          : null,
    });
    const program = Effect.all([
      jobPageFor("alice", job, "SMARTRECRUITERS"),
      jobPageFor("alice", job, "SMARTRECRUITERS"),
    ]);
    const [first, second] = await run(program);
    expect(first.markdown).toStartWith("# Intern\n\nBosch Group · Bengaluru\n\nJob Description");
    expect(second).toEqual({ ...first, via: "CACHE" });
    expect(first.via).toBe("ATS");
    expect(requests).toEqual([`GET ${apiUrl}`]);
    expect(scraped).toEqual([]);
  });

  test("scrapes the job page when the source cannot supply the ad", async () => {
    const { run, scraped } = setup();
    expect(await run(jobPageFor("alice", job, "PAGE"))).toEqual({
      ...plain("Markdown 1"),
      via: "CLOUD",
    });
    expect(scraped).toEqual([jobUrl]);
    expect((await run(jobPageFor("alice", job, "PAGE"))).via).toBe("CACHE");
  });
});

describe("PDF job pages", () => {
  const pdfUrl = "https://example.com/careers/backend.PDF";
  const pageUrl = "https://example.com/job/1";

  test("parses a .pdf job ad locally and caches the text", async () => {
    const { run, scraped, requests } = setup({ respond: () => pdfResponse });
    const program = Effect.all([scrapeJobPage("alice", pdfUrl), scrapeJobPage("alice", pdfUrl)]);
    const [first, second] = await run(program);
    expect(first.markdown).toContain("Senior Backend Engineer");
    expect(second).toEqual(first);
    expect(requests).toEqual([`GET ${pdfUrl}`]);
    expect(scraped).toEqual([]);
  });

  test("downloads a page whose HEAD reports a PDF", async () => {
    const { run, scraped, requests } = setup({ respond: () => pdfResponse });
    expect((await run(scrapeJobPage("alice", pageUrl))).markdown).toContain("Acme Analytics");
    expect(requests).toEqual([`HEAD ${pageUrl}`, `GET ${pageUrl}`]);
    expect(scraped).toEqual([]);
  });

  test.each<[string, string, Respond | undefined]>([
    ["a HEAD that is not a PDF", pageUrl, () => htmlResponse],
    ["a failed HEAD", pageUrl, undefined],
    ["a .pdf URL that serves HTML", pdfUrl, () => htmlResponse],
    ["a failed PDF download", pdfUrl, undefined],
    ["a PDF download with an error status", pdfUrl, () => ({ ...pdfResponse, status: 404 })],
  ])("falls back to Firecrawl after %s", async (_name, url, respond) => {
    const { run, scraped } = setup(respond ? { respond } : {});
    expect(await run(scrapeJobPage("alice", url))).toEqual(plain("Markdown 1"));
    expect(scraped).toEqual([url]);
  });

  test("parses a PDF Firecrawl returned as base64", async () => {
    const markdown = Buffer.from(jobAd).toString("base64");
    const { run } = setup({ markdown, respond: () => htmlResponse });
    expect((await run(scrapeJobPage("alice", pageUrl))).markdown).toContain(
      "Senior Backend Engineer",
    );
  });
});
