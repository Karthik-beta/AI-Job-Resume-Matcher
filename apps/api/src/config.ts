import { Schema } from "effect";

const Env = Schema.Struct({
  DATABASE_URL: Schema.NonEmptyString,
  API_PORT: Schema.FiniteFromString,
});

export const config = Schema.decodeUnknownSync(Env)(process.env);
