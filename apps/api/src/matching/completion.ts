import { OpenRouterClient } from "@effect/ai-openrouter";
import { Effect, Layer, Redacted, Schedule } from "effect";
import type * as AiError from "effect/ai/AiError";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import {
  MatchOutputInvalid,
  type OpenRouterAuthError,
  OpenRouterRequestFailed,
  OpenRouterUnavailable,
  openRouterErrorFromStatus,
} from "./errors";
import type { MatchCompletion } from "./match-output";
import { priceCapText, type Routing } from "./routing";

export type CompletionError =
  | OpenRouterAuthError
  | OpenRouterUnavailable
  | OpenRouterRequestFailed
  | MatchOutputInvalid;

export interface JsonCompletionRequest {
  readonly model: string;
  readonly routing: Routing;
  // Names the request in log messages, e.g. "evaluation".
  readonly purpose: string;
  readonly system: string;
  readonly user: string;
  readonly schemaName: string;
  readonly schema: Record<string, unknown>;
  readonly maxTokens: number;
  readonly promptCacheKey?: string | undefined;
}

// OpenRouter answers a request no endpoint can serve, such as one over max_price, with a 404
// ("No endpoints found…", "No allowed providers…") or a 503 ("…meets your routing requirements").
const priceCapMessage = "No flex endpoint under the price cap";
const noEndpointStatuses: ReadonlySet<number> = new Set([404, 503]);
const noEndpointPattern = /price|no endpoints|no allowed providers|routing requirements/i;

const toCompletionError = (routing: Routing) => (error: AiError.AiError) => {
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

// One chat completion with a strict JSON schema, routed as configured (flex by default).
export const jsonCompletion = (
  openRouter: OpenRouterClient.OpenRouterClient["Service"],
  request: JsonCompletionRequest,
): Effect.Effect<MatchCompletion, CompletionError> => {
  const { routing } = request;
  return openRouter
    .createChatCompletion({
      model: request.model,
      stream: false,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: request.schemaName, strict: true, schema: request.schema },
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
      max_completion_tokens: request.maxTokens,
      ...(request.promptCacheKey === undefined ? {} : { prompt_cache_key: request.promptCacheKey }),
    })
    .pipe(
      Effect.provideService(FetchHttpClient.RequestInit, completionRequestInit),
      Effect.mapError(toCompletionError(routing)),
      Effect.retry({
        schedule: Schedule.exponential("1 minute"),
        times: capacityRetries,
        while: isCapacityError,
      }),
      // Out of retries, only this request fails.
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
              `OpenRouter served the ${request.purpose} on the ${body.service_tier} tier, not flex.`,
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
        return Effect.succeed({ content: typeof content === "string" ? content : null, refusal });
      }),
    );
};

export const openRouterLayer = (apiKey: string) =>
  OpenRouterClient.layer({ apiKey: Redacted.make(apiKey) }).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
