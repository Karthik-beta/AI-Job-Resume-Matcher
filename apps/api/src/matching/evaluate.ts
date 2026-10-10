import { OpenRouterClient } from "@effect/ai-openrouter";
import { Context, Effect, Layer, Redacted } from "effect";
import type * as AiError from "effect/ai/AiError";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import {
  MatchOutputInvalid,
  type OpenRouterAuthError,
  OpenRouterRequestFailed,
  type OpenRouterUnavailable,
  openRouterErrorFromStatus,
} from "./errors";
import { decodeMatchOutput, type MatchResult } from "./match-output";
import { checkAccess, type PreflightError } from "./preflight";
import type { Requirements } from "./requirements";

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
  readonly jobPage: string;
  readonly requirements?: Requirements | undefined;
}

export type EvaluateError =
  | OpenRouterAuthError
  | OpenRouterUnavailable
  | OpenRouterRequestFailed
  | MatchOutputInvalid;

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

export const userPrompt = ({ resume, jobPage, requirements }: MatchInput) => {
  let content = `Resume:\n${resume}\n\nJob Posting:\n${jobPage}\n\n`;
  if (requirements) {
    content +=
      "User's job search requirements:\n" +
      `${requirementsJson(requirements)}\n${requirementsGuidance}\n\n`;
  }
  return `${content}Determine if this candidate is a good fit and explain why briefly.`;
};

const toEvaluateError = (error: AiError.AiError) => {
  const { reason } = error;
  const status = "http" in reason ? reason.http?.response?.status : undefined;
  return status === undefined
    ? new OpenRouterRequestFailed({ status: null, message: error.message })
    : openRouterErrorFromStatus(status, error.message);
};

export const makeMatchEvaluator = (model: string) =>
  Effect.gen(function* () {
    const openRouter = yield* OpenRouterClient.OpenRouterClient;

    return MatchEvaluator.of({
      preflight: checkAccess(openRouter.client.httpClient, model),
      evaluate: (input) =>
        openRouter
          .createChatCompletion({
            model,
            temperature: 0,
            stream: false,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt(input) },
            ],
            response_format: {
              type: "json_schema",
              json_schema: { name: "job_match", strict: true, schema: matchJsonSchema },
            },
            provider: { require_parameters: true },
          })
          .pipe(
            Effect.mapError(toEvaluateError),
            Effect.flatMap(([body]) => {
              const choice = body.choices[0];
              if (!choice) {
                return Effect.fail(
                  new MatchOutputInvalid({ message: "OpenRouter returned no completion choices." }),
                );
              }
              if (choice.finish_reason !== "stop") {
                return Effect.fail(
                  new MatchOutputInvalid({
                    message: `OpenRouter completion did not finish: ${choice.finish_reason}`,
                  }),
                );
              }
              const { content, refusal } = choice.message;
              return decodeMatchOutput({
                content: typeof content === "string" ? content : null,
                refusal,
              });
            }),
          ),
    });
  });

export const matchEvaluatorLayer = (options: { readonly apiKey: string; readonly model: string }) =>
  Layer.effect(MatchEvaluator, makeMatchEvaluator(options.model)).pipe(
    Layer.provide(OpenRouterClient.layer({ apiKey: Redacted.make(options.apiKey) })),
    Layer.provide(FetchHttpClient.layer),
  );
