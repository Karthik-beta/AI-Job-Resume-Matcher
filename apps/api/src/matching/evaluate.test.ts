import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { OpenRouterClient } from "@effect/ai-openrouter";
import { Clock, Context, Effect, Fiber, Layer, Logger, Redacted } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { TestClock } from "effect/testing";
import {
  completionRequestInit,
  MatchEvaluator,
  type MatchInput,
  makeMatchEvaluator,
  systemPrompt,
  userPrompt,
} from "./evaluate";
import { defaultRequirements } from "./requirements";
import { defaultRouting } from "./routing";

const model = "example/test-model";

interface SentRequest {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
  readonly requestInit: globalThis.RequestInit | undefined;
  readonly at: number;
}

type Reply = { readonly status?: number; readonly body: unknown };

const completion = (
  content: string | null,
  options: {
    finishReason?: string;
    refusal?: string;
    serviceTier?: string | undefined;
    usage?: object;
  } = {},
) => ({
  id: "test-completion",
  object: "chat.completion",
  created: 0,
  system_fingerprint: null,
  model,
  ...(options.serviceTier === undefined ? {} : { service_tier: options.serviceTier }),
  ...(options.usage === undefined ? {} : { usage: options.usage }),
  choices: [
    {
      index: 0,
      finish_reason: options.finishReason ?? "stop",
      message: { role: "assistant", content, refusal: options.refusal ?? null },
    },
  ],
});

// Replies are used in order and the last one repeats. A test clock skips the retry backoff.
const evaluate = async (replies: Reply | readonly Reply[], input: Partial<MatchInput> = {}) => {
  const queue = Array.isArray(replies) ? replies : [replies];
  const sent: SentRequest[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const http = HttpClient.make((request, url, _signal, fiber) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;
      const reply = queue[Math.min(sent.length, queue.length - 1)];
      const body = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
      sent.push({
        url: url.toString(),
        authorization: request.headers["authorization"],
        body: JSON.parse(new TextDecoder().decode(body)),
        requestInit: Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit),
        at,
      });
      return HttpClientResponse.fromWeb(
        request,
        Response.json(reply?.body, { status: reply?.status ?? 200 }),
      );
    }),
  );
  const layer = Layer.effect(MatchEvaluator, makeMatchEvaluator(model, defaultRouting)).pipe(
    Layer.provide(OpenRouterClient.layer({ apiKey: Redacted.make("test-key") })),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  );
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push([message].flat().join(" "));
    if (logLevel === "Info") infos.push([message].flat().join(" "));
  });
  const outcome = await Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(
      MatchEvaluator.use((evaluator) =>
        evaluator.evaluate({ resume: "resume", jobPage: "job", ...input }),
      ).pipe(Effect.result),
    );
    yield* TestClock.adjust("1 hour");
    return yield* Fiber.join(fiber);
  }).pipe(
    Effect.provide(layer),
    Effect.provide(Logger.layer([logger])),
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  );
  return { outcome, sent, warnings, infos };
};

const failureOf = async (replies: Reply | readonly Reply[]) => {
  const { outcome } = await evaluate(replies);
  if (outcome._tag !== "Failure") throw new Error("Expected a failure");
  return outcome.failure;
};

