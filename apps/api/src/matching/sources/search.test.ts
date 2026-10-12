import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { HttpFetch } from "../download";
import { Firecrawl, type SearchOptions, type SearchResult } from "../firecrawl";
import { ListingExtractor } from "../listing-extractor";
import { HostLimiter, makeHostLimiter } from "./http";
import {
  listingKind,
  searchAdapter,
  searchListings,
  searchOptions,
  searchSourceUrl,
} from "./search";

const result = (url: string, title: string | null = null): SearchResult => ({
  url,
  title,
  description: null,
});

const searchResults = [
  result(
    "https://job-boards.greenhouse.io/acme/jobs/123",
    "Job Application for Backend Engineer at Acme",
  ),
  result("https://jobs.lever.co/globex/ad208490-4052-4f91-a57e-433f2d1e484b", "Platform Engineer"),
  result("https://jobs.ashbyhq.com/initech/5f1c2d3e", "Data Engineer"),
  result("https://bunq.recruitee.com/o/backend-developer"),
  // A board, not a job.
  result("https://jobs.lever.co/globex", "Globex jobs"),
  result("https://careers.example.com/jobs/site-reliability-engineer", "SRE"),
  // Listed twice.
  result("https://job-boards.greenhouse.io/acme/jobs/123", "Again"),
];

const run = (source: { query: string | null }) => {
  const searches: { query: string; options: SearchOptions }[] = [];
  const firecrawl = Firecrawl.of({
    scrapeMarkdown: () => Effect.die("unused"),
    scrapeJob: () => Effect.die("unused"),
    scrapeListingPage: () => Effect.die("unused"),
    map: () => Effect.die("unused"),
    search: (query, options) =>
      Effect.sync(() => {
        searches.push({ query, options });
        return { results: searchResults, usage: { via: "cloud", credits: 2 } as const };
      }),
  });
  const layer = Layer.mergeAll(
    Layer.succeed(Firecrawl, firecrawl),
    Layer.succeed(HttpFetch, HttpFetch.of({ request: () => Effect.die("unused") })),
    Layer.succeed(ListingExtractor, ListingExtractor.of({ extract: () => Effect.die("unused") })),
    Layer.effect(HostLimiter, makeHostLimiter(0)),
  );
  const fetched = searchAdapter
    .fetchListings({ url: "search:x", kind: "SEARCH", adapterKey: null, ...source })
    .pipe(Effect.result, Effect.provide(layer), Effect.runPromise);
  return { fetched, searches };
};

describe("search sources", () => {
  test("searches the ATS hosts for the past week's ads, without scraping them", async () => {
    const { fetched, searches } = run({ query: "  backend engineer " });
    const outcome = await fetched;
    expect(searches).toEqual([{ query: "backend engineer", options: searchOptions }]);
    expect(searchOptions).toEqual({
      includeDomains: [
        "job-boards.greenhouse.io",
        "job-boards.eu.greenhouse.io",
        "boards.greenhouse.io",
        "jobs.lever.co",
        "jobs.eu.lever.co",
        "jobs.ashbyhq.com",
        "jobs.smartrecruiters.com",
        "recruitee.com",
      ],
      tbs: "qdr:w",
      limit: 10,
    });
    if (outcome._tag !== "Success") throw new Error(outcome.failure.message);
    expect(
      outcome.success.listings.map(({ title, url, company }) => ({ title, url, company })),
    ).toEqual([
      {
        title: "Backend Engineer",
        url: "https://job-boards.greenhouse.io/acme/jobs/123",
        company: "acme",
      },
      {
        title: "Platform Engineer",
        url: "https://jobs.lever.co/globex/ad208490-4052-4f91-a57e-433f2d1e484b",
        company: "globex",
      },
      {
        title: "Data Engineer",
        url: "https://jobs.ashbyhq.com/initech/5f1c2d3e",
        company: "initech",
      },
      {
        title: "Backend Developer",
        url: "https://bunq.recruitee.com/o/backend-developer",
        company: "bunq",
      },
      {
        title: "SRE",
        url: "https://careers.example.com/jobs/site-reliability-engineer",
        company: "careers.example.com",
      },
    ]);
  });

  test("fails a search without a query", async () => {
    const outcome = await run({ query: " " }).fetched;
    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { message: "The search has no query." },
    });
  });

  test("reads each result's ad through its ATS", () => {
    expect(listingKind("SEARCH", "https://job-boards.greenhouse.io/acme/jobs/123")).toBe(
      "GREENHOUSE",
    );
    expect(listingKind("SEARCH", "https://jobs.smartrecruiters.com/Bosch/744000154933569")).toBe(
      "SMARTRECRUITERS",
    );
    expect(listingKind("SEARCH", "https://careers.example.com/jobs/1")).toBe("PAGE");
    expect(listingKind("LEVER", "https://example.com/jobs/1")).toBe("LEVER");
  });

  test("stores a search under its query", () => {
    expect(searchSourceUrl("Backend Engineer")).toBe("search:backend engineer");
    expect(searchListings([])).toEqual([]);
  });
});
