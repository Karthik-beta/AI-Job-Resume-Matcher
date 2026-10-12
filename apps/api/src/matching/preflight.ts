import { Effect, Option, Schema } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import {
  ManagementKeyError,
  ModelUnsupported,
  type OpenRouterAuthError,
  OpenRouterRequestFailed,
  type OpenRouterUnavailable,
  openRouterErrorFromStatus,
} from "./errors";
import { priceCapText, type Routing } from "./routing";

const requiredParameters = ["response_format", "structured_outputs"];

const KeyResponse = Schema.Struct({
  data: Schema.Struct({
    is_management_key: Schema.optionalKey(Schema.Boolean),
    is_provisioning_key: Schema.optionalKey(Schema.Boolean),
  }),
});

const EndpointsResponse = Schema.Struct({
  data: Schema.Struct({
    endpoints: Schema.Array(
      Schema.Struct({
        provider_name: Schema.optionalKey(Schema.String),
        tag: Schema.optionalKey(Schema.String),
        // USD per token.
        pricing: Schema.optionalKey(
          Schema.Struct({
            prompt: Schema.optionalKey(Schema.String),
            completion: Schema.optionalKey(Schema.String),
          }),
        ),
        supported_parameters: Schema.Array(Schema.String),
      }),
    ),
  }),
});
type Endpoint = (typeof EndpointsResponse.Type)["data"]["endpoints"][number];

const isFlex = (endpoint: Endpoint) => endpoint.tag?.endsWith("/flex") ?? false;

const isAllowed = (endpoint: Endpoint, providers: readonly string[]) => {
  const names = [endpoint.provider_name, endpoint.tag?.split("/")[0]].map((name) =>
    name?.toLowerCase(),
  );
  return providers.some((provider) => names.includes(provider.toLowerCase()));
};

const perMillion = (perToken: string | undefined) =>
  perToken === undefined ? 0 : Number(perToken) * 1_000_000;

// Small tolerance, since per-token prices like 0.00000005 do not scale exactly.
const isWithinPrice = ({ pricing }: Endpoint, { maxPrice }: Routing) =>
  pricing === undefined ||
  (perMillion(pricing.prompt) <= maxPrice.prompt + 1e-9 &&
    perMillion(pricing.completion) <= maxPrice.completion + 1e-9);

// Variants such as ":floor" or ":free" share the base model's endpoints.
const baseModel = (model: string) => {
  const variant = model.lastIndexOf(":");
  return variant === -1 ? model : model.slice(0, variant);
};

const findEndpointIssue = (
  endpoints: readonly Endpoint[],
  model: string,
  routing: Routing,
): string | undefined => {
  const structured = endpoints.filter((endpoint) =>
    requiredParameters.every((parameter) => endpoint.supported_parameters.includes(parameter)),
  );
  if (structured.length === 0) {
    return (
      `The model '${model}' has no provider supporting JSON Schema structured output. ` +
      "Choose a compatible model."
    );
  }
  const providers = routing.providers.join(", ");
  const allowed = structured.filter((endpoint) => isAllowed(endpoint, routing.providers));
  if (allowed.length === 0) {
    return (
      `The model '${model}' has no endpoint from the allowed providers (${providers}) ` +
      "supporting JSON Schema structured output. Change OPENROUTER_PROVIDERS or the model."
    );
  }
  // Only require flex when the endpoint data shows which endpoints offer it.
  const requireFlex = routing.serviceTier === "flex" && endpoints.some(isFlex);
  const candidates = requireFlex ? allowed.filter(isFlex) : allowed;
  if (candidates.length === 0) {
    return (
      `The model '${model}' has no flex endpoint from the allowed providers (${providers}). ` +
      "Change OPENROUTER_PROVIDERS, OPENROUTER_SERVICE_TIER or the model."
    );
  }
  if (!candidates.some((endpoint) => isWithinPrice(endpoint, routing))) {
    return (
      `The model '${model}' has no ${requireFlex ? "flex " : ""}endpoint from the allowed ` +
      `providers (${providers}) under the price cap (${priceCapText(routing)}). Raise ` +
      "OPENROUTER_MAX_PRICE_PROMPT and OPENROUTER_MAX_PRICE_COMPLETION or choose another model."
    );
  }
  return undefined;
};

const ErrorBody = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) });
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

export type PreflightError =
  | OpenRouterAuthError
  | OpenRouterUnavailable
  | OpenRouterRequestFailed
  | ManagementKeyError
  | ModelUnsupported;

const getJson = <A>(
  http: HttpClient.HttpClient,
  path: string,
  decode: (body: unknown) => Effect.Effect<A, Schema.SchemaError>,
) =>
  Effect.gen(function* () {
    const response = yield* http.get(path);
    const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
    if (response.status < 200 || response.status >= 300) {
      const message = Option.getOrUndefined(
        Option.map(decodeErrorBody(body), ({ error }) => error.message),
      );
      return yield* Effect.fail(
        openRouterErrorFromStatus(
          response.status,
          message ?? `OpenRouter request to ${path} failed (${response.status}).`,
        ),
      );
    }
    return yield* decode(body).pipe(
      Effect.mapError(
        () =>
          new OpenRouterRequestFailed({
            status: null,
            message: `OpenRouter returned an unexpected response from ${path}.`,
          }),
      ),
    );
  }).pipe(
    Effect.catchTag("HttpClientError", (error) =>
      Effect.fail(new OpenRouterRequestFailed({ status: null, message: error.message })),
    ),
  );

// Read-only checks, so a bad key or model fails before any scrape or completion is paid for.
export const checkAccess = (
  http: HttpClient.HttpClient,
  model: string,
  routing: Routing,
): Effect.Effect<void, PreflightError> =>
  Effect.gen(function* () {
    const key = yield* getJson(http, "/key", Schema.decodeUnknownEffect(KeyResponse));
    if (key.data.is_management_key || key.data.is_provisioning_key) {
      return yield* Effect.fail(
        new ManagementKeyError({
          message:
            "The OpenRouter API key is a management or provisioning key, which cannot run " +
            "AI matching. Create a regular API key at https://openrouter.ai/settings/keys.",
        }),
      );
    }

    const { data } = yield* getJson(
      http,
      `/models/${baseModel(model)}/endpoints`,
      Schema.decodeUnknownEffect(EndpointsResponse),
    );
    const issue = findEndpointIssue(data.endpoints, model, routing);
    if (issue !== undefined) {
      return yield* Effect.fail(new ModelUnsupported({ model, message: issue }));
    }
  });
