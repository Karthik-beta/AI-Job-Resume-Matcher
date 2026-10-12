import type { SourceKind } from "@job-matcher/shared";
import { Clock, Effect } from "effect";
import type { JobResult, PrismaClient } from "../generated/prisma/client";
import { contextKey as contextKeyOf } from "../matching/context-key";
import { canonicalUrl, dedupeListings } from "../matching/dedupe";
import { Notifier } from "../matching/discord";
import type { HttpFetch } from "../matching/download";
import { SaveFailed, stopsRun } from "../matching/errors";
import { MatchEvaluator } from "../matching/evaluate";
import type { Firecrawl, Listing } from "../matching/firecrawl";
import { evaluationText, isExpired, withPosting } from "../matching/job-posting";
import type { ListingExtractor } from "../matching/listing-extractor";
import { jobPageFor, type PageCacheStore, scrapeSourceListings } from "../matching/page-cache";
import type { PdfParser } from "../matching/pdf";
import { acceptsJob } from "../matching/requirements";
import { ResumeSource } from "../matching/resume-source";
import type { HostLimiter } from "../matching/sources/http";
import { acceptsTitle } from "../matching/title-filters";
import { type TitleTriage, triageListings } from "../matching/triage";
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

export const processRun = (prisma: PrismaClient, runId: string, model: string) => {
  const finish = (status: "COMPLETED" | "STOPPED" | "FAILED", stopReason: string | null = null) =>
    query(() =>
      prisma.run.update({
        where: { id: runId },
        data: { status, stopReason, finishedAt: new Date() },
      }),
    ).pipe(Effect.asVoid);

  return Effect.gen(function* () {
    // Only a queued run is claimed, so a duplicate delivery does nothing.
    const claimed = yield* query(() =>
      prisma.run.updateMany({
        where: { id: runId, status: "QUEUED" },
        data: { status: "RUNNING" },
      }),
    );
    if (claimed.count === 0) return;

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

    const prepared = yield* Effect.gen(function* () {
      yield* evaluator.preflight;
      const resume = yield* resumeSource.resolve(userId, resumeUrl);
      const listings: Listing[] = [];
      // As in dedupeListings, the first source to list a job page decides how its ad is read.
      const kindByUrl = new Map<string, SourceKind>();
      for (const sourceId of run.sourceIds) {
        const source = sources.find(({ id }) => id === sourceId);
        if (!source) continue;
        const {
          listings: found,
          embedded,
          listingHash,
        } = yield* scrapeSourceListings(userId, source);
        for (const { url } of found) {
          const canonical = canonicalUrl(url);
          if (!kindByUrl.has(canonical)) kindByUrl.set(canonical, source.kind);
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
    // Nothing can be analysed without the resume and listings, so every error here stops the run.
    if (prepared._tag === "Failure") return yield* finish("STOPPED", prepared.failure.message);
    const { resume, listings, kindByUrl } = prepared.success;

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
    const selected = ranked.slice(0, settings.maxJobsPerRun);

    for (const job of selected) {
      const outcome = yield* jobPageFor(userId, job, kindByUrl.get(job.url) ?? "PAGE").pipe(
        Effect.flatMap((page) =>
          Effect.gen(function* () {
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

      const fields = { runId, ...listing, ...result, matchSaved };
      yield* query(() =>
        prisma.$transaction([
          prisma.jobResult.upsert({
            where: { userId_contextKey_jobUrl: { userId, contextKey, jobUrl: job.url } },
            create: { userId, contextKey, jobUrl: job.url, ...fields },
            update: fields,
          }),
          prisma.run.update({
            where: { id: runId },
            data: { checked: { increment: 1 }, failed: { increment: failed ? 1 : 0 } },
          }),
        ]),
      );

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
