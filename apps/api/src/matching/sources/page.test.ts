import { describe, expect, test } from "bun:test";
import { Effect, Layer, Logger } from "effect";
import { fakeHttp } from "../../../test/ats";
import { pageFixture } from "../../../test/pages";
import { HttpFetch } from "../download";
import { OpenRouterAuthError } from "../errors";
import { Firecrawl, type Listing, type ListingPage, type MappedLink } from "../firecrawl";
import { type ExtractionInput, ListingExtractor } from "../listing-extractor";
import type { ListingSource } from "./adapter";
import { HostLimiter, makeHostLimiter } from "./http";
import { listingHashOf, maxExtractionChars, pageAdapter } from "./page";

const job = (fields: Partial<Listing> & Pick<Listing, "title" | "url">): Listing => ({
  company: "Acme",
  locations: [],
  experienceMinYears: null,
  experienceMaxYears: null,
  remote: null,
  postedAt: null,
  ...fields,
});

const source = (url: string, fields: Partial<ListingSource> = {}): ListingSource => ({
  url,
  kind: "PAGE",
  adapterKey: null,
  lastCheckedAt: new Date(),
  ...fields,
});

interface Options {
  readonly extracted?: readonly Listing[];
  readonly failExtraction?: boolean;
  readonly previous?: readonly Listing[];
  // Further pages of the listing, by URL.
  readonly pages?: Record<string, Partial<ListingPage>>;
  readonly mapped?: readonly MappedLink[];
}

// Serves the further `pages` by URL, and the source's page for any other URL, so a next
// page that is not scripted repeats the first. Records what the adapter asked for.
const fetchPage = async (
  listingSource: ListingSource,
  page: Partial<ListingPage>,
  options: Options = {},
) => {
  const scrapes: { url: string; selector: string | null; withHtml: boolean }[] = [];
  const extractions: ExtractionInput[] = [];
  const infos: string[] = [];
  const maps: string[] = [];
  const firecrawl = Firecrawl.of({
    scrapeMarkdown: () => Effect.die("unused"),
    scrapeJob: () => Effect.die("unused"),
    scrapeListingPage: (url, { selector = null, withHtml = false } = {}) =>
      Effect.sync(() => {
        scrapes.push({ url, selector, withHtml });
        const served = options.pages?.[url] ?? page;
        return { markdown: "", links: [], rawHtml: null, siteName: null, ...served };
      }),
    map: (url, { search }) =>
      Effect.sync(() => {
        maps.push(`${url} ${search}`);
        return options.mapped ?? [];
      }),
  });
  const extractor = ListingExtractor.of({
    extract: (input) =>
      Effect.suspend(() => {
        extractions.push(input);
        return options.failExtraction
          ? Effect.fail(new OpenRouterAuthError({ status: 401, message: "User not found." }))
          : Effect.succeed(options.extracted ?? []);
      }),
  });
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Info") infos.push([message].flat().join(" "));
  });
  const result = await pageAdapter
    .fetchListings(listingSource, options.previous)
    .pipe(
      Effect.result,
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Firecrawl, firecrawl),
          Layer.succeed(ListingExtractor, extractor),
          Layer.succeed(HttpFetch, fakeHttp({}).http),
          Layer.effect(HostLimiter, makeHostLimiter(0)),
          Logger.layer([logger]),
        ),
      ),
      Effect.runPromise,
    );
  return { result, scrapes, extractions, infos, maps };
};

const listingsOf = (result: Awaited<ReturnType<typeof fetchPage>>["result"]) => {
  if (result._tag === "Failure") throw new Error(result.failure.message);
  return result.success.listings;
};

describe("page adapter rules", () => {
  test("reads titled job links without the model", async () => {
    const markdown = await pageFixture("acme-careers.md");
    const { result, scrapes, extractions } = await fetchPage(
      source("https://www.acme.com/careers", { selector: "main .openings" }),
      { markdown, siteName: "Acme" },
    );
    expect(listingsOf(result)).toEqual([
      job({
        title: "Senior Backend Engineer",
        url: "https://www.acme.com/careers/engineering/senior-backend-engineer",
      }),
      job({
        title: "Frontend Engineer (React)",
        url: "https://www.acme.com/careers/engineering/frontend-engineer",
      }),
      job({ title: "Product Designer", url: "https://careers.acme.com/jobs/product-designer" }),
    ]);
    // The next page repeats the first, which ends the listing.
    expect(scrapes).toEqual([
      { url: "https://www.acme.com/careers", selector: "main .openings", withHtml: false },
      { url: "https://www.acme.com/careers?page=2", selector: "main .openings", withHtml: false },
    ]);
    expect(extractions).toEqual([]);
  });

  test("names the company after the host when the page has no site name", async () => {
    const markdown = await pageFixture("globex-board.md");
    const { result } = await fetchPage(source("https://www.globex.io/careers"), { markdown });
    expect(listingsOf(result).map(({ company }) => company)).toEqual(Array(3).fill("globex.io"));
  });
});

