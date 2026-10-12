import type { SourceKind } from "@job-matcher/shared";
import { Effect } from "effect";
import type { PrismaClient } from "../generated/prisma/client";
import { contextKey as contextKeyOf } from "../matching/context-key";
import { Notifier } from "../matching/discord";
import type { HttpFetch } from "../matching/download";
import { SaveFailed, stopsRun } from "../matching/errors";
import { MatchEvaluator } from "../matching/evaluate";
import type { Firecrawl, Listing } from "../matching/firecrawl";
import { jobPageFor, type PageCacheStore, scrapeSourceListings } from "../matching/page-cache";
import type { PdfParser } from "../matching/pdf";
import { acceptsJob } from "../matching/requirements";
import { ResumeSource } from "../matching/resume-source";
import type { HostLimiter } from "../matching/sources/http";
import { requirementsOf } from "./run-settings";
import { type MatchFields, upsertMatch } from "./save-match";

export type RunServices =
  | Firecrawl
  | PageCacheStore
  | HttpFetch
  | HostLimiter
  | PdfParser
  | ResumeSource
  | MatchEvaluator
  | Notifier;

const query = <A>(run: () => Promise<A>) => Effect.promise(run);

// Sources keep their first listing for a URL, as in the Python app.
const uniqueByUrl = (listings: readonly Listing[]) => {
  const byUrl = new Map<string, Listing>();
  for (const listing of listings) if (!byUrl.has(listing.url)) byUrl.set(listing.url, listing);
  return [...byUrl.values()];
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
      // Like uniqueByUrl, the first source to list a URL decides how its job ad is read.
      const kindByUrl = new Map<string, SourceKind>();
      for (const sourceId of run.sourceIds) {
        const source = sources.find(({ id }) => id === sourceId);
        if (!source) continue;
        const found = yield* scrapeSourceListings(userId, source);
        for (const { url } of found) if (!kindByUrl.has(url)) kindByUrl.set(url, source.kind);
        listings.push(...found);
        yield* query(() =>
          prisma.jobSource.update({
            where: { id: source.id },
            data: { lastCheckedAt: new Date() },
          }),
        );
      }
      return { resume, listings: uniqueByUrl(listings), kindByUrl };
    }).pipe(Effect.result);
    // Nothing can be analysed without the resume and listings, so every error here stops the run.
    if (prepared._tag === "Failure") return yield* finish("STOPPED", prepared.failure.message);
    const { resume, listings, kindByUrl } = prepared.success;

    const eligible = listings.filter((listing) => acceptsJob(requirements, listing));
    // The run was created before the resume content was known, so its key is replaced here.
    const contextKey = contextKeyOf({
      resumeHash: resume.hash,
      sourceIds: run.sourceIds,
      model,
      requirements,
    });
    yield* query(() =>
      prisma.run.update({
        where: { id: runId },
        data: { contextKey, found: listings.length, eligible: eligible.length },
      }),
    );
    const analysed = yield* query(() =>
      prisma.jobResult.findMany({
        where: { userId, contextKey, error: null, jobUrl: { in: eligible.map(({ url }) => url) } },
        select: { jobUrl: true },
      }),
    );
    const done = new Set(analysed.map(({ jobUrl }) => jobUrl));
    const selected = eligible.filter(({ url }) => !done.has(url)).slice(0, settings.maxJobsPerRun);

    for (const job of selected) {
      const outcome = yield* jobPageFor(userId, job, kindByUrl.get(job.url) ?? "PAGE").pipe(
        Effect.flatMap((jobPage) =>
          evaluator.evaluate({
            resume: resume.text,
            resumeHash: resume.hash,
            jobPage,
            requirements,
          }),
        ),
        Effect.result,
      );
      if (outcome._tag === "Failure" && stopsRun(outcome.failure)) {
        return yield* finish("STOPPED", outcome.failure.message);
      }

      const result =
        outcome._tag === "Success"
          ? { isMatch: outcome.success.isMatch, reason: outcome.success.reason, error: null }
          : { isMatch: null, reason: null, error: outcome.failure.message };
      const listing = {
        title: job.title,
        company: job.company,
        locations: [...job.locations],
        expMinYears: job.experienceMinYears,
        expMaxYears: job.experienceMaxYears,
      };
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
