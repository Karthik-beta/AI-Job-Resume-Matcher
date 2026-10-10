import { describe, expect, test } from "bun:test";
import { OpenRouterClient } from "@effect/ai-openrouter";
import { Effect, Layer, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { MatchEvaluator, makeMatchEvaluator } from "./evaluate";

const model = "example/test-model";
const keyUrl = "https://openrouter.ai/api/v1/key";
const endpointsUrl = `https://openrouter.ai/api/v1/models/${model}/endpoints`;

type Reply = { readonly status?: number; readonly body: unknown } | "network error";

interface SentRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
}

const regularKey = { body: { data: { is_management_key: false, is_provisioning_key: false } } };
const endpoints = (...supported: string[][]) => ({
  body: {
    data: { endpoints: supported.map((parameters) => ({ supported_parameters: parameters })) },
  },
});
const compatible = endpoints(["response_format", "structured_outputs", "temperature"]);

const preflight = async (replies: { key: Reply; endpoints?: Reply }) => {
  const sent: SentRequest[] = [];
  const http = HttpClient.make((request, url) =>
    Effect.suspend(() => {
      sent.push({
        method: request.method,
        url: url.toString(),
        authorization: request.headers["authorization"],
      });
      const reply = url.pathname.endsWith("/key") ? replies.key : replies.endpoints;
      if (reply === "network error") {
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "Connection lost" }),
          }),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(reply?.body ?? null, { status: reply?.status ?? 200 }),
        ),
      );
    }),
  );
  const layer = Layer.effect(MatchEvaluator, makeMatchEvaluator(model)).pipe(
    Layer.provide(OpenRouterClient.layer({ apiKey: Redacted.make("test-key") })),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  );
  const outcome = await MatchEvaluator.use((evaluator) => evaluator.preflight).pipe(
    Effect.result,
    Effect.provide(layer),
    Effect.runPromise,
  );
  return { outcome, sent };
};

const failureOf = async (replies: { key: Reply; endpoints?: Reply }) => {
  const { outcome, sent } = await preflight(replies);
  if (outcome._tag !== "Failure") throw new Error("Expected a failure");
  return { error: outcome.failure, sent };
};

describe("preflight", () => {
  test("passes with a regular key and a compatible model, using only GET requests", async () => {
    const { outcome, sent } = await preflight({ key: regularKey, endpoints: compatible });
    expect(outcome._tag).toBe("Success");
    expect(sent).toEqual([
      { method: "GET", url: keyUrl, authorization: "Bearer test-key" },
      { method: "GET", url: endpointsUrl, authorization: "Bearer test-key" },
    ]);
  });

  test.each(["is_management_key", "is_provisioning_key"])(
    "rejects a key with %p before checking the model",
    async (field) => {
      const { error, sent } = await failureOf({ key: { body: { data: { [field]: true } } } });
      expect(error._tag).toBe("ManagementKeyError");
      expect(sent).toHaveLength(1);
    },
  );

  test.each([
    ["no provider supports structured output", endpoints(["temperature", "tools"])],
    [
      "the parameters are split across providers",
      endpoints(["response_format", "structured_outputs"], ["temperature"]),
    ],
    ["the model has no endpoints", endpoints()],
  ])("rejects the model when %s", async (_, reply) => {
    const { error } = await failureOf({ key: regularKey, endpoints: reply });
    expect(error).toMatchObject({ _tag: "ModelUnsupported", model });
  });

  test("maps a rejected key to an auth error without checking the model", async () => {
    const { error, sent } = await failureOf({
      key: { status: 401, body: { error: { code: 401, message: "User not found." } } },
    });
    expect(error).toMatchObject({
      _tag: "OpenRouterAuthError",
      status: 401,
      message: "User not found.",
    });
    expect(sent).toHaveLength(1);
  });

  test("maps an unknown model to unavailable", async () => {
    const { error } = await failureOf({
      key: regularKey,
      endpoints: { status: 404, body: { error: { code: 404, message: "Model not found" } } },
    });
    expect(error).toMatchObject({ _tag: "OpenRouterUnavailable", status: 404 });
  });

  test("rejects a key response without key information", async () => {
    const { error } = await failureOf({ key: { body: {} } });
    expect(error).toMatchObject({
      _tag: "OpenRouterRequestFailed",
      status: null,
      message: "OpenRouter returned an unexpected response from /key.",
    });
  });

  test("maps a network failure to a failed request", async () => {
    const { error } = await failureOf({ key: "network error" });
    expect(error).toMatchObject({ _tag: "OpenRouterRequestFailed", status: null });
  });
});
