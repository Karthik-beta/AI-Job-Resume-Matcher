import { describe, expect, test } from "bun:test";
import { OpenRouterClient } from "@effect/ai-openrouter";
import { Effect, Layer, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  extractionPrompt,
  ListingExtractor,
  listingExtractorLayer,
  makeListingExtractor,
} from "./listing-extractor";
import { defaultRouting } from "./routing";

const model = "example/test-model";

const completion = (content: string | null, refusal: string | null = null) => ({
  id: "test-completion",
  object: "chat.completion",
  created: 0,
  system_fingerprint: null,
  model,
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content, refusal } }],
});

const extract = async (reply: unknown) => {
  const sent: Record<string, unknown>[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const body = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
      sent.push(JSON.parse(new TextDecoder().decode(body)));
      return HttpClientResponse.fromWeb(request, Response.json(reply));
    }),
  );
  const layer = Layer.effect(ListingExtractor, makeListingExtractor(model, defaultRouting)).pipe(
    Layer.provide(OpenRouterClient.layer({ apiKey: Redacted.make("test-key") })),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  );
  const outcome = await ListingExtractor.use((extractor) =>
    extractor.extract({ url: "https://acme.com/careers", markdown: "# Jobs\n\n- Engineer" }),
  ).pipe(Effect.result, Effect.provide(layer), Effect.runPromise);
  return { outcome, sent };
};

const jobsJson = JSON.stringify({
  jobs: [
    {
      title: "Engineer",
      url: "https://acme.com/jobs/1",
      company: "Acme",
      locations: ["Pune"],
      experience_min_years: 3,
      experience_max_years: null,
    },
  ],
});

describe("listing extractor", () => {
  test("sends the page with a strict listings schema and flex routing", async () => {
    const { sent } = await extract(completion(jobsJson));
    expect(sent[0]).toMatchObject({
      model,
      service_tier: "flex",
      provider: { only: ["openai"], allow_fallbacks: false },
      reasoning: { effort: "low" },
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "job_listings",
          strict: true,
          schema: { required: ["jobs"], additionalProperties: false },
        },
      },
      messages: [
        { role: "system", content: extractionPrompt },
        {
          role: "user",
          content: "Page URL: https://acme.com/careers\n\nPage markdown:\n# Jobs\n\n- Engineer",
        },
      ],
    });
    expect(sent[0]).not.toHaveProperty("prompt_cache_key");
  });

  test("decodes the listings", async () => {
    const { outcome } = await extract(completion(jobsJson));
    if (outcome._tag !== "Success") throw new Error("Expected a success");
    expect(outcome.success).toEqual([
      {
        title: "Engineer",
        url: "https://acme.com/jobs/1",
        company: "Acme",
        locations: ["Pune"],
        experienceMinYears: 3,
        experienceMaxYears: null,
        remote: null,
        postedAt: null,
      },
    ]);
  });

  test.each([
    [completion(null, "No."), "Model refused: No."],
    [completion('{"jobs":[{"title":"Engineer"}]}'), "Invalid listings: "],
    [completion(null), "Invalid listings: "],
  ])("rejects an unusable completion: %#", async (reply, message) => {
    const { outcome } = await extract(reply);
    if (outcome._tag !== "Failure") throw new Error("Expected a failure");
    expect(outcome.failure._tag).toBe("MatchOutputInvalid");
    expect(outcome.failure.message).toStartWith(message);
  });

  test("builds a live layer", () => {
    const layer = listingExtractorLayer({ apiKey: "key", model, routing: defaultRouting });
    expect(Layer.isLayer(layer)).toBe(true);
  });
});
