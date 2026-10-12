import { createHash } from "node:crypto";
import { OpenRouterClient } from "@effect/ai-openrouter";
import { Context, Effect, Layer, Redacted, Schedule } from "effect";
import type * as AiError from "effect/ai/AiError";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import {
  MatchOutputInvalid,
  type OpenRouterAuthError,
  OpenRouterRequestFailed,
  OpenRouterUnavailable,
  openRouterErrorFromStatus,
} from "./errors";
import { decodeMatchOutput, type MatchResult } from "./match-output";
import { checkAccess, type PreflightError } from "./preflight";
import type { Requirements } from "./requirements";
import { priceCapText, type Routing } from "./routing";

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

// OpenRouter answers a request no endpoint can serve, such as one over max_price, with a 404
// ("No endpoints found…", "No allowed providers…") or a 503 ("…meets your routing requirements").
const priceCapMessage = "No flex endpoint under the price cap";
const noEndpointStatuses: ReadonlySet<number> = new Set([404, 503]);
const noEndpointPattern = /price|no endpoints|no allowed providers|routing requirements/i;

const toEvaluateError = (routing: Routing) => (error: AiError.AiError) => {
  const { reason } = error;
  const status = "http" in reason ? reason.http?.response?.status : undefined;
  if (status === undefined) {
    return new OpenRouterRequestFailed({ status: null, message: error.message });
  }
  if (noEndpointStatuses.has(status) && noEndpointPattern.test(error.message)) {
    return new OpenRouterUnavailable({
      status,
      message: `${priceCapMessage} (${priceCapText(routing)}): ${error.message}`,
    });
  }
  return openRouterErrorFromStatus(status, error.message);
};

// Flex capacity comes and goes, so 429 and 503 back off for 1, 2, 4, 8 and 16 minutes.
// OpenRouter's error body is not checked to tell a key rate limit from missing flex
// capacity, so every 429 backs off.
const capacityRetries = 5;

// A 503 can also mean no endpoint meets the price cap, which waiting won't fix.
const isCapacityError = (error: { readonly status: number | null; readonly message: string }) =>
  (error.status === 429 || error.status === 503) && !error.message.startsWith(priceCapMessage);

// Bun's fetch drops a connection that is idle for 5 minutes, and flex completions can take longer.
export const completionRequestInit: BunFetchRequestInit = { timeout: 15 * 60 * 1000 };

export const makeMatchEvaluator = (model: string, routing: Routing) =>
  Effect.gen(function* () {
    const openRouter = yield* OpenRouterClient.OpenRouterClient;

    return MatchEvaluator.of({
      preflight: checkAccess(openRouter.client.httpClient, model, routing),
      evaluate: (input) =>
        openRouter
          .createChatCompletion({
            model,
            stream: false,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt(input) },
            ],
            response_format: {
              type: "json_schema",
              json_schema: { name: "job_match", strict: true, schema: matchJsonSchema },
            },
            service_tier: routing.serviceTier,
            provider: {
              only: routing.providers,
              allow_fallbacks: false,
              require_parameters: true,
              max_price: {
                prompt: String(routing.maxPrice.prompt),
                completion: String(routing.maxPrice.completion),
              },
            },
            reasoning: { effort: routing.reasoningEffort },
            max_completion_tokens: 2000,
            prompt_cache_key: promptCacheKey(input),
          })
          .pipe(
            Effect.provideService(FetchHttpClient.RequestInit, completionRequestInit),
            Effect.mapError(toEvaluateError(routing)),
            Effect.retry({
              schedule: Schedule.exponential("1 minute"),
              times: capacityRetries,
              while: isCapacityError,
            }),
            // Out of retries, only this job fails and the run moves on.
            Effect.mapError((error) =>
              isCapacityError(error)
                ? new OpenRouterRequestFailed({
                    status: error.status,
                    message:
                      `OpenRouter flex capacity unavailable after ${capacityRetries} retries: ` +
                      error.message,
                  })
                : error,
            ),
            Effect.tap(([body]) =>
              routing.serviceTier === "flex" && body.service_tier && body.service_tier !== "flex"
                ? Effect.logWarning(
                    `OpenRouter served the evaluation on the ${body.service_tier} tier, not flex.`,
                  )
                : Effect.void,
            ),
            Effect.tap(([{ usage }]) =>
              usage
                ? Effect.logInfo(
                    `OpenRouter usage: ${usage.prompt_tokens} prompt tokens ` +
                      `(${usage.prompt_tokens_details?.cached_tokens ?? 0} cached), ` +
                      `${usage.completion_tokens} completion tokens`,
                  )
                : Effect.void,
            ),
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

export const matchEvaluatorLayer = (options: {
  readonly apiKey: string;
  readonly model: string;
  readonly routing: Routing;
}) =>
  Layer.effect(MatchEvaluator, makeMatchEvaluator(options.model, options.routing)).pipe(
    Layer.provide(OpenRouterClient.layer({ apiKey: Redacted.make(options.apiKey) })),
    Layer.provide(FetchHttpClient.layer),
  );