describe("evaluate", () => {
  test.each([true, false])("returns the decoded result when is_match is %p", async (isMatch) => {
    const { outcome } = await evaluate({
      body: completion(JSON.stringify({ is_match: isMatch, reason: "Evaluation reason" })),
    });
    expect(outcome).toMatchObject({
      _tag: "Success",
      success: { isMatch, reason: "Evaluation reason" },
    });
  });

  test("sends the system prompt, a strict schema and flex routing", async () => {
    const resume = 'TypeScript experience {"years": 4}';
    const { sent } = await evaluate(
      { body: completion('{"is_match":true,"reason":"Fit"}') },
      { resume, jobPage: "Requires TypeScript" },
    );
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(request?.authorization).toBe("Bearer test-key");
    const body = request?.body ?? {};
    expect(body).toMatchObject({
      model,
      stream: false,
      service_tier: "flex",
      provider: {
        only: ["openai"],
        allow_fallbacks: false,
        require_parameters: true,
        max_price: { prompt: "0.05", completion: "0.25" },
      },
      reasoning: { effort: "low" },
      max_completion_tokens: 2000,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "job_match",
          strict: true,
          schema: {
            required: ["is_match", "reason"],
            additionalProperties: false,
            properties: { is_match: { type: "boolean" }, reason: { type: "string" } },
          },
        },
      },
    });
    expect(body).not.toHaveProperty("temperature");
    expect(request?.requestInit).toEqual(completionRequestInit);
    const messages = body["messages"] as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: "system", content: systemPrompt });
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toContain(resume);
    expect(messages[1]?.content).toContain("Requires TypeScript");
    expect(messages[1]?.content).not.toContain("requirements");
  });

  test("adds the user's requirements to the prompt", async () => {
    const requirements = {
      ...defaultRequirements,
      experienceYears: 3,
      experienceMonths: 4,
      jobMinYears: 2,
      jobMaxYears: 4,
      locations: ["Bengaluru", "Bangalore"],
      includeUnknown: false,
    };
    const { sent } = await evaluate(
      { body: completion('{"is_match":false,"reason":"No"}') },
      { requirements },
    );
    const messages = sent[0]?.body["messages"] as { content: string }[];
    const content = messages[1]?.content;
    expect(content).toContain(
      '{"experience_years":3,"experience_months":4,"job_min_years":2,"job_max_years":4,' +
        '"locations":["Bengaluru","Bangalore"],"include_unknown":false}',
    );
    expect(content).toContain("candidate must meet its stated minimum");
    expect(content).toContain("If include_unknown is false, reject");
  });
});

describe("evaluate prompt caching", () => {
  const requirements = { ...defaultRequirements, locations: ["Bengaluru"] };
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

  test("orders the prompt resume, requirements, then job page", () => {
    const prompt = userPrompt({ resume: "RESUME", jobPage: "JOB", requirements });
    const order = ["RESUME", "User's job search requirements", "Job Posting:\nJOB"].map((part) =>
      prompt.indexOf(part),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order).not.toContain(-1);
    expect(prompt).toEndWith("Determine if this candidate is a good fit and explain why briefly.");
  });

  test.each([
    ["with", requirements],
    ["without", undefined],
  ])("keeps the prefix before the job page identical %s requirements", (_, reqs) => {
    const prefix = (jobPage: string) => {
      const prompt = userPrompt({ resume: "Same resume", jobPage, requirements: reqs });
      return prompt.slice(0, prompt.indexOf(jobPage));
    };
    expect(prefix("First job page")).toBe(prefix("A different, longer job page"));
    expect(prefix("First job page")).toEndWith("Job Posting:\n");
  });

  test("keys the prompt cache on the resume hash", async () => {
    const reply = { body: completion('{"is_match":true,"reason":"Fit"}') };
    const hashed = await evaluate(reply, { resume: "My resume" });
    expect(hashed.sent[0]?.body["prompt_cache_key"]).toBe(sha256("My resume"));
    const given = await evaluate(reply, { resume: "My resume", resumeHash: "stored-hash" });
    expect(given.sent[0]?.body["prompt_cache_key"]).toBe("stored-hash");
  });

  test("logs prompt, cached and completion tokens", async () => {
    const usage = {
      prompt_tokens: 1200,
      prompt_tokens_details: { cached_tokens: 1024 },
      completion_tokens: 80,
      total_tokens: 1280,
    };
    const { infos } = await evaluate({
      body: completion('{"is_match":true,"reason":"Fit"}', { usage }),
    });
    expect(infos).toContain(
      "OpenRouter usage: 1200 prompt tokens (1024 cached), 80 completion tokens",
    );
  });
});

describe("evaluate service tier", () => {
  const reply = (serviceTier?: string) => ({
    body: completion('{"is_match":true,"reason":"Fit"}', { serviceTier }),
  });

  test.each([undefined, "flex"])("does not warn when the tier is %p", async (serviceTier) => {
    const { outcome, warnings } = await evaluate(reply(serviceTier));
    expect(outcome._tag).toBe("Success");
    expect(warnings).toEqual([]);
  });

  test("warns when OpenRouter serves another tier", async () => {
    const { outcome, warnings } = await evaluate(reply("default"));
    expect(outcome._tag).toBe("Success");
    expect(warnings).toEqual(["OpenRouter served the evaluation on the default tier, not flex."]);
  });
});