describe("page adapter model fallback", () => {
  const url = "https://initech.com/jobs";

  test("asks the model when no job link has a title, keeping only URLs on the page", async () => {
    const markdown = await pageFixture("initech-apply-only.md");
    const extracted = [
      job({
        title: "Software Engineer II",
        url: "https://initech.com/jobs/1042",
        company: "Initech",
        locations: ["Austin, TX"],
        experienceMinYears: 3,
      }),
      job({ title: "QA Analyst", url: "/jobs/1043/#top", company: " " }),
      job({ title: "Invented", url: "https://initech.com/jobs/9999", company: "Initech" }),
      job({ title: "Elsewhere", url: "https://example.com/jobs/1", company: "Initech" }),
    ];
    const { result, extractions } = await fetchPage(
      source(url),
      { markdown, links: ["https://initech.com/jobs/1043/"], siteName: "Initech Corp" },
      { extracted },
    );
    expect(extractions).toEqual([{ url, markdown }]);
    expect(listingsOf(result)).toEqual([
      extracted[0] as Listing,
      job({ title: "QA Analyst", url: "https://initech.com/jobs/1043", company: "Initech Corp" }),
    ]);
  });

  test("asks the model when the page has no job links", async () => {
    const markdown = await pageFixture("hooli-no-links.md");
    const { result, extractions } = await fetchPage(source("https://hooli.com/careers"), {
      markdown,
    });
    expect(extractions).toHaveLength(1);
    expect(listingsOf(result)).toEqual([]);
  });

  test("sends at most 60,000 characters of a long page", async () => {
    const markdown = "Openings ".repeat(10_000);
    const { extractions, infos } = await fetchPage(source(url), { markdown });
    expect(extractions[0]?.markdown).toBe(markdown.slice(0, maxExtractionChars));
    expect(infos).toEqual([
      `Listing extraction reads the first 60000 of 90000 characters of ${url}.`,
    ]);
  });

  test("skips the model for an empty page", async () => {
    const { result, extractions } = await fetchPage(source(url), { markdown: " \n" });
    expect(listingsOf(result)).toEqual([]);
    expect(extractions).toEqual([]);
  });

  test("fails the scrape when the model fails", async () => {
    const { result } = await fetchPage(source(url), { markdown: "Jobs" }, { failExtraction: true });
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ScrapeFailed",
        message: `Could not read the listings on ${url}: User not found.`,
      },
    });
  });
});

describe("page adapter on an unchanged page", () => {
  const url = "https://www.acme.com/careers";
  const previous = [job({ title: "Listed before", url: "https://www.acme.com/jobs/1" })];

  test("keeps the last listings without reading the links or asking the model", async () => {
    const markdown = await pageFixture("acme-careers.md");
    const listingHash = listingHashOf(markdown);
    const { result, extractions } = await fetchPage(
      source(url, { listingHash }),
      { markdown },
      { previous },
    );
    expect(result).toMatchObject({ _tag: "Success", success: { listings: previous, listingHash } });
    expect(extractions).toEqual([]);
  });

  test.each<[string, string | null, readonly Listing[] | undefined]>([
    ["the page changed", "an older hash", previous],
    ["the listings are no longer cached", null, undefined],
  ])("reads the page again when %s", async (_, listingHash, cached) => {
    const markdown = await pageFixture("initech-apply-only.md");
    const hash = listingHash ?? listingHashOf(markdown);
    const { result, extractions } = await fetchPage(
      source(url, { listingHash: hash }),
      { markdown },
      cached ? { previous: cached } : {},
    );
    expect(extractions).toHaveLength(1);
    expect(result).toMatchObject({
      _tag: "Success",
      success: { listings: [], listingHash: listingHashOf(markdown) },
    });
  });
});

