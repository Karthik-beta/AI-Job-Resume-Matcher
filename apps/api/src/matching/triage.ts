import { OpenRouterClient } from "@effect/ai-openrouter";
import { Context, Effect, Layer, Schema } from "effect";
import { type CompletionError, jsonCompletion, openRouterLayer } from "./completion";
import { MatchOutputInvalid } from "./errors";
import type { Listing } from "./firecrawl";
import type { Routing } from "./routing";

export interface TriageJob {
  // A short index, unique within the request.
  readonly id: string;
  readonly title: string;
  readonly company: string;
  readonly location: string;
}

export interface TriageScore {
  readonly id: string;
  // 0 (unrelated) to 3 (strong fit).
  readonly score: number;
  readonly reason: string | null;
}

export interface TriageInput {
  readonly resume: string;
  readonly jobs: readonly TriageJob[];
}

// Ranks job titles against the resume in one cheap request, before any job page is read.
export class TitleTriage extends Context.Service<
  TitleTriage,
  {
    readonly score: (input: TriageInput) => Effect.Effect<readonly TriageScore[], CompletionError>;
  }
>()("TitleTriage") {}

// Jobs scoring below this are not read or evaluated.
export const triageThreshold = 2;
// Jobs per request; a typical run fits in one.
export const triageBatchSize = 150;
const resumeSummaryChars = 3_000;

export const resumeSummary = (resume: string) =>
  resume.replace(/\s+/g, " ").trim().slice(0, resumeSummaryChars);

export interface TriageResult {
  // Highest score first, in listing order within a score.
  readonly kept: readonly Listing[];
  readonly rejected: readonly { readonly listing: Listing; readonly reason: string | null }[];
}

// A job the model left out is kept with the threshold score, so it is still checked.
export const triageListings = (resume: string, listings: readonly Listing[]) =>
  Effect.gen(function* () {
    const triage = yield* TitleTriage;
    const summary = resumeSummary(resume);
    const scores = new Map<number, Omit<TriageScore, "id">>();
    for (let start = 0; start < listings.length; start += triageBatchSize) {
      const batch = listings.slice(start, start + triageBatchSize);
      const jobs = batch.map((listing, offset) => ({
        id: String(start + offset),
        title: listing.title,
        company: listing.company,
        location: listing.locations.join("; "),
      }));
      for (const { id, score, reason } of yield* triage.score({ resume: summary, jobs })) {
        const index = Number(id);
        const inBatch = Number.isInteger(index) && index >= start && index < start + batch.length;
        if (inBatch && !scores.has(index)) scores.set(index, { score, reason });
      }
    }
    const ranked = listings.map((listing, index) => ({
      listing,
      index,
      score: scores.get(index)?.score ?? triageThreshold,
      reason: scores.get(index)?.reason ?? null,
    }));
    return {
      kept: ranked
        .filter(({ score }) => score >= triageThreshold)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map(({ listing }) => listing),
      rejected: ranked
        .filter(({ score }) => score < triageThreshold)
        .map(({ listing, reason }) => ({ listing, reason })),
    } satisfies TriageResult;
  });

export const triagePrompt =
  "You screen job titles for a candidate before their job ads are read. For each job, " +
  "score how likely the candidate is to be a good fit from its title, company and " +
  "location alone: 3 = strong fit, 2 = plausible, 1 = unlikely, 0 = clearly unrelated " +
  "(another field, or far too senior or junior). When unsure, score 2. Give a short " +
  "reason for scores below 2. Return one score for every job id.";

export const triageJsonSchema = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "The job's id" },
          score: { type: "integer", enum: [0, 1, 2, 3], description: "Fit from 0 to 3" },
          reason: { type: ["string", "null"], description: "Why the score is below 2" },
        },
        required: ["id", "score", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["scores"],
  additionalProperties: false,
};

const TriageJson = Schema.Struct({
  scores: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      score: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
      reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(TriageJson));

export const decodeTriageOutput = (
  content: string | null | undefined,
  refusal?: string | null | undefined,
): Effect.Effect<readonly TriageScore[], MatchOutputInvalid> => {
  if (refusal) {
    return Effect.fail(new MatchOutputInvalid({ message: `Model refused: ${refusal}` }));
  }
  return decodeJson(content ?? "").pipe(
    Effect.map(({ scores }) =>
      scores.map(({ id, score, reason }) => ({ id, score, reason: reason?.trim() || null })),
    ),
    Effect.mapError(
      (error) => new MatchOutputInvalid({ message: `Invalid triage scores: ${error.message}` }),
    ),
  );
};

export const makeTitleTriage = (model: string, routing: Routing) =>
  Effect.gen(function* () {
    const openRouter = yield* OpenRouterClient.OpenRouterClient;
    return TitleTriage.of({
      score: ({ resume, jobs }) =>
        jsonCompletion(openRouter, {
          model,
          routing,
          purpose: "title triage",
          system: triagePrompt,
          user: `Resume summary:\n${resume}\n\nJobs:\n${JSON.stringify(jobs)}`,
          schemaName: "title_triage",
          schema: triageJsonSchema,
          // About 20 tokens a score for a full batch, on top of the reasoning tokens.
          maxTokens: 12_000,
        }).pipe(Effect.flatMap(({ content, refusal }) => decodeTriageOutput(content, refusal))),
    });
  });

export const titleTriageLayer = (options: {
  readonly apiKey: string;
  readonly model: string;
  readonly routing: Routing;
}) =>
  Layer.effect(TitleTriage, makeTitleTriage(options.model, options.routing)).pipe(
    Layer.provide(openRouterLayer(options.apiKey)),
  );
