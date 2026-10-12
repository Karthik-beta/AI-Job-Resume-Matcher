import { describe, expect, test } from "bun:test";
import { defaultRouting, routingFromEnv } from "./routing";

describe("routingFromEnv", () => {
  test("defaults to OpenAI's flex tier under the price cap", () => {
    expect(defaultRouting).toEqual({
      serviceTier: "flex",
      providers: ["openai"],
      maxPrice: { prompt: 0.05, completion: 0.25 },
      reasoningEffort: "low",
    });
  });

  test("reads every variable", () => {
    const routing = routingFromEnv({
      OPENROUTER_SERVICE_TIER: "default",
      OPENROUTER_PROVIDERS: "openai, azure",
      OPENROUTER_MAX_PRICE_PROMPT: "0.1",
      OPENROUTER_MAX_PRICE_COMPLETION: "0.5",
      OPENROUTER_REASONING_EFFORT: "medium",
    });
    expect(routing).toEqual({
      serviceTier: "default",
      providers: ["openai", "azure"],
      maxPrice: { prompt: 0.1, completion: 0.5 },
      reasoningEffort: "medium",
    });
  });

  test("keeps the default for an empty variable", () => {
    const routing = routingFromEnv({ OPENROUTER_PROVIDERS: "", OPENROUTER_SERVICE_TIER: " " });
    expect(routing).toEqual(defaultRouting);
  });

  test("rejects an unknown service tier", () => {
    expect(() => routingFromEnv({ OPENROUTER_SERVICE_TIER: "fast" })).toThrow();
  });
});
