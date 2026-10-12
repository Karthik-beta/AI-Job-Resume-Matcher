import { createHash } from "node:crypto";
import { OpenRouterClient } from "@effect/ai-openrouter";
import { Context, Effect, Layer } from "effect";
import { type CompletionError, jsonCompletion, openRouterLayer } from "./completion";
import { decodeMatchOutput, type MatchResult } from "./match-output";
import { checkAccess, type PreflightError } from "./preflight";
import type { Requirements } from "./requirements";
import type { Routing } from "./routing";

export const systemPrompt =
  "You are an expert job interviewer with decades of experience. Analyze the " +
  "resume and job posting to determine if the candidate is a good fit. Be " +
  "critical in your assessment and accept only applicants that meet at least " +
  "75% of the requirements.";

const requirementsGuidance =
  "Use the supplied candidate experience. Listed locations are acceptable " +
  "city names or aliases. Null target experience bounds mean no restriction " +
  "on that bound. The job's experience range must overlap the requested " +
  "range, and the candidate must meet its stated minimum. Reject jobs with " +
  "a conflicting location or experience requirement even if their skills " +
  "match. If details are unstated, explain what could not be verified; " +
  "do not assume a match. If include_unknown is false, reject jobs whose " +
  "requested location or experience cannot be verified.";

export const matchJsonSchema = {
  type: "object",
  properties: {
    is_match: {
      type: "boolean",
      description: "Whether the candidate is a good fit for the job (true/false)",
    },
    reason: {
      type: "string",
      description: "Brief explanation of why the candidate is or isn't a good fit",
    },
  },
  required: ["is_match", "reason"],
  additionalProperties: false,
};

export interface MatchInput {
  readonly resume: string;
  // sha256 hex of the resume text, when the caller already has it.
  readonly resumeHash?: string | undefined;
  readonly jobPage: string;
  readonly requirements?: Requirements | undefined;
}

export type EvaluateError = CompletionError;

export class MatchEvaluator extends Context.Service<
  MatchEvaluator,
  {
    readonly preflight: Effect.Effect<void, PreflightError>;
    readonly evaluate: (input: MatchInput) => Effect.Effect<MatchResult, EvaluateError>;
  }
>()("MatchEvaluator") {}

// Snake case keys, as in the Python app, because the guidance refers to include_unknown.
const requirementsJson = (requirements: Requirements) =>
  JSON.stringify({
    experience_years: requirements.experienceYears,
    experience_months: requirements.experienceMonths,
    job_min_years: requirements.jobMinYears,
    job_max_years: requirements.jobMaxYears,
    locations: requirements.locations,
    include_unknown: requirements.includeUnknown,
  });

// The job page goes last, so every job in a run shares the cached prompt prefix before it.
export const userPrompt = ({ resume, jobPage, requirements }: MatchInput) => {
  let content = `Resume:\n${resume}\n\n`;
  if (requirements) {
    content +=
      "User's job search requirements:\n" +
      `${requirementsJson(requirements)}\n${requirementsGuidance}\n\n`;
  }
  content += `Job Posting:\n${jobPage}\n\n`;
  return `${content}Determine if this candidate is a good fit and explain why briefly.`;
};

const promptCacheKey = ({ resume, resumeHash }: MatchInput) =>
  resumeHash ?? createHash("sha256").update(resume).digest("hex");

export const makeMatchEvaluator = (model: string, routing: Routing) =>
  Effect.gen(function* () {
    const openRouter = yield* OpenRouterClient.OpenRouterClient;

    return MatchEvaluator.of({
      preflight: checkAccess(openRouter.client.httpClient, model, routing),
      evaluate: (input) =>
        jsonCompletion(openRouter, {
          model,
          routing,
          purpose: "evaluation",
          system: systemPrompt,
          user: userPrompt(input),
          schemaName: "job_match",
          schema: matchJsonSchema,
          maxTokens: 2000,
          promptCacheKey: promptCacheKey(input),
        }).pipe(Effect.flatMap(decodeMatchOutput)),
    });
  });

export const matchEvaluatorLayer = (options: {
  readonly apiKey: string;
  readonly model: string;
  readonly routing: Routing;
}) =>
  Layer.effect(MatchEvaluator, makeMatchEvaluator(options.model, options.routing)).pipe(
    Layer.provide(openRouterLayer(options.apiKey)),
  );
