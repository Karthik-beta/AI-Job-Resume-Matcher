import type { SourceKind } from "@job-matcher/shared";
import { Clock, Effect } from "effect";
import type { JobResult, PrismaClient } from "../generated/prisma/client";
import { contextKey as contextKeyOf } from "../matching/context-key";
import {
  fitJobs,
  jobCredits,
  makeRunCredits,
  type RunCredits,
  sourceCredits,
  startOfUtcDay,
} from "../matching/credit-guard";
import { canonicalUrl, dedupeListings } from "../matching/dedupe";
import { Notifier } from "../matching/discord";
import type { HttpFetch } from "../matching/download";
import { FirecrawlBlocked, SaveFailed, stopsRun } from "../matching/errors";
import { MatchEvaluator } from "../matching/evaluate";
import type { Firecrawl, Listing } from "../matching/firecrawl";
import { evaluationText, isExpired, withPosting } from "../matching/job-posting";
import type { ListingExtractor } from "../matching/listing-extractor";
import {
  jobPageFor,
  type PageCacheStore,
  type ScrapeVia,
  scrapeSourceListings,
} from "../matching/page-cache";
import type { PdfParser } from "../matching/pdf";
import { acceptsJob } from "../matching/requirements";
import { ResumeSource } from "../matching/resume-source";
import { FirecrawlPlan, RunCloudBudget, ScrapeHealth } from "../matching/scrape-router";
import type { HostLimiter } from "../matching/sources/http";
import { listingKind } from "../matching/sources/search";
import { acceptsTitle } from "../matching/title-filters";
import { type TitleTriage, triageListings } from "../matching/triage";
import { failActiveRun } from "./recover-run";
import { requirementsOf, titleFiltersOf } from "./run-settings";
import { type MatchFields, upsertMatch } from "./save-match";

export type RunServices =
  | Firecrawl
  | PageCacheStore
  | HttpFetch
  | HostLimiter
  | ListingExtractor
  | PdfParser
  | ResumeSource
  | ScrapeHealth
  | FirecrawlPlan
  | MatchEvaluator
  | TitleTriage
  | Notifier;

const query = <A>(run: () => Promise<A>) => Effect.promise(run);

const triageReason = "Skipped by title triage";

// The listing details a JobResult keeps.
const resultListing = (job: Listing) => ({
  title: job.title,
  company: job.company,
  locations: [...job.locations],
  expMinYears: job.experienceMinYears,
  expMaxYears: job.experienceMaxYears,
});

type Verdict = Pick<JobResult, "isMatch" | "reason" | "skipped">;

const expired: Verdict = {
  isMatch: null,
  reason: "The posting has closed (its page says it was valid until an earlier date)",
  skipped: "EXPIRED",
};

// Recorded as a non-match: the job is settled for this context, like any other verdict.
const unsuitable: Verdict = {
  isMatch: false,
  reason: "Doesn't meet your requirements (from the job page's structured data)",
  skipped: null,
};

const saveMatch = (prisma: PrismaClient, userId: string, match: MatchFields) =>
  Effect.tryPromise({
    try: () => upsertMatch(prisma, userId, match),
    catch: (cause) =>
      new SaveFailed({
        message: `Could not save the match: ${cause instanceof Error ? cause.message : cause}`,
      }),
  });

// The cloud credits the user's other scheduled runs have spent since midnight (UTC).
const scheduledSpendToday = (prisma: PrismaClient, userId: string, runId: string) =>
  Effect.gen(function* () {
    const since = startOfUtcDay(yield* Clock.currentTimeMillis);
    const { _sum } = yield* query(() =>
      prisma.run.aggregate({
        where: { userId, trigger: "SCHEDULED", id: { not: runId }, createdAt: { gte: since } },
        _sum: { cloudCredits: true },
      }),
    );
    return _sum.cloudCredits ?? 0;
  });

// Every cloud request in the run is counted against its credit allowance (see credit-guard.ts).
export const processRun = (prisma: PrismaClient, runId: string, model: string) =>
  Effect.gen(function* () {
    const credits = yield* makeRunCredits;
    return yield* runWith(prisma, runId, model, credits).pipe(
      Effect.provideService(RunCloudBudget, credits.budget),
    );
  });