describe("page adapter pagination", () => {
  const url = "https://globex.io/careers";
  const page = (n: number, jobs: string) =>
    `## Page ${n}\n\n${jobs}\n\n[‹ Previous](/careers?page=${n - 1}) [Next ›](/careers?page=${n + 1})`;
  const pages = {
    [`${url}?page=2`]: { markdown: page(2, "- [Data Engineer](/jobs/data-engineer)") },
    [`${url}?page=3`]: { markdown: page(3, "- [Designer](/jobs/designer)") },
    [`${url}?page=4`]: { markdown: page(4, "- [Recruiter](/jobs/recruiter)") },
  };
  const first = {
    markdown: page(
      1,
      "- [Backend Engineer](/jobs/backend)\n- [Data Engineer](/jobs/data-engineer)",
    ),
  };

  test("collects job links across the next pages up to the source's page limit", async () => {
    const { result, scrapes } = await fetchPage(source(url), first, { pages });
    expect(scrapes.map((scrape) => scrape.url)).toEqual([url, `${url}?page=2`, `${url}?page=3`]);
    expect(listingsOf(result).map(({ title }) => title)).toEqual([
      "Backend Engineer",
      "Data Engineer",
      "Designer",
    ]);
  });

  test("reads only as many pages as the source allows", async () => {
    const { scrapes } = await fetchPage(source(url, { maxPages: 1 }), first, { pages });
    expect(scrapes).toHaveLength(1);
  });

  test("stops at the last page", async () => {
    const last = { markdown: "- [Designer](/jobs/designer)" };
    const { scrapes } = await fetchPage(source(url), first, {
      pages: { ...pages, [`${url}?page=2`]: last },
    });
    expect(scrapes.map((scrape) => scrape.url)).toEqual([url, `${url}?page=2`]);
  });

  test("hands every page to the model and keeps links from any of them", async () => {
    const untitled = (n: number) => ({
      markdown: `Openings, page ${n}: [Apply](/jobs/${n}000) [Next](/careers?page=${n + 1})`,
    });
    const extracted = [
      job({ title: "Backend Engineer", url: "https://globex.io/jobs/1000" }),
      job({ title: "Designer", url: "https://globex.io/jobs/2000" }),
    ];
    const { result, extractions } = await fetchPage(source(url, { maxPages: 2 }), untitled(1), {
      pages: { [`${url}?page=2`]: untitled(2) },
      extracted,
    });
    expect(extractions).toEqual([
      { url, markdown: `${untitled(1).markdown}\n\n${untitled(2).markdown}` },
    ]);
    expect(listingsOf(result)).toEqual(extracted);
  });
});

describe("page adapter with Firecrawl's map", () => {
  const url = "https://www.acme.com/careers";

  test("titles the map's job links by their slugs instead of scraping", async () => {
    const mapped = [
      { url: "https://www.acme.com/jobs/senior-backend-engineer-123456", title: "Ignored" },
      { url: "https://www.acme.com/jobs/senior-backend-engineer-123456/" },
      { url: "https://www.acme.com/jobs/4012345" },
      { url: "https://www.acme.com/about" },
      { url: "https://careers.acme.com/jobs/data_engineer" },
    ];
    const { result, scrapes, maps } = await fetchPage(
      source(url, { useMap: true }),
      {},
      { mapped },
    );
    expect(maps).toEqual([`${url} job`]);
    expect(scrapes).toEqual([]);
    expect(result).toMatchObject({
      success: {
        listingHash: listingHashOf(
          "https://careers.acme.com/jobs/data_engineer " +
            "https://www.acme.com/jobs/senior-backend-engineer-123456",
        ),
      },
    });
    expect(listingsOf(result)).toEqual([
      job({
        title: "Senior Backend Engineer",
        url: "https://www.acme.com/jobs/senior-backend-engineer-123456",
        company: "acme.com",
      }),
      job({
        title: "Data Engineer",
        url: "https://careers.acme.com/jobs/data_engineer",
        company: "acme.com",
      }),
    ]);
  });

  test("scrapes the page when the map has no job links", async () => {
    const markdown = await pageFixture("globex-board.md");
    const { result, scrapes, maps, infos } = await fetchPage(
      source(url, { useMap: true }),
      { markdown, siteName: "Globex" },
      { mapped: [{ url: "https://www.acme.com/about" }] },
    );
    expect(maps).toHaveLength(1);
    expect(scrapes).toHaveLength(1);
    expect(infos).toEqual([`Firecrawl's map has no job links for ${url}.`]);
    expect(listingsOf(result)).toHaveLength(3);
  });
});

describe("page adapter embedded boards", () => {
  const page = {
    rawHtml: '<script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>',
  };

  test("scans the page for an embedded board on the first check", async () => {
    const { result, scrapes } = await fetchPage(
      source("https://acme.com/careers", { lastCheckedAt: null }),
      page,
    );
    expect(scrapes.map(({ withHtml }) => withHtml)).toEqual([true]);
    expect(result).toMatchObject({
      _tag: "Success",
      success: { listings: [], embedded: { kind: "GREENHOUSE", adapterKey: "acme" } },
    });
  });

  test("skips the scan once the source has been checked", async () => {
    const { result, scrapes } = await fetchPage(source("https://acme.com/careers"), page);
    expect(scrapes.map(({ withHtml }) => withHtml)).toEqual([false]);
    expect(listingsOf(result)).toEqual([]);
    expect(result._tag === "Success" && "embedded" in result.success).toBe(false);
  });
});
