import { describe, expect, spyOn, test } from "bun:test";
import { FirecrawlClient, SdkError } from "@mendable/firecrawl-js";
import { Clock, Effect, type Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  Firecrawl,
  firecrawlLayer,
  type MapOptions,
  makeFirecrawl,
  type ScrapedPage,
  type ScrapeRequest,
} from "./firecrawl";

interface Call {
  readonly url: string;
  readonly request: ScrapeRequest | MapOptions;
  readonly at: number;
}

type Reply = ScrapedPage | SdkError | Error;

// Replays the scripted replies in order, repeating the last one. A map call replies with
// the page's links.
const fakeScrape = (replies: readonly Reply[]) => {
  const calls: Call[] = [];
  const next = (url: string, request: ScrapeRequest | MapOptions) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;
      const reply = replies[Math.min(calls.length, replies.length - 1)];
      calls.push({ url, request, at });
      return reply instanceof Error ? yield* Effect.fail(reply) : (reply ?? {});
    });
  const scrape = (url: string, request: ScrapeRequest) => next(url, request);
  const map = (url: string, options: MapOptions) =>
    next(url, options).pipe(
      Effect.map((page) => ({ links: (page.links ?? []).map((link) => ({ url: link })) })),
    );
  return { calls, scrape, map };
};

// Runs the program with a test clock and fast-forwards through every sleep.
const run = <A, E>(
  replies: readonly Reply[],
  program: (firecrawl: Firecrawl["Service"]) => Effect.Effect<A, E>,
) => {
  const fake = fakeScrape(replies);
  return Effect.gen(function* () {
    const firecrawl = yield* makeFirecrawl(fake);
    const fiber = yield* Effect.forkChild(Effect.exit(program(firecrawl)));
    yield* TestClock.adjust("1 hour");
    const exit = yield* Fiber.join(fiber);
    return { exit, calls: fake.calls };
  }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise);
};

const startTimes = (calls: readonly Call[]) => calls.map(({ at }) => at - (calls[0]?.at ?? 0));

const rateLimited = (message = "Rate limit exceeded, please retry after 33s") =>
  new SdkError(message, 429);

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => {
  if (exit._tag === "Success") throw new Error("Expected a failure");
  const failure = exit.cause.reasons[0];
  if (failure?._tag !== "Fail") throw new Error("Expected a typed failure");
  return failure.error;
};

const successOf = <A, E>(exit: Exit.Exit<A, E>) => {
  if (exit._tag === "Failure") throw new Error("Expected a success");
  return exit.value;
};

describe("scrapeMarkdown", () => {
  test("returns the page markdown", async () => {
    const url = "https://example.com/resume.pdf";
    const { exit, calls } = await run([{ markdown: "Resume text" }], (f) => f.scrapeMarkdown(url));
    expect(successOf(exit)).toBe("Resume text");
    expect(calls.map(({ url, request }) => ({ url, request }))).toEqual([
      { url, request: { formats: ["markdown"] } },
    ]);
  });

  test.each<ScrapedPage>([{}, { markdown: "" }, { markdown: "  \n" }])(
    "fails when the markdown is missing: %p",
    async (page) => {
      const { exit } = await run([page], (f) => f.scrapeMarkdown("https://example.com/job"));
      const error = failureOf(exit);
      expect(error._tag).toBe("ScrapeFailed");
      expect(error.message).toBe("Firecrawl returned no document markdown.");
    },
  );
});

describe("scrapeListingPage", () => {
  const url = "https://acme.com/careers";
  const chrome = ["nav", "header", "footer", "aside", "form", "script", "style"];

  test("asks for the main content's markdown and links, without page chrome", async () => {
    const reply = {
      markdown: "# Jobs",
      links: ["https://acme.com/jobs/1"],
      metadata: { title: "Careers | Acme Inc", ogSiteName: "Acme" },
    };
    const { exit, calls } = await run([reply], (f) => f.scrapeListingPage(url));
    expect(successOf(exit)).toEqual({
      markdown: "# Jobs",
      links: ["https://acme.com/jobs/1"],
      rawHtml: null,
      siteName: "Acme",
    });
    expect(calls[0]?.request).toEqual({
      formats: ["markdown", "links"],
      onlyMainContent: true,
      excludeTags: chrome,
    });
  });

  test("adds the HTML when asked and narrows the page to the source's selector", async () => {
    const reply = { markdown: "# Jobs", rawHtml: "<html></html>" };
    const { exit, calls } = await run([reply], (f) =>
      f.scrapeListingPage(url, { withHtml: true, selector: "#openings" }),
    );
    expect(successOf(exit)).toMatchObject({ rawHtml: "<html></html>", links: [] });
    expect(calls[0]?.request).toEqual({
      formats: ["markdown", "links", "rawHtml"],
      onlyMainContent: true,
      excludeTags: chrome,
      includeTags: ["#openings"],
    });
  });

  test.each<[ScrapedPage["metadata"], string | null]>([
    [{ title: "Careers | Acme Inc" }, "Acme Inc"],
    [{ title: "Open roles – Globex" }, "Globex"],
    [{ title: "Initech" }, "Initech"],
    [{ ogSiteName: "  ", title: "" }, null],
    [undefined, null],
  ])("names the site from %p", async (metadata, siteName) => {
    const { exit } = await run([{ metadata }], (f) => f.scrapeListingPage(url));
    expect(successOf(exit)).toMatchObject({ markdown: "", siteName });
  });
});

