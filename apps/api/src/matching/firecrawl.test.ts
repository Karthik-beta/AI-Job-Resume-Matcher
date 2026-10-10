import { describe, expect, test } from "bun:test";
import { SdkError } from "@mendable/firecrawl-js";
import { Clock, Effect, type Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { Firecrawl, makeFirecrawl, type ScrapedPage, type ScrapeFormat } from "./firecrawl";

interface Call {
  readonly url: string;
  readonly format: ScrapeFormat;
  readonly at: number;
}

type Reply = ScrapedPage | SdkError | Error;

// Replays the scripted replies in order, repeating the last one.
const fakeScrape = (replies: readonly Reply[]) => {
  const calls: Call[] = [];
  const scrape = (url: string, format: ScrapeFormat) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;
      const reply = replies[Math.min(calls.length, replies.length - 1)];
      calls.push({ url, format, at });
      return reply instanceof Error ? yield* Effect.fail(reply) : (reply ?? {});
    });
  return { calls, scrape };
};

// Runs the program with a test clock and fast-forwards through every sleep.
const run = <A, E>(
  replies: readonly Reply[],
  program: (firecrawl: Firecrawl["Service"]) => Effect.Effect<A, E>,
) => {
  const fake = fakeScrape(replies);
  return Effect.gen(function* () {
    const firecrawl = yield* makeFirecrawl(fake.scrape);
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
    expect(calls.map(({ url, format }) => ({ url, format }))).toEqual([
      { url, format: "markdown" },
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

describe("scrapeListings", () => {
  test("sends the extraction prompt and schema", async () => {
    const { calls } = await run([{ json: { jobs: [] } }], (f) =>
      f.scrapeListings("https://example.com/jobs"),
    );
    const format = calls[0]?.format;
    if (typeof format !== "object") throw new Error("Expected a JSON format");
    expect(format.type).toBe("json");
    expect(format.prompt).toContain("only individual job listings explicitly present");
    expect(format.prompt).toContain("null experience bounds when unstated");
    expect(format.prompt).toContain("Do not invent jobs");
    expect(format.schema).toMatchObject({
      required: ["jobs"],
      properties: { jobs: { type: "array", items: { required: ["title", "url", "company"] } } },
    });
  });

  test("decodes listings and fills in unstated fields", async () => {
    const jobs = [
      {
        title: "Engineer",
        url: "https://example.com/job/1",
        company: "First",
        locations: ["Bengaluru"],
        experience_min_years: 3,
        experience_max_years: 5,
      },
      { title: "Developer", url: "https://example.com/job/2", company: "Second" },
    ];
    const { exit } = await run([{ json: { jobs } }], (f) =>
      f.scrapeListings("https://example.com/jobs"),
    );
    expect(successOf(exit)).toEqual([
      {
        title: "Engineer",
        url: "https://example.com/job/1",
        company: "First",
        locations: ["Bengaluru"],
        experienceMinYears: 3,
        experienceMaxYears: 5,
      },
      {
        title: "Developer",
        url: "https://example.com/job/2",
        company: "Second",
        locations: [],
        experienceMinYears: null,
        experienceMaxYears: null,
      },
    ]);
  });

  test.each([
    undefined,
    null,
    {},
    { jobs: "invalid" },
    { jobs: [{ title: "Missing fields" }] },
    { jobs: [{ title: "T", url: "U", company: "C", experience_min_years: -1 }] },
  ])("fails on invalid listings: %p", async (json) => {
    const { exit } = await run([{ json }], (f) => f.scrapeListings("https://example.com/jobs"));
    const error = failureOf(exit);
    expect(error._tag).toBe("ScrapeFailed");
    expect(error.message).toStartWith("Firecrawl returned invalid listings");
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
      f.scrapeListings("https://example.com/jobs"),
    );
    expect(failureOf(exit)).toMatchObject({
      _tag: "ScrapeFailed",
      status: null,
      message: "Connection lost",
    });
  });
});
