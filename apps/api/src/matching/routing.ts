import { Effect, Schema } from "effect";

// How OpenRouter routes evaluations: GPT-6 Luna on OpenAI's flex tier by default.
export interface Routing {
  readonly serviceTier: "auto" | "default" | "flex" | "priority" | "scale";
  readonly providers: readonly string[];
  // USD per million tokens, as OpenRouter's provider.max_price expects.
  readonly maxPrice: { readonly prompt: number; readonly completion: number };
  readonly reasoningEffort: "max" | "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
}

const RoutingEnv = Schema.Struct({
  OPENROUTER_SERVICE_TIER: Schema.Literals(["auto", "default", "flex", "priority", "scale"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("flex" as const)),
  ),
  OPENROUTER_PROVIDERS: Schema.NonEmptyString.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("openai")),
  ),
  OPENROUTER_MAX_PRICE_PROMPT: Schema.FiniteFromString.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("0.05")),
  ),
  OPENROUTER_MAX_PRICE_COMPLETION: Schema.FiniteFromString.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("0.25")),
  ),
  OPENROUTER_REASONING_EFFORT: Schema.Literals([
    "max",
    "xhigh",
    "high",
    "medium",
    "low",
    "minimal",
    "none",
  ]).pipe(Schema.withDecodingDefaultKey(Effect.succeed("low" as const))),
});

export const routingFromEnv = (env: Record<string, string | undefined>): Routing => {
  // An empty variable, as left in a copied .env file, keeps the default.
  const set = Object.fromEntries(Object.entries(env).filter(([, value]) => value?.trim()));
  const decoded = Schema.decodeUnknownSync(RoutingEnv)(set);
  return {
    serviceTier: decoded.OPENROUTER_SERVICE_TIER,
    providers: decoded.OPENROUTER_PROVIDERS.split(",")
      .map((provider) => provider.trim())
      .filter((provider) => provider !== ""),
    maxPrice: {
      prompt: decoded.OPENROUTER_MAX_PRICE_PROMPT,
      completion: decoded.OPENROUTER_MAX_PRICE_COMPLETION,
    },
    reasoningEffort: decoded.OPENROUTER_REASONING_EFFORT,
  };
};

export const defaultRouting = routingFromEnv({});

export const priceCapText = ({ maxPrice }: Routing) =>
  `prompt $${maxPrice.prompt}, completion $${maxPrice.completion} per million tokens`;