describe("rate limiting", () => {
  test("spaces concurrent requests 6.1 seconds apart", async () => {
    const urls = ["https://example.com/1", "https://example.com/2", "https://example.com/3"];
    const { exit, calls } = await run([{ markdown: "Job text" }], (f) =>
      Effect.forEach(urls, f.scrapeMarkdown, { concurrency: "unbounded" }),
    );
    expect(successOf(exit)).toHaveLength(3);
    expect(startTimes(calls)).toEqual([0, 6_100, 12_200]);
  });

  test("retries a 429 after the hinted delay plus one second", async () => {
    const { exit, calls } = await run([rateLimited(), { markdown: "Job text" }], (f) =>
      f.scrapeMarkdown("https://example.com/job"),
    );
    expect(successOf(exit)).toBe("Job text");
    expect(startTimes(calls)).toEqual([0, 34_000]);
  });

  test("waits 61 seconds when the 429 has no hint", async () => {
    const { calls } = await run(
      [rateLimited("Rate limit exceeded"), { markdown: "Job text" }],
      (f) => f.scrapeMarkdown("https://example.com/job"),
    );
    expect(startTimes(calls)).toEqual([0, 61_000]);
  });

  test("gives up after two retries and keeps the back-off for the next request", async () => {
    const { exit, calls } = await run(
      [rateLimited(), rateLimited(), rateLimited(), { markdown: "Job text" }],
      (f) =>
        f.scrapeMarkdown("https://example.com/job").pipe(
          Effect.flip,
          Effect.tap(() => f.scrapeMarkdown("https://example.com/job")),
        ),
    );
    const error = successOf(exit);
    expect(error._tag).toBe("FirecrawlBlocked");
    expect(error.status).toBe(429);
    expect(startTimes(calls)).toEqual([0, 34_000, 68_000, 102_000]);
  });
});

describe("errors", () => {
  test.each([401, 402])("stops on %p without retrying", async (status) => {
    const { exit, calls } = await run([new SdkError("Blocked", status)], (f) =>
      f.scrapeMarkdown("https://example.com/job"),
    );
    const error = failureOf(exit);
    expect(error._tag).toBe("FirecrawlBlocked");
    expect(error.status).toBe(status);
    expect(calls).toHaveLength(1);
  });

  test("maps other statuses to a failed scrape without retrying", async () => {
    const { exit, calls } = await run([new SdkError("Server error", 500)], (f) =>
      f.scrapeMarkdown("https://example.com/job"),
    );
    expect(failureOf(exit)).toMatchObject({ _tag: "ScrapeFailed", status: 500 });
    expect(calls).toHaveLength(1);
  });

  test("maps network errors to a failed scrape with no status", async () => {
    const { exit } = await run([new Error("Connection lost")], (f) =>
      f.scrapeListingPage("https://example.com/jobs"),
    );
    expect(failureOf(exit)).toMatchObject({
      _tag: "ScrapeFailed",
      status: null,
      message: "Connection lost",
    });
  });
});

describe("map", () => {
  test("returns the site's links, spaced like scrapes", async () => {
    const { exit, calls } = await run(
      [{ markdown: "Job text", links: ["https://acme.com/jobs/1"] }],
      (f) =>
        Effect.all(
          [
            f.scrapeMarkdown("https://acme.com/a"),
            f.map("https://acme.com", { search: "job", limit: 50 }),
          ],
          { concurrency: "unbounded" },
        ),
    );
    expect(successOf(exit)[1]).toEqual([{ url: "https://acme.com/jobs/1" }]);
    expect(calls[1]?.request).toEqual({ search: "job", limit: 50 });
    expect(startTimes(calls)).toEqual([0, 6_100]);
  });

  test("maps errors like scrapes", async () => {
    const { exit } = await run([new SdkError("Payment required", 402)], (f) =>
      f.map("https://acme.com", { search: "job", limit: 50 }),
    );
    expect(failureOf(exit)).toMatchObject({ _tag: "FirecrawlBlocked", status: 402 });
  });
});

describe("live layer", () => {
  test("passes the request to the SDK with PDF parsing off", async () => {
    // The overloads type the reply of a scrape with a JSON format, which this one has not.
    const scrape = spyOn(FirecrawlClient.prototype, "scrape").mockResolvedValue({
      markdown: "# Jobs",
      links: [],
    } as never);
    try {
      const page = await Firecrawl.use((f) =>
        f.scrapeListingPage("https://acme.com/careers", { selector: "main" }),
      ).pipe(Effect.provide(firecrawlLayer("test-key")), Effect.runPromise);
      expect(page.markdown).toBe("# Jobs");
      expect(scrape).toHaveBeenCalledWith("https://acme.com/careers", {
        formats: ["markdown", "links"],
        onlyMainContent: true,
        excludeTags: ["nav", "header", "footer", "aside", "form", "script", "style"],
        includeTags: ["main"],
        parsers: [],
      });
    } finally {
      scrape.mockRestore();
    }
  });

  test("passes the map search and limit to the SDK", async () => {
    const map = spyOn(FirecrawlClient.prototype, "map").mockResolvedValue({
      links: [{ url: "https://acme.com/jobs/1", title: "Engineer" }],
    });
    try {
      const links = await Firecrawl.use((f) =>
        f.map("https://acme.com", { search: "job", limit: 200 }),
      ).pipe(Effect.provide(firecrawlLayer("test-key")), Effect.runPromise);
      expect(links).toEqual([{ url: "https://acme.com/jobs/1", title: "Engineer" }]);
      expect(map).toHaveBeenCalledWith("https://acme.com", { search: "job", limit: 200 });
    } finally {
      map.mockRestore();
    }
  });
});
