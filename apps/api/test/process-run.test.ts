import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { Notifier } from "../src/matching/discord";
import { HttpFetch } from "../src/matching/download";
import {
  FirecrawlBlocked,
  MatchOutputInvalid,
  ModelUnsupported,
  NotifyFailed,
  OpenRouterAuthError,
  OpenRouterRequestFailed,
} from "../src/matching/errors";
import { MatchEvaluator, type MatchInput } from "../src/matching/evaluate";
import { Firecrawl, type Listing } from "../src/matching/firecrawl";
import { ListingExtractor } from "../src/matching/listing-extractor";
import { pageCacheStoreLayer } from "../src/matching/page-cache";
import { PdfParser } from "../src/matching/pdf";
import { ResumeSource } from "../src/matching/resume-source";
import {
  FirecrawlPlan,
  LocalFirecrawlDown,
  RunCloudBudget,
  ScrapeHealth,
} from "../src/matching/scrape-router";
import { HostLimiter, makeHostLimiter } from "../src/matching/sources/http";
import { TitleTriage } from "../src/matching/triage";
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
  // Each of the first three repeats a job from source A: by URL, by canonical URL, and by
  // company, title and location.
  [sourceB]: [
    listing("1", ["Bengaluru"], "Duplicate"),
    listing("2/?utm_source=feed#apply", ["Mumbai"], "Also duplicate"),
    listing("10", ["bengaluru"], "Job 1"),
    listing("4", ["Bengaluru"]),
    listing("5"),
  ],
  [sourceC]: [
    {
      ...listing("6", ["Bengaluru"], "Described"),
      remote: true,
      description: "Build payment APIs.",
    },
  ],
};

const sourceD = "https://board.example.com/d";
listings[sourceD] = [listing("7"), listing("8"), listing("9")];

const jsonLd = (posting: object) =>
  `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", ...posting })}</script>`;
const mumbai = { "@type": "Place", address: { addressLocality: "Mumbai" } };
const bengaluru = { "@type": "Place", address: { addressLocality: "Bengaluru" } };
// Job pages with schema.org JobPosting data.
const jobHtml: Record<string, string> = {
  "https://jobs.example.com/7": jsonLd({ validThrough: "2020-01-31", jobLocation: bengaluru }),
  "https://jobs.example.com/8": jsonLd({ jobLocation: mumbai, description: "<p>Ad</p>" }),
  "https://jobs.example.com/9": jsonLd({
    jobLocation: bengaluru,
    description: "<p>Build APIs.</p>",
  }),
};

type Verdict = "match" | "no match" | "invalid" | "auth";

// Each scrape costs a credit, refused as the router refuses it in cloud mode.
const spendCredit = Effect.gen(function* () {
  const budget = yield* RunCloudBudget;
  if (!(yield* budget.allows(1))) {
    return yield* new FirecrawlBlocked({ status: 402, message: yield* budget.refusal });
  }
  yield* budget.spent(1);
});

const dayMs = 86_400_000;

