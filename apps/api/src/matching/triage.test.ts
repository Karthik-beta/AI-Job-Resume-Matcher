import { describe, expect, test } from "bun:test";
import { OpenRouterClient } from "@effect/ai-openrouter";
import { Effect, Layer, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { MatchOutputInvalid } from "./errors";
import type { Listing } from "./firecrawl";
import { defaultRouting } from "./routing";
import {
  makeTitleTriage,
  resumeSummary,
  TitleTriage,
  type TriageInput,
  type TriageScore,
  titleTriageLayer,
  triageBatchSize,
  triageListings,
  triagePrompt,
} from "./triage";

const model = "example/test-model";

const listing = (title: string, locations: string[] = []): Listing => ({
  title,
  url: `https://acme.com/jobs/${encodeURIComponent(title)}`,
  company: "Acme",
  locations,
  experienceMinYears: null,
  experienceMaxYears: null,
  remote: null,
  postedAt: null,
});

describe("resumeSummary", () => {
  test("collapses whitespace and keeps the first 3,000 characters", () => {
    expect(resumeSummary("  Asha\n\n  Rao\tEngineer ")).toBe("Asha Rao Engineer");
    expect(resumeSummary("word ".repeat(1_000))).toHaveLength(3_000);
  });
});

describe("triageListings", () => {
  const run = (
    listings: readonly Listing[],
    score: (input: TriageInput) => readonly TriageScore[],
  ) => {
    const inputs: TriageInput[] = [];
    const triage = TitleTriage.of({
      score: (input) =>
        Effect.sync(() => {
          inputs.push(input);
          return score(input);
        }),
    });
    return triageListings("  My\n resume ", listings).pipe(
      Effect.provide(Layer.succeed(TitleTriage, triage)),
      Effect.runPromise,
      (promise) => promise.then((result) => ({ ...result, inputs })),
    );
  };

  test("keeps jobs scoring 2 or more, highest first and stable within a score", async () => {
    const listings = ["A", "B", "C", "D", "E"].map((title) => listing(title, ["Pune", "Remote"]));
    const scores: Record<string, number> = { A: 2, B: 3, C: 1, D: 3, E: 0 };
    const result = await run(listings, ({ jobs }) =>
      jobs.map(({ id, title }) => ({ id, score: scores[title] ?? 0, reason: `${title} reason` })),
    );
    expect(result.kept.map(({ title }) => title)).toEqual(["B", "D", "A"]);
    expect(result.rejected).toEqual([
      { listing: listing("C", ["Pune", "Remote"]), reason: "C reason" },
      { listing: listing("E", ["Pune", "Remote"]), reason: "E reason" },
    ]);
    expect(result.inputs).toEqual([
      {
        resume: "My resume",
        jobs: listings.map(({ title }, index) => ({
          id: String(index),
          title,
          company: "Acme",
          location: "Pune; Remote",
        })),
      },
    ]);
  });

  test("keeps jobs the model left out and ignores unknown or repeated ids", async () => {
    const listings = [listing("A"), listing("B")];
    const result = await run(listings, () => [
      { id: "0", score: 0, reason: null },
      { id: "0", score: 3, reason: null },
      { id: "7", score: 0, reason: null },
      { id: "x", score: 0, reason: null },
    ]);
    expect(result.kept).toEqual([listing("B")]);
    expect(result.rejected).toEqual([{ listing: listing("A"), reason: null }]);
  });

  test("sends long runs in batches", async () => {
    const listings = Array.from({ length: triageBatchSize + 1 }, (_, index) =>
      listing(`Job ${index}`),
    );
    const result = await run(listings, ({ jobs }) =>
      jobs.map(({ id }) => ({ id, score: id === "150" ? 3 : 2, reason: null })),
    );
    expect(result.inputs.map(({ jobs }) => jobs.length)).toEqual([triageBatchSize, 1]);
    expect(result.inputs[1]?.jobs[0]?.id).toBe("150");
    expect(result.kept[0]?.title).toBe("Job 150");
    expect(result.kept).toHaveLength(listings.length);
  });

  test("makes no request without listings", async () => {
    const result = await run([], () => []);
    expect(result).toEqual({ kept: [], rejected: [], inputs: [] });
  });
});

const completion = (content: string | null, refusal: string | null = null) => ({
  id: "test-completion",
  object: "chat.completion",
  created: 0,
  system_fingerprint: null,
  model,
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content, refusal } }],
});

const score = async (reply: unknown) => {
  const sent: Record<string, unknown>[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const body = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
      sent.push(JSON.parse(new TextDecoder().decode(body)));
      return HttpClientResponse.fromWeb(request, Response.json(reply));
    }),
  );
  const layer = Layer.effect(TitleTriage, makeTitleTriage(model, defaultRouting)).pipe(
    Layer.provide(OpenRouterClient.layer({ apiKey: Redacted.make("test-key") })),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  );
  const jobs = [{ id: "0", title: "Engineer", company: "Acme", location: "Pune" }];
  const outcome = await TitleTriage.use((triage) => triage.score({ resume: "Resume", jobs })).pipe(
    Effect.result,
    Effect.provide(layer),
    Effect.runPromise,
  );
  return { outcome, sent };
};

describe("title triage", () => {
  const scoresJson = JSON.stringify({
    scores: [
      { id: "0", score: 1, reason: " Sales role " },
      { id: "1", score: 3, reason: null },
      { id: "2", score: 2 },
    ],
  });

  test("sends the resume and jobs with a strict schema and flex routing", async () => {
    const { sent } = await score(completion(scoresJson));
    expect(sent[0]).toMatchObject({
      model,
      service_tier: "flex",
      response_format: {
        type: "json_schema",
        json_schema: { name: "title_triage", strict: true, schema: { required: ["scores"] } },
      },
      messages: [
        { role: "system", content: triagePrompt },
        {
          role: "user",
          content:
            "Resume summary:\nResume\n\nJobs:\n" +
            '[{"id":"0","title":"Engineer","company":"Acme","location":"Pune"}]',
        },
      ],
    });
  });

  test("decodes the scores", async () => {
    const { outcome } = await score(completion(scoresJson));
    if (outcome._tag !== "Success") throw new Error("Expected a success");
    expect(outcome.success).toEqual([
      { id: "0", score: 1, reason: "Sales role" },
      { id: "1", score: 3, reason: null },
      { id: "2", score: 2, reason: null },
    ]);
  });

  test.each([
    [completion(null, "No."), "Model refused: No."],
    [completion('{"scores":[{"id":"0","score":4}]}'), "Invalid triage scores: "],
    [completion('{"scores":[{"id":"0","score":1.5}]}'), "Invalid triage scores: "],
    [completion(null), "Invalid triage scores: "],
  ])("rejects an unusable completion: %#", async (reply, message) => {
    const { outcome } = await score(reply);
    if (outcome._tag !== "Failure") throw new Error("Expected a failure");
    expect(outcome.failure).toBeInstanceOf(MatchOutputInvalid);
    expect(outcome.failure.message).toStartWith(message);
  });

  test("builds a live layer", () => {
    const layer = titleTriageLayer({ apiKey: "key", model, routing: defaultRouting });
    expect(Layer.isLayer(layer)).toBe(true);
  });
});
