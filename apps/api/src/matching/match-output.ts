import { Effect, Schema } from "effect";
import { MatchOutputInvalid } from "./errors";

export const MatchOutputJson = Schema.Struct({
  is_match: Schema.Boolean,
  reason: Schema.String,
});

export interface MatchResult {
  readonly isMatch: boolean;
  readonly reason: string;
}

export interface MatchCompletion {
  readonly content: string | null | undefined;
  readonly refusal?: string | null | undefined;
}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(MatchOutputJson), {
  onExcessProperty: "error",
});

export const decodeMatchOutput = ({
  content,
  refusal,
}: MatchCompletion): Effect.Effect<MatchResult, MatchOutputInvalid> => {
  if (refusal) {
    return Effect.fail(new MatchOutputInvalid({ message: `Model refused: ${refusal}` }));
  }
  if (!content?.trim()) {
    return Effect.fail(new MatchOutputInvalid({ message: "Model returned empty match content." }));
  }
  return decodeJson(content).pipe(
    Effect.map(({ is_match, reason }) => ({ isMatch: is_match, reason })),
    Effect.mapError((error) => new MatchOutputInvalid({ message: error.message })),
  );
};