const runWith = (prisma: PrismaClient, runId: string, model: string, credits: RunCredits) => {
  const finish = (status: "COMPLETED" | "STOPPED" | "FAILED", stopReason: string | null = null) =>
    Effect.gen(function* () {
      const cloudCredits = yield* credits.spent;
      // Only a running run is ended, so a run already ended by recovery keeps its reason.
      yield* query(() =>
        prisma.run.updateMany({
          where: { id: runId, status: "RUNNING" },
          data: { status, stopReason, cloudCredits, finishedAt: new Date() },
        }),
      );
    });

  // A worker that lost its job while still alive stops once recovery has ended its run, so it
  // spends no more credits on it and does not run alongside a newer run.
  const stillRunning = query(() =>
    prisma.run.findUniqueOrThrow({ where: { id: runId }, select: { status: true } }),
  ).pipe(Effect.map(({ status }) => status === "RUNNING"));

  return Effect.gen(function* () {
    // Only a queued run is claimed, so a duplicate delivery does nothing.
    const claimed = yield* query(() =>
      prisma.run.updateMany({
        where: { id: runId, status: "QUEUED" },
        data: { status: "RUNNING" },
      }),
    );
    if (claimed.count === 0) {
      // BullMQ delivers a run's job again only after the worker running it lost its lock (it
      // stopped, or stalled long enough to be considered stopped), so a run still RUNNING here was
      // interrupted. It ends instead of resuming, which could analyse the same jobs twice; a
      // completed or stopped run stays as it is.
      yield* query(() => failActiveRun(prisma, runId));
      return;
    }

    const run = yield* query(() => prisma.run.findUniqueOrThrow({ where: { id: runId } }));
    const { userId } = run;
    const settings = yield* query(() => prisma.settings.findUnique({ where: { userId } }));
    const resumeUrl = settings?.resumeUrl;
    if (!settings || !resumeUrl) {
      return yield* finish("STOPPED", "Add a resume URL in settings before starting a run");
    }
    const requirements = requirementsOf(settings);
    const titleFilters = titleFiltersOf(settings);
    const sources = yield* query(() =>
      prisma.jobSource.findMany({ where: { userId, id: { in: run.sourceIds } } }),
    );
    const evaluator = yield* MatchEvaluator;
    const notifier = yield* Notifier;
    const resumeSource = yield* ResumeSource;
    const scrapeHealth = yield* ScrapeHealth;
    const { mode } = yield* FirecrawlPlan;
    const scheduled = run.trigger === "SCHEDULED";

    const prepared = yield* Effect.gen(function* () {
      yield* evaluator.preflight;
      yield* scrapeHealth.check;
      // The user's scheduled runs share one allowance per UTC day (see credit-guard.ts).
      const spentToday = scheduled ? yield* scheduledSpendToday(prisma, userId, runId) : 0;
      const allowance = yield* credits.start(scheduled, spentToday);
      if (allowance) {
        yield* query(() =>
          prisma.run.update({
            where: { id: runId },
            data: { cloudCreditsAtStart: allowance.remaining },
          }),
        );
      }
      // A cloud run stops up front when even its sources would not fit.
      if (allowance && mode === "cloud") {
        let needed = 0;
        for (const source of sources) needed += yield* sourceCredits(userId, source, mode);
        if (needed > allowance.limit) {
          return yield* new FirecrawlBlocked({
            status: 402,
            message: yield* credits.budget.refusal,
          });
        }
      }
      const resume = yield* resumeSource.resolve(userId, resumeUrl);
      const listings: Listing[] = [];
      // As in dedupeListings, the first source to list a job page decides how its ad is read.
      const kindByUrl = new Map<string, SourceKind>();
      for (const sourceId of run.sourceIds) {
        const source = sources.find(({ id }) => id === sourceId);
        if (!source) continue;
        if (!(yield* stillRunning)) return null;
        const read = yield* scrapeSourceListings(userId, source).pipe(Effect.result);
        if (read._tag === "Failure") {
          // A search that cannot run (no cloud credits in hybrid mode, or no SearXNG in local
          // mode) skips just that source; errors that stop the run still stop it.
          if (source.kind === "SEARCH" && !stopsRun(read.failure)) {
            yield* Effect.logWarning(
              `Run ${runId} skips search source ${source.id}: ${read.failure.message}`,
            );
            continue;
          }
          return yield* read.failure;
        }
        const { listings: found, embedded, listingHash } = read.success;
        for (const { url } of found) {
          const canonical = canonicalUrl(url);
          if (!kindByUrl.has(canonical)) kindByUrl.set(canonical, listingKind(source.kind, url));
        }
        listings.push(...found);
        // A page that embeds an ATS board is offered as a switch on the sources page.
        const suggestion = embedded
          ? { suggestedKind: embedded.kind, suggestedAdapterKey: embedded.adapterKey }
          : {};
        yield* query(() =>
          prisma.jobSource.update({
            where: { id: source.id },
            data: {
              lastCheckedAt: new Date(),
              ...suggestion,
              ...(listingHash ? { listingHash } : {}),
            },
          }),
        );
      }
      return { resume, listings: dedupeListings(listings), kindByUrl };
    }).pipe(Effect.result);
    // Nothing can be analysed without the resume and listings, so every error here stops the
    // run (except a failing search source, skipped above).
    if (prepared._tag === "Failure") return yield* finish("STOPPED", prepared.failure.message);
    if (prepared.success === null) return;
    const { resume, listings, kindByUrl } = prepared.success;
    const kindOf = (job: Listing) => kindByUrl.get(canonicalUrl(job.url)) ?? "PAGE";

    const eligible = listings.filter(
      (listing) => acceptsJob(requirements, listing) && acceptsTitle(titleFilters, listing.title),
    );
    // The run was created before the resume content was known, so its key is replaced here.
    const contextKey = contextKeyOf({
      resumeHash: resume.hash,
      sourceIds: run.sourceIds,
      model,
      requirements,
      titleFilters,
    });
    yield* query(() =>
      prisma.run.update({
        where: { id: runId },
        data: { contextKey, found: listings.length, eligible: eligible.length },
      }),
    );
    const analysed = yield* query(() =>
      prisma.jobResult.findMany({
        where: {
          userId,
          contextKey,
          error: null,
          jobUrl: { in: eligible.map(({ url }) => url) },
          // With triage off every eligible job is checked, including ones triage once rejected.
          ...(settings.triageEnabled
            ? {}
            : { OR: [{ skipped: null }, { skipped: { not: "TRIAGE" as const } }] }),
        },
        select: { jobUrl: true },
      }),
    );
    // Skipped jobs (expired, or rejected by triage while it is on) are settled too.
    const done = new Set(analysed.map(({ jobUrl }) => jobUrl));
    const pending = eligible.filter(({ url }) => !done.has(url));

    let ranked: readonly Listing[] = pending;
    if (settings.triageEnabled && pending.length > 0) {
      if (!(yield* stillRunning)) return;
      const triaged = yield* triageListings(resume.text, pending).pipe(Effect.result);
      if (triaged._tag === "Failure") {
        if (stopsRun(triaged.failure)) return yield* finish("STOPPED", triaged.failure.message);
        // Triage only saves credits, so the run goes on without it.
        yield* Effect.logWarning(`Title triage failed: ${triaged.failure.message}`);
      } else {
        ranked = triaged.success.kept;
        // Recorded without a verdict, so they are shown on the run page and not triaged again.
        yield* query(() =>
          prisma.$transaction(
            triaged.success.rejected.map(({ listing: job, reason }) => {
              const fields = {
                runId,
                ...resultListing(job),
                isMatch: null,
                reason: reason ? `${triageReason}: ${reason}` : triageReason,
                error: null,
                skipped: "TRIAGE" as const,
                matchSaved: false,
              };
              return prisma.jobResult.upsert({
                where: { userId_contextKey_jobUrl: { userId, contextKey, jobUrl: job.url } },
                create: { userId, contextKey, jobUrl: job.url, ...fields },
                update: fields,
              });
            }),
          ),
        );
      }
    }
    let selected = ranked.slice(0, settings.maxJobsPerRun);
    // A scheduled run keeps to what is left of today's share; jobs read for free always fit.
    const left = yield* credits.left;
    if (scheduled && left !== null) {
      const costs: number[] = [];
      for (const job of selected) {
        costs.push(yield* jobCredits(userId, job, kindOf(job), mode));
      }
      const fitting = fitJobs(selected, costs, left);
      if (fitting.length < selected.length) {
        yield* Effect.logInfo(
          `Run ${runId} checks ${fitting.length} of ${selected.length} jobs to keep to today's Firecrawl credits.`,
        );
      }
      selected = fitting;
    }

    for (const job of selected) {
      // Kept when the evaluation fails after the page was read.
      let scrapedVia: ScrapeVia | null = null;
      const outcome = yield* jobPageFor(userId, job, kindOf(job)).pipe(
        Effect.flatMap((page) =>
          Effect.gen(function* () {
            scrapedVia = page.via;
            const enriched = withPosting(job, page.posting);
            if (isExpired(page.posting, yield* Clock.currentTimeMillis)) {
              return { enriched, verdict: expired };
            }
            // The page can say what the listing did not, such as its location.
            if (!acceptsJob(requirements, enriched)) return { enriched, verdict: unsuitable };
            const verdict = yield* evaluator.evaluate({
              resume: resume.text,
              resumeHash: resume.hash,
              jobPage: evaluationText(enriched, page),
              requirements,
            });
            return { enriched, verdict: { ...verdict, skipped: null } };
          }),
        ),
        Effect.result,
      );
      if (outcome._tag === "Failure" && stopsRun(outcome.failure)) {
        return yield* finish("STOPPED", outcome.failure.message);
      }

      const result =
        outcome._tag === "Success"
          ? { ...outcome.success.verdict, error: null }
          : { isMatch: null, reason: null, skipped: null, error: outcome.failure.message };
      const listing = resultListing(outcome._tag === "Success" ? outcome.success.enriched : job);
      // A failed save keeps the verdict without an error, so the job is not analysed again
      // and the match can be saved later from the run page.
      const saved =
        result.isMatch === true
          ? yield* saveMatch(prisma, userId, {
              jobUrl: job.url,
              ...listing,
              reason: result.reason ?? "",
            }).pipe(Effect.result)
          : null;
      const matchSaved = saved?._tag === "Success";
      const failed = result.error !== null || saved?._tag === "Failure";

      const fields = { runId, ...listing, ...result, matchSaved, scrapedVia };
      const cloudCredits = yield* credits.spent;
      // The result is saved only while the run is RUNNING, so a worker whose run recovery has
      // ended stops here (see stillRunning).
      const recorded = yield* query(() =>
        prisma.$transaction(async (tx) => {
          const { count } = await tx.run.updateMany({
            where: { id: runId, status: "RUNNING" },
            data: {
              checked: { increment: 1 },
              failed: { increment: failed ? 1 : 0 },
              cloudCredits,
            },
          });
          if (count === 0) return false;
          await tx.jobResult.upsert({
            where: { userId_contextKey_jobUrl: { userId, contextKey, jobUrl: job.url } },
            create: { userId, contextKey, jobUrl: job.url, ...fields },
            update: fields,
          });
          return true;
        }),
      );
      if (!recorded) return;

      // A failed alert is only logged; the match is already saved.
      if (matchSaved && settings.discordWebhookUrl) {
        yield* notifier
          .notifyMatch(settings.discordWebhookUrl, {
            title: job.title,
            company: job.company,
            jobUrl: job.url,
            reason: result.reason ?? "",
          })
          .pipe(Effect.catchTag("NotifyFailed", (error) => Effect.logWarning(error.message)));
      }
    }

    yield* finish("COMPLETED");
  }).pipe(Effect.onError(() => finish("FAILED", "The run failed unexpectedly").pipe(Effect.exit)));
};
