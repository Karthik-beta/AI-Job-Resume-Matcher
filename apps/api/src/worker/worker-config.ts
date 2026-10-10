import { Schema } from "effect";

// Only the worker calls Firecrawl and OpenRouter, so the API starts without these keys.
const WorkerEnv = Schema.Struct({
  FIRECRAWL_API_KEY: Schema.NonEmptyString,
  OPENROUTER_API_KEY: Schema.NonEmptyString,
});

export const workerConfig = Schema.decodeUnknownSync(WorkerEnv)(process.env);
