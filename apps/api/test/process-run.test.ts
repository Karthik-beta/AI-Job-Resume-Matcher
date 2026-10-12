import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { Notifier } from "../src/matching/discord";
import { HttpFetch } from "../src/matching/download";
import {
  MatchOutputInvalid,
  ModelUnsupported,
  NotifyFailed,
  OpenRouterAuthError,
} from "../src/matching/errors";
import { MatchEvaluator, type MatchInput } from "../src/matching/evaluate";
import { Firecrawl, type Listing } from "../src/matching/firecrawl";
import { ListingExtractor } from "../src/matching/listing-extractor";
import { pageCacheStoreLayer } from "../src/matching/page-cache";
import { PdfParser } from "../src/matching/pdf";
import { ResumeSource } from "../src/matching/resume-source";
import { HostLimiter, makeHostLimiter } from "../src/matching/sources/http";
import { PrismaService } from "../src/prisma/prisma.service";
import { fakeHttpFetch, fakePdfParser } from "../src/providers/fake";
import { processRun } from "../src/runs/process-run";

const listing = (url: string, locations: string[] = [], title = `Job ${url}`): Listing => ({
  title,
  url: `https://jobs.example.com/${url}`,
  company: "Example",
  locations,
  experienceMinYears: null,
  experienceMaxYears: null,
  remote: null,
  postedAt: null,
});

