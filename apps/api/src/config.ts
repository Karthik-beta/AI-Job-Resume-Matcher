import { Schema } from "effect";

const Env = Schema.Struct({
  DATABASE_URL: Schema.NonEmptyString,
  API_PORT: Schema.FiniteFromString,
  BETTER_AUTH_SECRET: Schema.NonEmptyString,
  BETTER_AUTH_URL: Schema.NonEmptyString,
});

export const config = Schema.decodeUnknownSync(Env)(process.env);