describe("process run", () => {
  const prisma = new PrismaService();
  const userId = `test-${crypto.randomUUID()}`;
  const contextKey = "test-context";
  let sourceIds: string[];

  const startRun = async (trigger: "MANUAL" | "SCHEDULED" = "MANUAL") => {
    const run = await prisma.run.create({
      data: { userId, trigger, contextKey, sourceIds },
    });
    return run.id;
  };

  const runWith = async (
    runId: string,
    options: {
      verdicts?: Record<string, Verdict>;
      preflight?: Effect.Effect<void, ModelUnsupported>;
      scrapeHealth?: Effect.Effect<void, LocalFirecrawlDown>;
      failAlerts?: boolean;
      resumeHash?: string;
      // Scores by job title (3 when missing), or the error the triage request fails with.
      triage?: Record<string, number> | OpenRouterRequestFailed | OpenRouterAuthError;
      // A cloud plan with these credits; without one the run is in local mode.
      cloud?: { remainingCredits: number; billingPeriodEnd: string | null };
    },
  ) => {
    const triaged: string[][] = [];
    const triage = TitleTriage.of({
      score: ({ jobs }) => {
        triaged.push(jobs.map(({ title }) => title));
        const scripted = options.triage ?? {};
        if (scripted instanceof Error) return Effect.fail(scripted);
        return Effect.succeed(
          jobs.map(({ id, title }) => ({ id, score: scripted[title] ?? 3, reason: null })),
        );
      },
    });
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
      scrapeMarkdown: () => Effect.die("unused"),
      scrapeJob: (url) =>
        Effect.sync(() => {
          scraped.push(url);
        }).pipe(
          Effect.andThen(spendCredit),
          Effect.as({
            markdown: `Page ${url}`,
            rawHtml: jobHtml[url] ?? null,
            usage: { via: "cloud", credits: 1 } as const,
          }),
        ),
      scrapeListingPage: (url, options) =>
        Effect.map(spendCredit, () => {
          scraped.push(url);
          // Every page embeds a Greenhouse board, which only a first check looks for.
          const embed = options?.withHtml ? ["https://job-boards.greenhouse.io/acme"] : [];
          const jobs = (listings[url] ?? []).map((job) => job.url);
          return {
            markdown: `Jobs at ${url}`,
            links: [...jobs, ...embed],
            rawHtml: null,
            siteName: null,
            usage: { via: "cloud", credits: 1 } as const,
          };
        }),
      map: () => Effect.die("unused"),
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
      Layer.succeed(TitleTriage, triage),
      Layer.succeed(
        ResumeSource,
        ResumeSource.of({
          resolve: () => Effect.succeed({ text: "Resume", hash: options.resumeHash ?? "resume-1" }),
        }),
      ),
      Layer.succeed(HttpFetch, fakeHttpFetch),
      Layer.succeed(PdfParser, fakePdfParser),
      Layer.effect(HostLimiter, makeHostLimiter(0)),
      Layer.succeed(ScrapeHealth, ScrapeHealth.of({ check: options.scrapeHealth ?? Effect.void })),
      Layer.succeed(
        FirecrawlPlan,
        FirecrawlPlan.of({
          mode: options.cloud ? "cloud" : "local",
          creditReserve: 50,
          creditUsage: Effect.succeed(options.cloud ?? null),
        }),
      ),
    );
    await Effect.runPromise(processRun(prisma, runId, "test/model").pipe(Effect.provide(layer)));
    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    return { run, evaluated, scraped, alerts, resumeHashes, triaged };
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

  it("stops before scraping when the local Firecrawl is down", async () => {
    const message = "Local Firecrawl is not running at http://localhost:3002";
    const { run, scraped } = await runWith(await startRun(), {
      scrapeHealth: Effect.fail(new LocalFirecrawlDown({ message })),
    });

    expect(scraped).toEqual([]);
    expect(run).toMatchObject({ status: "STOPPED", stopReason: message, found: 0 });
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

  it("uses the job pages' structured data", async () => {
    const source = await prisma.jobSource.create({ data: { userId, url: sourceD } });
    const run = await prisma.run.create({
      data: { userId, trigger: "MANUAL", contextKey, sourceIds: [source.id] },
    });
    const { run: finished, evaluated } = await runWith(run.id, {});

    // Only the open job in an accepted city is evaluated, from the posting's own ad.
    expect(evaluated).toEqual(["# Job 9\n\nExample · Bengaluru\n\nBuild APIs."]);
    expect(finished).toMatchObject({ status: "COMPLETED", eligible: 3, checked: 3, failed: 0 });
    const results = await prisma.jobResult.findMany({
      where: { runId: run.id },
      orderBy: { jobUrl: "asc" },
      select: { jobUrl: true, isMatch: true, reason: true, skipped: true, locations: true },
    });
    expect(results).toEqual([
      {
        jobUrl: jobUrl("7"),
        isMatch: null,
        reason: "The posting has closed (its page says it was valid until an earlier date)",
        skipped: "EXPIRED",
        locations: ["Bengaluru"],
      },
      {
        jobUrl: jobUrl("8"),
        isMatch: false,
        reason: "Doesn't meet your requirements (from the job page's structured data)",
        skipped: null,
        locations: ["Mumbai"],
      },
      {
        jobUrl: jobUrl("9"),
        isMatch: false,
        reason: "Missing skills",
        skipped: null,
        locations: ["Bengaluru"],
      },
    ]);

    // Settled jobs, expired ones included, are not read again in the same context.
    const again = await prisma.run.create({
      data: { userId, trigger: "MANUAL", contextKey, sourceIds: [source.id] },
    });
    const repeat = await runWith(again.id, {});
    expect(repeat.evaluated).toEqual([]);
    expect(repeat.run).toMatchObject({ status: "COMPLETED", checked: 0 });
  });

  it("keeps only titles that pass the keyword filters", async () => {
    await prisma.jobResult.deleteMany({ where: { userId } });
    await prisma.settings.update({
      where: { userId },
      data: { titleInclude: ["job"], titleExclude: ["3", "Job 4"] },
    });
    try {
      const { run, evaluated } = await runWith(await startRun(), {});
      expect(evaluated).toEqual([jobUrl("1"), jobUrl("5")]);
      expect(run).toMatchObject({ status: "COMPLETED", eligible: 2, checked: 2 });

      // The filters are part of the context, so changing them analyses jobs again.
      await prisma.settings.update({ where: { userId }, data: { titleExclude: ["3"] } });
      const changed = await runWith(await startRun(), {});
      expect(changed.evaluated).toEqual([jobUrl("1"), jobUrl("4"), jobUrl("5")]);
      expect(changed.run.contextKey).not.toBe(run.contextKey);
    } finally {
      await prisma.settings.update({
        where: { userId },
        data: { titleInclude: [], titleExclude: [] },
      });
    }
  });

  it("reads only the titles triage ranks as likely fits, best first", async () => {
    await prisma.jobResult.deleteMany({ where: { userId } });
    const triage = { "Job 1": 2, "Job 3": 1, "Job 4": 3, "Job 5": 0 };
    const { run, evaluated, triaged } = await runWith(await startRun(), { triage });

    expect(triaged).toEqual([["Job 1", "Job 3", "Job 4", "Job 5"]]);
    expect(evaluated).toEqual([jobUrl("4"), jobUrl("1")]);
    expect(run).toMatchObject({ status: "COMPLETED", eligible: 4, checked: 2, failed: 0 });
    const skipped = await prisma.jobResult.findMany({
      where: { runId: run.id, skipped: "TRIAGE" },
      orderBy: { jobUrl: "asc" },
      select: { jobUrl: true, isMatch: true, reason: true, error: true },
    });
    expect(skipped).toEqual([
      { jobUrl: jobUrl("3"), isMatch: null, reason: "Skipped by title triage", error: null },
      { jobUrl: jobUrl("5"), isMatch: null, reason: "Skipped by title triage", error: null },
    ]);

    // Rejected jobs are settled for this context, so they are not triaged again.
    const again = await runWith(await startRun(), { triage });
    expect(again.triaged).toEqual([]);
    expect(again.evaluated).toEqual([]);
  });

  it("limits the run to the best-ranked jobs", async () => {
    await prisma.jobResult.deleteMany({ where: { userId } });
    const triage = { "Job 1": 2, "Job 3": 2, "Job 4": 3, "Job 5": 3 };
    const { evaluated } = await runWith(await startRun(), { triage });
    expect(evaluated).toEqual([jobUrl("4"), jobUrl("5"), jobUrl("1")]);
  });

  it("checks jobs without triage when the triage request fails", async () => {
    await prisma.jobResult.deleteMany({ where: { userId } });
    const triage = new OpenRouterRequestFailed({ status: 500, message: "Upstream error" });
    const { run, evaluated } = await runWith(await startRun(), { triage });
    expect(evaluated).toEqual([jobUrl("1"), jobUrl("3"), jobUrl("4")]);
    expect(run).toMatchObject({ status: "COMPLETED", checked: 3 });
  });

  it("stops the run when triage is refused for the API key", async () => {
    await prisma.jobResult.deleteMany({ where: { userId } });
    const triage = new OpenRouterAuthError({ status: 401, message: "User not found." });
    const { run, evaluated } = await runWith(await startRun(), { triage });
    expect(evaluated).toEqual([]);
    expect(run).toMatchObject({ status: "STOPPED", stopReason: "User not found." });
  });

  it("skips triage when it is turned off", async () => {
    await prisma.jobResult.deleteMany({ where: { userId } });
    await prisma.settings.update({ where: { userId }, data: { triageEnabled: false } });
    try {
      const { evaluated, triaged } = await runWith(await startRun(), { triage: { "Job 1": 0 } });
      expect(triaged).toEqual([]);
      expect(evaluated).toEqual([jobUrl("1"), jobUrl("3"), jobUrl("4")]);
    } finally {
      await prisma.settings.update({ where: { userId }, data: { triageEnabled: true } });
    }
  });

  it("checks jobs triage rejected once triage is turned off", async () => {
    await prisma.jobResult.deleteMany({ where: { userId } });
    const triage = { "Job 1": 3, "Job 3": 0, "Job 4": 3, "Job 5": 3 };
    const first = await runWith(await startRun(), { triage });
    expect(first.evaluated).not.toContain(jobUrl("3"));

    await prisma.settings.update({ where: { userId }, data: { triageEnabled: false } });
    try {
      const { evaluated, triaged } = await runWith(await startRun(), {});
      expect(triaged).toEqual([]);
      expect(evaluated).toContain(jobUrl("3"));
      const result = await prisma.jobResult.findFirstOrThrow({
        where: { userId, jobUrl: jobUrl("3") },
      });
      expect(result).toMatchObject({ skipped: null, isMatch: false, error: null });
    } finally {
      await prisma.settings.update({ where: { userId }, data: { triageEnabled: true } });
    }
  });

  it("updates a match saved under another spelling of the job's URL", async () => {
    await prisma.jobResult.deleteMany({ where: { userId } });
    await prisma.match.deleteMany({ where: { userId, jobUrl: jobUrl("4") } });
    const oldUrl = "https://Jobs.example.com/4/?utm_source=feed";
    await prisma.match.create({
      data: {
        userId,
        jobUrl: oldUrl,
        title: "Job 4",
        company: "Example",
        reason: "Old",
        status: "APPLIED",
      },
    });
    await runWith(await startRun(), { verdicts: { [jobUrl("4")]: "match" } });

    const matches = await prisma.match.findMany({
      where: { userId, jobUrl: { in: [oldUrl, jobUrl("4")] } },
    });
    expect(matches).toMatchObject([{ jobUrl: oldUrl, status: "APPLIED", reason: "Strong fit" }]);
  });

  describe("with the credit guard", () => {
    const periodEnd = "2099-01-01T00:00:00.000Z";
    // Nothing cached, so every source and job page is scraped.
    const fresh = async () => {
      await prisma.jobResult.deleteMany({ where: { userId } });
      await prisma.pageCache.deleteMany({ where: { userId } });
    };

    it("stops a cloud run whose sources would not fit above the reserve", async () => {
      await fresh();
      const { run, scraped } = await runWith(await startRun(), {
        cloud: { remainingCredits: 51, billingPeriodEnd: periodEnd },
      });
      expect(scraped).toEqual([]);
      expect(run).toMatchObject({
        status: "STOPPED",
        stopReason: "Firecrawl credit reserve reached (51 left until 2099-01-01)",
      });
    });

    it("stops a cloud run once it has spent down to the reserve", async () => {
      await fresh();
      const { run, evaluated } = await runWith(await startRun(), {
        cloud: { remainingCredits: 54, billingPeriodEnd: periodEnd },
      });
      // Two credits for the sources, two for jobs; the third job would dip into the reserve.
      expect(evaluated).toEqual([jobUrl("1"), jobUrl("3")]);
      expect(run).toMatchObject({
        status: "STOPPED",
        stopReason: "Firecrawl credit reserve reached (50 left until 2099-01-01)",
        checked: 2,
      });
    });

    it("keeps a scheduled run to its daily share, counting cached pages as free", async () => {
      await fresh();
      // A cached page costs nothing, so job 4 fits after the share is spent.
      await prisma.pageCache.create({
        data: {
          userId,
          url: jobUrl("4"),
          kind: "JOB_PAGE",
          content: { markdown: `Page ${jobUrl("4")}`, posting: null },
        },
      });
      // 40 credits above the reserve over 10 days: 4 today, 2 of them for the sources.
      const end = new Date(Date.now() + 10 * dayMs - 60_000).toISOString();
      const { run, evaluated, scraped } = await runWith(await startRun("SCHEDULED"), {
        cloud: { remainingCredits: 90, billingPeriodEnd: end },
      });
      expect(evaluated).toEqual([jobUrl("1"), jobUrl("3"), jobUrl("4")]);
      expect(scraped).toEqual([sourceA, sourceB, jobUrl("1"), jobUrl("3")]);
      expect(run).toMatchObject({ status: "COMPLETED", checked: 3 });

      // A manual run may use more than the day's share.
      await fresh();
      const manual = await runWith(await startRun(), {
        cloud: { remainingCredits: 90, billingPeriodEnd: end },
      });
      expect(manual.evaluated).toEqual([jobUrl("1"), jobUrl("3"), jobUrl("4")]);
    });

    it("trims a scheduled run to nothing when today's share is spent", async () => {
      await fresh();
      const end = new Date(Date.now() + 10 * dayMs - 60_000).toISOString();
      const { run, evaluated } = await runWith(await startRun("SCHEDULED"), {
        cloud: { remainingCredits: 70, billingPeriodEnd: end },
      });
      expect(evaluated).toEqual([]);
      expect(run).toMatchObject({ status: "COMPLETED", checked: 0 });
    });
  });

  it("ignores a run that is no longer queued", async () => {
    const runId = await startRun();
    await prisma.run.update({ where: { id: runId }, data: { status: "STOPPED" } });
    const { run, scraped } = await runWith(runId, {});

    expect(scraped).toEqual([]);
    expect(run).toMatchObject({ status: "STOPPED", finishedAt: null });
  });
});