const sourceA = "https://board.example.com/a";
const sourceB = "https://board.example.com/b";
const sourceC = "https://board.example.com/c";
const listings: Record<string, Listing[]> = {
  [sourceA]: [listing("1", ["Bengaluru"]), listing("2", ["Mumbai"]), listing("3")],
  [sourceB]: [listing("1", ["Bengaluru"], "Duplicate"), listing("4", ["Bengaluru"]), listing("5")],
  [sourceC]: [
    {
      ...listing("6", ["Bengaluru"], "Described"),
      remote: true,
      description: "Build payment APIs.",
    },
  ],
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
      failAlerts?: boolean;
      resumeHash?: string;
    },
  ) => {
    const evaluated: string[] = [];
    const resumeHashes = new Set<string | undefined>();
    const scraped: string[] = [];
    const alerts: { webhookUrl: string; jobUrl: string }[] = [];
    const notifier = Notifier.of({
      notifyMatch: (webhookUrl, alert) =>
        options.failAlerts
          ? Effect.fail(new NotifyFailed({ message: "Discord returned 500." }))
          : Effect.sync(() => {
              alerts.push({ webhookUrl, jobUrl: alert.jobUrl });
            }),
    });
    const firecrawl = Firecrawl.of({
      scrapeMarkdown: (url) =>
        Effect.sync(() => {
          scraped.push(url);
          return `Page ${url}`;
        }),
      scrapeListingPage: (url, options) =>
        Effect.sync(() => {
          scraped.push(url);
          // Every page embeds a Greenhouse board, which only a first check looks for.
          const embed = options?.withHtml ? ["https://job-boards.greenhouse.io/acme"] : [];
          const jobs = (listings[url] ?? []).map((job) => job.url);
          return {
            markdown: `Jobs at ${url}`,
            links: [...jobs, ...embed],
            rawHtml: null,
            siteName: null,
          };
        }),
    });
    // The jobs' links carry no titles, so the model reads each page.
    const extractor = ListingExtractor.of({
      extract: ({ url }) => Effect.succeed(listings[url] ?? []),
    });
    const evaluate = ({ jobPage, resumeHash }: MatchInput) => {
      const url = jobPage.replace("Page ", "");
      resumeHashes.add(resumeHash);
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
      Layer.succeed(ListingExtractor, extractor),
      Layer.succeed(
        MatchEvaluator,
        MatchEvaluator.of({ preflight: options.preflight ?? Effect.void, evaluate }),
      ),
      pageCacheStoreLayer(prisma),
      Layer.succeed(Notifier, notifier),
      Layer.succeed(
        ResumeSource,
        ResumeSource.of({
          resolve: () => Effect.succeed({ text: "Resume", hash: options.resumeHash ?? "resume-1" }),
        }),
      ),
      Layer.succeed(HttpFetch, fakeHttpFetch),
      Layer.succeed(PdfParser, fakePdfParser),
      Layer.effect(HostLimiter, makeHostLimiter(0)),
    );
    await Effect.runPromise(processRun(prisma, runId, "test/model").pipe(Effect.provide(layer)));
    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    return { run, evaluated, scraped, alerts, resumeHashes };
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
    const { run, evaluated, alerts } = await runWith(await startRun(), {
      verdicts: { [jobUrl("1")]: "match", [jobUrl("4")]: "invalid" },
    });

    expect(alerts).toEqual([]);
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
    // Page sources keep the hash of the page their listings came from.
    expect(sources.every(({ listingHash }) => listingHash?.length === 64)).toBe(true);
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

  it("keeps an applied match's status and stores the listing details", async () => {
    await prisma.jobResult.deleteMany({ where: { userId } });
    await prisma.match.update({
      where: { userId_jobUrl: { userId, jobUrl: jobUrl("1") } },
      data: { status: "APPLIED" },
    });
    const { run } = await runWith(await startRun(), {
      verdicts: { [jobUrl("1")]: "match" },
    });

    const match = await prisma.match.findUniqueOrThrow({
      where: { userId_jobUrl: { userId, jobUrl: jobUrl("1") } },
    });
    expect(match).toMatchObject({ status: "APPLIED", reason: "Strong fit" });
    const result = await prisma.jobResult.findFirstOrThrow({
      where: { runId: run.id, jobUrl: jobUrl("1") },
    });
    expect(result).toMatchObject({
      locations: ["Bengaluru"],
      expMinYears: null,
      matchSaved: true,
    });
  });

  it("alerts the webhook only for saved matches, and keeps the match when the alert fails", async () => {
    const webhookUrl = "https://discord.com/api/webhooks/1/token";
    await prisma.settings.update({ where: { userId }, data: { discordWebhookUrl: webhookUrl } });
    try {
      await prisma.jobResult.deleteMany({ where: { userId } });
      const verdicts = { [jobUrl("1")]: "match", [jobUrl("4")]: "match" } as const;

      const { alerts } = await runWith(await startRun(), { verdicts });
      expect(alerts).toEqual([
        { webhookUrl, jobUrl: jobUrl("1") },
        { webhookUrl, jobUrl: jobUrl("4") },
      ]);

      await prisma.jobResult.deleteMany({ where: { userId } });
      const failing = await runWith(await startRun(), { verdicts, failAlerts: true });
      expect(failing.run).toMatchObject({ status: "COMPLETED", failed: 0 });
      const saved = await prisma.jobResult.count({
        where: { runId: failing.run.id, matchSaved: true },
      });
      expect(saved).toBe(2);
    } finally {
      await prisma.settings.update({ where: { userId }, data: { discordWebhookUrl: null } });
    }
  });

  it("analyses jobs again when the file at the resume URL changes", async () => {
    await prisma.jobResult.deleteMany({ where: { userId } });
    const first = await runWith(await startRun(), {});
    expect(first.evaluated).toEqual([jobUrl("1"), jobUrl("3"), jobUrl("4")]);
    expect(first.run.contextKey).not.toBe(contextKey);
    expect(first.resumeHashes).toEqual(new Set(["resume-1"]));

    const changed = await runWith(await startRun(), { resumeHash: "resume-2" });
    expect(changed.evaluated).toEqual([jobUrl("1"), jobUrl("3"), jobUrl("4")]);
    expect(changed.run.contextKey).not.toBe(first.run.contextKey);
    expect(changed.resumeHashes).toEqual(new Set(["resume-2"]));
    const keys = await prisma.jobResult.findMany({
      where: { runId: changed.run.id },
      select: { contextKey: true },
    });
    expect(keys.map((row) => row.contextKey)).toEqual(Array(3).fill(changed.run.contextKey));

    const unchanged = await runWith(await startRun(), { resumeHash: "resume-2" });
    expect(unchanged.evaluated).toEqual([jobUrl("5")]);
    expect(unchanged.run.contextKey).toBe(changed.run.contextKey);
  });

  it("evaluates a listing's own description without scraping its page", async () => {
    const source = await prisma.jobSource.create({ data: { userId, url: sourceC } });
    expect(source.lastCheckedAt).toBeNull();
    const run = await prisma.run.create({
      data: { userId, trigger: "MANUAL", contextKey, sourceIds: [source.id] },
    });
    const { run: finished, evaluated, scraped } = await runWith(run.id, {});

    expect(scraped).toEqual([sourceC]);
    expect(evaluated).toEqual([
      "# Described\n\nExample · Bengaluru\n\nRemote\n\nBuild payment APIs.",
    ]);
    expect(finished).toMatchObject({ status: "COMPLETED", checked: 1, failed: 0 });
    // The first check of a page source records the board it embeds.
    const checked = await prisma.jobSource.findUniqueOrThrow({ where: { id: source.id } });
    expect(checked).toMatchObject({ suggestedKind: "GREENHOUSE", suggestedAdapterKey: "acme" });
  });

  it("ignores a run that is no longer queued", async () => {
    const runId = await startRun();
    await prisma.run.update({ where: { id: runId }, data: { status: "STOPPED" } });
    const { run, scraped } = await runWith(runId, {});

    expect(scraped).toEqual([]);
    expect(run).toMatchObject({ status: "STOPPED", finishedAt: null });
  });
});