const httpError = (status: number, message = "Provider failure") => ({
  status,
  body: { error: { code: status, message } },
});
const minutes = (sent: readonly SentRequest[]) =>
  sent.map(({ at }) => (at - (sent[0]?.at ?? 0)) / 60_000);

describe("evaluate capacity retries", () => {
  test.each([429, 503])("retries HTTP %p after a minute", async (status) => {
    const { outcome, sent } = await evaluate([
      httpError(status),
      { body: completion('{"is_match":true,"reason":"Fit"}') },
    ]);
    expect(outcome._tag).toBe("Success");
    expect(minutes(sent)).toEqual([0, 1]);
  });

  test.each([429, 503])(
    "backs off HTTP %p exponentially, then fails only the job",
    async (status) => {
      const { outcome, sent } = await evaluate(httpError(status));
      expect(minutes(sent)).toEqual([0, 1, 3, 7, 15, 31]);
      if (outcome._tag !== "Failure") throw new Error("Expected a failure");
      expect(outcome.failure).toMatchObject({ _tag: "OpenRouterRequestFailed", status });
      expect(outcome.failure.message).toStartWith(
        "OpenRouter flex capacity unavailable after 5 retries: ",
      );
    },
  );
});

describe("evaluate errors", () => {
  test.each([
    [401, "OpenRouterAuthError"],
    [402, "OpenRouterUnavailable"],
    [403, "OpenRouterUnavailable"],
    [404, "OpenRouterUnavailable"],
    [400, "OpenRouterRequestFailed"],
    [500, "OpenRouterRequestFailed"],
    [502, "OpenRouterRequestFailed"],
  ])("maps HTTP %p to %s without retrying", async (status, tag) => {
    const { outcome, sent } = await evaluate(httpError(status));
    expect(outcome).toMatchObject({ _tag: "Failure", failure: { _tag: tag, status } });
    expect(sent).toHaveLength(1);
  });

  test.each([
    [404, "No endpoints found matching your data policy and max price."],
    [404, "No allowed providers are available for the selected model."],
    [503, "There is no available model provider that meets your routing requirements."],
  ])("stops the run when HTTP %p rejects the price cap", async (status, message) => {
    const error = await failureOf({ status, body: { error: { code: status, message } } });
    expect(error).toMatchObject({ _tag: "OpenRouterUnavailable", status });
    expect(error.message).toStartWith(
      "No flex endpoint under the price cap (prompt $0.05, completion $0.25 per million tokens): ",
    );
    expect(error.message).toContain(message);
  });

  test("keeps other 404 messages as they are", async () => {
    const error = await failureOf({
      status: 404,
      body: { error: { code: 404, message: "Model not found" } },
    });
    expect(error._tag).toBe("OpenRouterUnavailable");
    expect(error.message).not.toContain("price cap");
  });

  test.each(["length", "content_filter", "error", "tool_calls"])(
    "rejects a completion that finished with %p",
    async (finishReason) => {
      const error = await failureOf({
        body: completion('{"is_match":true,"reason":"Partial"}', { finishReason }),
      });
      expect(error._tag).toBe("MatchOutputInvalid");
      expect(error.message).toContain(finishReason);
    },
  );

  test("rejects a response with no choices", async () => {
    const error = await failureOf({ body: { ...completion(null), choices: [] } });
    expect(error).toMatchObject({
      _tag: "MatchOutputInvalid",
      message: "OpenRouter returned no completion choices.",
    });
  });

  test("rejects a refusal", async () => {
    const error = await failureOf({ body: completion(null, { refusal: "Cannot evaluate" }) });
    expect(error).toMatchObject({
      _tag: "MatchOutputInvalid",
      message: "Model refused: Cannot evaluate",
    });
  });

  test.each([
    "",
    "not JSON",
    '{"is_match":true}',
    '{"is_match":"false","reason":"No"}',
    '{"is_match":false,"reason":"No","extra":1}',
  ])("rejects invalid content %p", async (content) => {
    const error = await failureOf({ body: completion(content) });
    expect(error._tag).toBe("MatchOutputInvalid");
  });

  test("treats an error body on HTTP 200 as a failed request that continues the run", async () => {
    const error = await failureOf({ body: { error: { code: 502, message: "Upstream" } } });
    expect(error).toMatchObject({ _tag: "OpenRouterRequestFailed", status: null });
  });
});
