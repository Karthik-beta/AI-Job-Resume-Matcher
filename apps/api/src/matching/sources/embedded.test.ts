import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { atsLayer, fakeHttp, fixture } from "../../../test/ats";
import { Firecrawl, type ListingsPage } from "../firecrawl";
import type { ListingSource } from "./adapter";
import { detectEmbeddedBoard } from "./embedded";
import { pageAdapter } from "./page";

describe("detectEmbeddedBoard", () => {
  test("finds the Greenhouse embed script on a careers page", async () => {
    const html = await fixture("career-embed-greenhouse.html");
    expect(detectEmbeddedBoard(html, [])).toEqual({ kind: "GREENHOUSE", adapterKey: "lattice" });
  });

  test("finds the Ashby embed on a careers page", async () => {
    const html = await fixture("career-embed-ashby.html");
    expect(detectEmbeddedBoard(html, [])).toEqual({ kind: "ASHBY", adapterKey: "ironcladhq" });
  });

  test.each([
    ['<iframe src="//job-boards.greenhouse.io/embed/job_board?for=acme&amp;b=1">', "GREENHOUSE"],
    ['<a href="https://jobs.lever.co/acme/123">Apply</a>', "LEVER"],
    ['<a href="https://careers.smartrecruiters.com/acme">Jobs</a>', "SMARTRECRUITERS"],
    ["<script>load('https://acme.recruitee.com/api/offers')</script>", "RECRUITEE"],
  ])("reads %s", (html, kind) => {
    expect(detectEmbeddedBoard(html, [])).toMatchObject({ kind });
  });

  test("prefers the page's links and ignores other ATS URLs", () => {
    const html =
      '<a href="https://www.lever.co/">Lever</a> <a href="https://jobs.ashbyhq.com/acme-b">';
    expect(
      detectEmbeddedBoard(html, ["https://example.com/", "https://jobs.lever.co/acme"]),
    ).toEqual({ kind: "LEVER", adapterKey: "acme" });
    expect(detectEmbeddedBoard(html, [])).toEqual({ kind: "ASHBY", adapterKey: "acme-b" });
    expect(detectEmbeddedBoard('<a href="https://www.lever.co/">', [])).toBeNull();
  });
});

describe("page adapter", () => {
  const page: ListingsPage = {
    listings: [],
    rawHtml: '<script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>',
    links: [],
  };

  const fetch = (lastCheckedAt: Date | null) => {
    const requests: boolean[] = [];
    const firecrawl = Firecrawl.of({
      scrapeMarkdown: () => Effect.die("unused"),
      scrapeListings: (_url, options) =>
        Effect.sync(() => {
          requests.push(options?.withPage ?? false);
          return options?.withPage ? page : { ...page, rawHtml: null };
        }),
    });
    const source: ListingSource = {
      url: "https://acme.com/careers",
      kind: "PAGE",
      adapterKey: null,
      lastCheckedAt,
    };
    return pageAdapter
      .fetchListings(source)
      .pipe(
        Effect.provide(Layer.succeed(Firecrawl, firecrawl)),
        Effect.provide(atsLayer(fakeHttp({}).http)),
        Effect.runPromise,
      )
      .then((fetched) => ({ fetched, requests }));
  };

  test("scans the page for an embedded board on the first check", async () => {
    const { fetched, requests } = await fetch(null);
    expect(requests).toEqual([true]);
    expect(fetched).toEqual({ listings: [], embedded: { kind: "GREENHOUSE", adapterKey: "acme" } });
  });

  test("skips the scan once the source has been checked", async () => {
    const { fetched, requests } = await fetch(new Date());
    expect(requests).toEqual([false]);
    expect(fetched).toEqual({ listings: [] });
  });
});
