import { describe, expect, test } from "bun:test";
import { Effect, Layer, Logger } from "effect";
import { fakeHttp } from "../../../test/ats";
import { pageFixture } from "../../../test/pages";
import { HttpFetch } from "../download";
import { OpenRouterAuthError } from "../errors";
import { Firecrawl, type Listing, type ListingPage } from "../firecrawl";
import { type ExtractionInput, ListingExtractor } from "../listing-extractor";
import type { ListingSource } from "./adapter";
import { HostLimiter, makeHostLimiter } from "./http";
import { maxExtractionChars, pageAdapter } from "./page";

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
}

// Serves each scraped page from `pages` and records what the adapter asked for.
const fetchPage = async (
  listingSource: ListingSource,
  page: Partial<ListingPage>,
  options: Options = {},
) => {
  const scrapes: { url: string; selector: string | null; withHtml: boolean }[] = [];
  const extractions: ExtractionInput[] = [];
  const infos: string[] = [];
  const firecrawl = Firecrawl.of({
    scrapeMarkdown: () => Effect.die("unused"),
    scrapeListingPage: (url, { selector = null, withHtml = false } = {}) =>
      Effect.sync(() => {
        scrapes.push({ url, selector, withHtml });
        return { markdown: "", links: [], rawHtml: null, siteName: null, ...page };
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
    .fetchListings(listingSource)
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
  return { result, scrapes, extractions, infos };
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
    expect(scrapes).toEqual([
      { url: "https://www.acme.com/careers", selector: "main .openings", withHtml: false },
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
