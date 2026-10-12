import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { Firecrawl } from "../src/matching/firecrawl";
import { pageCacheStoreLayer } from "../src/matching/page-cache";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  fakeEvaluator,
  fakeFirecrawlLayer,
  fakeHttpFetch,
  fakeNotifier,
  fakePdfParser,
  fakeProvidersLayer,
  fakeResumeSource,
} from "../src/providers/fake";
import { liveProvidersLayer } from "../src/providers/live";
import { processRun } from "../src/runs/process-run";

describe("fake providers", () => {
  const prisma = new PrismaService();
  const userId = `test-${crypto.randomUUID()}`;
  const layer = Layer.merge(fakeProvidersLayer, pageCacheStoreLayer(prisma));

  const runOver = async (sourceUrl: string) => {
    const source = await prisma.jobSource.create({ data: { userId, url: sourceUrl } });
    const run = await prisma.run.create({
      data: { userId, trigger: "MANUAL", contextKey: sourceUrl, sourceIds: [source.id] },
    });
    await Effect.runPromise(processRun(prisma, run.id, "test/model").pipe(Effect.provide(layer)));
    return prisma.run.findUniqueOrThrow({ where: { id: run.id }, include: { results: true } });
  };

  beforeAll(async () => {
    await prisma.settings.create({
      data: { userId, resumeUrl: "https://example.com/cv.pdf", experienceYears: 4 },
    });
  });

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { userId } });
    await prisma.match.deleteMany({ where: { userId } });
    await prisma.pageCache.deleteMany({ where: { userId } });
    await prisma.jobSource.deleteMany({ where: { userId } });
    await prisma.settings.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  });

  it("runs the pipeline on the fixtures", async () => {
    const run = await runOver("https://board.example.com/jobs");

    expect(run).toMatchObject({ status: "COMPLETED", found: 3, eligible: 2, checked: 2 });
    const verdicts = Object.fromEntries(run.results.map((r) => [r.jobUrl, r.isMatch]));
    expect(verdicts).toEqual({
      "https://jobs.example.com/backend-payments": true,
      "https://jobs.example.com/full-stack": true,
    });
    expect(await prisma.match.count({ where: { userId } })).toBe(2);
  });

  it("stops the run on a scripted Firecrawl 429", async () => {
    const run = await runOver("https://board.example.com/jobs?fake-error=429");
    expect(run).toMatchObject({ status: "STOPPED", stopReason: "Scripted Firecrawl error 429." });
  });

  it.each(["local", "hybrid"] as const)("serves the fixtures in %p mode", async (mode) => {
    const scrape = (url: string) =>
      Firecrawl.use((firecrawl) => firecrawl.scrapeJob(url)).pipe(
        Effect.provide(fakeFirecrawlLayer(mode)),
        Effect.result,
        Effect.runPromise,
      );
    const page = await scrape("https://jobs.example.com/backend-payments");
    expect(page).toMatchObject({ _tag: "Success", success: { usage: { via: "local" } } });
    // A local instance has no credits to run out of, so its errors fail just the page; hybrid
    // retries the page on the cloud, whose 429 stops the run.
    const failed = await scrape("https://jobs.example.com/x?fake-error=429");
    const tag = mode === "local" ? "ScrapeFailed" : "FirecrawlBlocked";
    expect(failed).toMatchObject({ _tag: "Failure", failure: { _tag: tag } });
    // `?fake-blocked` serves the local instance a bot check, which hybrid retries on the cloud.
    const blocked = await scrape("https://jobs.example.com/backend-payments?fake-blocked");
    expect(blocked).toMatchObject(
      mode === "local"
        ? { _tag: "Failure", failure: { _tag: "ScrapeFailed", status: 403 } }
        : { _tag: "Success", success: { usage: { via: "cloud", credits: 1 } } },
    );
  });

  it("blocks requests to real providers", async () => {
    await expect(fetch("https://api.firecrawl.dev/v2/scrape")).rejects.toThrow(
      "Tests must not call",
    );
    await expect(fetch("https://boards-api.greenhouse.io/v1/boards/x/jobs")).rejects.toThrow(
      "Tests must not call",
    );
    expect(() => liveProvidersLayer("example/model")).toThrow();
  });

  it("serves the fixture resume and makes no HTTP requests or PDF parses", async () => {
    const resume = await Effect.runPromise(
      fakeResumeSource.resolve(userId, "https://example.com/cv.pdf"),
    );
    expect(resume.text).toContain("Asha Rao");
    expect(resume.hash).toMatch(/^[0-9a-f]{64}$/);
    const outcomes = await Effect.runPromise(
      Effect.all([
        Effect.flip(fakeHttpFetch.request("https://example.com/cv.pdf")),
        Effect.flip(fakePdfParser.parse(new Uint8Array())),
      ]),
    );
    expect(outcomes.map(({ _tag }) => _tag)).toEqual(["ScrapeFailed", "ScrapeFailed"]);
  });

  it("fakes Discord with the same URL check as the live notifier", async () => {
    const alert = {
      title: "Engineer",
      company: "Example",
      jobUrl: "https://jobs.example.com/1",
      reason: "Fit",
    };
    const sent = await Effect.runPromise(
      fakeNotifier
        .notifyMatch("https://discord.com/api/webhooks/1/token", alert)
        .pipe(Effect.result),
    );
    expect(sent._tag).toBe("Success");
    const refused = await Effect.runPromise(
      fakeNotifier.notifyMatch("https://example.com/hook", alert).pipe(Effect.result),
    );
    expect(refused).toMatchObject({ _tag: "Failure", failure: { _tag: "NotifyFailed" } });
  });

  it.each([
    ["auth", "OpenRouterAuthError"],
    ["invalid", "MatchOutputInvalid"],
  ])("scripts a %p verdict as %s", async (verdict, tag) => {
    const outcome = await Effect.runPromise(
      fakeEvaluator
        .evaluate({ resume: "resume", jobPage: `Verdict: ${verdict}` })
        .pipe(Effect.result),
    );
    expect(outcome).toMatchObject({ _tag: "Failure", failure: { _tag: tag } });
  });
});
