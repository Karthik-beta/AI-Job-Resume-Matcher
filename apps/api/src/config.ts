import { Effect, Schema } from "effect";

const Env = Schema.Struct({
  DATABASE_URL: Schema.NonEmptyString,
  API_PORT: Schema.FiniteFromString,
  BETTER_AUTH_SECRET: Schema.NonEmptyString,
  BETTER_AUTH_URL: Schema.NonEmptyString,
  REDIS_URL: Schema.NonEmptyString,
  OPENROUTER_MODEL: Schema.NonEmptyString,
  // "fake" swaps Firecrawl, OpenRouter and Discord for fixtures, for tests and demos.
  PROVIDERS: Schema.Literals(["live", "fake"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("live" as const)),
  ),
});

export const config = Schema.decodeUnknownSync(Env)(process.env);
