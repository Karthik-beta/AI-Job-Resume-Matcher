import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { MatchOutputInvalid, ModelUnsupported, OpenRouterAuthError } from "../src/matching/errors";
import { MatchEvaluator, type MatchInput } from "../src/matching/evaluate";
import { Firecrawl, type Listing } from "../src/matching/firecrawl";
import { pageCacheStoreLayer } from "../src/matching/page-cache";
import { PrismaService } from "../src/prisma/prisma.service";
import { processRun } from "../src/runs/process-run";

const listing = (url: string, locations: string[] = [], title = `Job ${url}`): Listing => ({
  title,
  url: `https://jobs.example.com/${url}`,
  company: "Example",
  locations,
  experienceMinYears: null,
  experienceMaxYears: null,
});

const sourceA = "https://board.example.com/a";
const sourceB = "https://board.example.com/b";
const listings: Record<string, Listing[]> = {
  [sourceA]: [listing("1", ["Bengaluru"]), listing("2", ["Mumbai"]), listing("3")],
  [sourceB]: [listing("1", ["Bengaluru"], "Duplicate"), listing("4", ["Bengaluru"]), listing("5")],
};

type Verdict = "match" | "no match" | "invalid" | "auth";

describe("process run", () => {
  const prisma = new PrismaService();
  const userId = `test-${crypto.randomUUID()}`;
  const contextKey = "test-context";
  let sourceIds: string[];

  const startRun = async () => {
    const run = await prisma.run.create({
      data: { userId, trigger: "MANUAL", contextKey, sourceIds },
    });
    return run.id;
  };

  const runWith = async (
    runId: string,
    options: {
      verdicts?: Record<string, Verdict>;
      preflight?: Effect.Effect<void, ModelUnsupported>;
    },
  ) => {
    const evaluated: string[] = [];
    const scraped: string[] = [];
    const firecrawl = Firecrawl.of({
      scrapeMarkdown: (url) =>
        Effect.sync(() => {
          scraped.push(url);
          return `Page ${url}`;
        }),
      scrapeListings: (url) =>
        Effect.sync(() => {
          scraped.push(url);
          return listings[url] ?? [];
        }),
    });
    const evaluate = ({ jobPage }: MatchInput) => {
      const url = jobPage.replace("Page ", "");
      evaluated.push(url);
      switch (options.verdicts?.[url] ?? "no match") {
        case "match":
          return Effect.succeed({ isMatch: true, reason: "Strong fit" });
        case "no match":
          return Effect.succeed({ isMatch: false, reason: "Missing skills" });
        case "invalid":
          return Effect.fail(new MatchOutputInvalid({ message: "Bad output" }));
        case "auth":
          return Effect.fail(new OpenRouterAuthError({ status: 401, message: "User not found." }));
      }
    };
    const layer = Layer.mergeAll(
      Layer.succeed(Firecrawl, firecrawl),
      Layer.succeed(
        MatchEvaluator,
        MatchEvaluator.of({ preflight: options.preflight ?? Effect.void, evaluate }),
      ),
      pageCacheStoreLayer(prisma),
    );
    await Effect.runPromise(processRun(prisma, runId).pipe(Effect.provide(layer)));
    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    return { run, evaluated, scraped };
  };

  const jobUrl = (id: string) => `https://jobs.example.com/${id}`;

  beforeAll(async () => {
    await prisma.settings.create({
      data: {
        userId,
        resumeUrl: "https://example.com/cv.pdf",
        locations: ["Bengaluru"],
        includeUnknown: true,
        maxJobsPerRun: 3,
      },
    });
    const sources = await Promise.all(
      [sourceA, sourceB].map((url) => prisma.jobSource.create({ data: { userId, url } })),
    );
    sourceIds = sources.map(({ id }) => id);
  });

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { userId } });
    await prisma.match.deleteMany({ where: { userId } });
    await prisma.pageCache.deleteMany({ where: { userId } });
    await prisma.jobSource.deleteMany({ where: { userId } });
    await prisma.settings.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  });

  it("dedupes and filters listings, then analyses up to the run size", async () => {
    const { run, evaluated } = await runWith(await startRun(), {
      verdicts: { [jobUrl("1")]: "match", [jobUrl("4")]: "invalid" },
    });

    expect(evaluated).toEqual([jobUrl("1"), jobUrl("3"), jobUrl("4")]);
    expect(run).toMatchObject({
      status: "COMPLETED",
      stopReason: null,
      found: 5,
      eligible: 4,
      checked: 3,
      failed: 1,
    });
    expect(run.finishedAt).not.toBeNull();

    const results = await prisma.jobResult.findMany({
      where: { runId: run.id },
      orderBy: { jobUrl: "asc" },
      select: { jobUrl: true, isMatch: true, error: true, matchSaved: true },
    });
    expect(results).toEqual([
      { jobUrl: jobUrl("1"), isMatch: true, error: null, matchSaved: true },
      { jobUrl: jobUrl("3"), isMatch: false, error: null, matchSaved: false },
      { jobUrl: jobUrl("4"), isMatch: null, error: "Bad output", matchSaved: false },
    ]);

    const matches = await prisma.match.findMany({ where: { userId } });
    expect(matches).toMatchObject([
      { jobUrl: jobUrl("1"), title: "Job 1", locations: ["Bengaluru"], reason: "Strong fit" },
    ]);

    const sources = await prisma.jobSource.findMany({ where: { userId } });
    expect(sources.every(({ lastCheckedAt }) => lastCheckedAt !== null)).toBe(true);
  });

  it("skips jobs already analysed in the same context but retries failed ones", async () => {
    const { run, evaluated } = await runWith(await startRun(), {});

    expect(evaluated).toEqual([jobUrl("4"), jobUrl("5")]);
    expect(run).toMatchObject({ status: "COMPLETED", eligible: 4, checked: 2, failed: 0 });
    const retried = await prisma.jobResult.findFirstOrThrow({
      where: { userId, jobUrl: jobUrl("4") },
    });
    expect(retried).toMatchObject({ runId: run.id, isMatch: false, error: null });
  });

  it("stops on an OpenRouter 401 without analysing further jobs", async () => {
    await prisma.jobResult.deleteMany({ where: { userId } });
    const { run, evaluated } = await runWith(await startRun(), {
      verdicts: { [jobUrl("1")]: "auth" },
    });

    expect(evaluated).toEqual([jobUrl("1")]);
    expect(run).toMatchObject({ status: "STOPPED", stopReason: "User not found.", checked: 0 });
    expect(run.finishedAt).not.toBeNull();
    expect(await prisma.jobResult.count({ where: { runId: run.id } })).toBe(0);
  });

  it("stops before scraping when preflight fails", async () => {
    const { run, scraped } = await runWith(await startRun(), {
      preflight: Effect.fail(new ModelUnsupported({ model: "test", message: "Unsupported model" })),
    });

    expect(scraped).toEqual([]);
    expect(run).toMatchObject({ status: "STOPPED", stopReason: "Unsupported model", found: 0 });
  });

  it("ignores a run that is no longer queued", async () => {
    const runId = await startRun();
    await prisma.run.update({ where: { id: runId }, data: { status: "STOPPED" } });
    const { run, scraped } = await runWith(runId, {});

    expect(scraped).toEqual([]);
    expect(run).toMatchObject({ status: "STOPPED", finishedAt: null });
  });
});
