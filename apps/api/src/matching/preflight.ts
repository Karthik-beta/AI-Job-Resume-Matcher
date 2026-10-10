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

const requiredParameters = ["response_format", "structured_outputs", "temperature"];

const KeyResponse = Schema.Struct({
  data: Schema.Struct({
    is_management_key: Schema.optionalKey(Schema.Boolean),
    is_provisioning_key: Schema.optionalKey(Schema.Boolean),
  }),
});

const EndpointsResponse = Schema.Struct({
  data: Schema.Struct({
    endpoints: Schema.Array(Schema.Struct({ supported_parameters: Schema.Array(Schema.String) })),
  }),
});

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
      `/models/${model}/endpoints`,
      Schema.decodeUnknownEffect(EndpointsResponse),
    );
    const supported = data.endpoints.some((endpoint) =>
      requiredParameters.every((parameter) => endpoint.supported_parameters.includes(parameter)),
    );
    if (!supported) {
      return yield* Effect.fail(
        new ModelUnsupported({
          model,
          message:
            `The model '${model}' has no provider supporting JSON Schema structured output ` +
            "and temperature. Choose a compatible model.",
        }),
      );
    }
  });
