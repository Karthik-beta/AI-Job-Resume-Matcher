import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { decodeMatchOutput, type MatchCompletion } from "./match-output";

const failureOf = (completion: MatchCompletion) =>
  Effect.runSync(Effect.flip(decodeMatchOutput(completion)));

describe("decodeMatchOutput", () => {
  test("decodes strict JSON into a match result", () => {
    const result = Effect.runSync(
      decodeMatchOutput({ content: '{"is_match": true, "reason": "Strong TypeScript fit"}' }),
    );
    expect(result).toEqual({ isMatch: true, reason: "Strong TypeScript fit" });
  });

  test.each([undefined, null, "", "  \n "])("rejects empty content %p", (content) => {
    expect(failureOf({ content })._tag).toBe("MatchOutputInvalid");
  });

  test("rejects a refusal even when content is present", () => {
    const error = failureOf({ content: '{"is_match": false, "reason": "x"}', refusal: "No." });
    expect(error._tag).toBe("MatchOutputInvalid");
    expect(error.message).toContain("No.");
  });

  test.each([
    "not json",
    '{"is_match": "true", "reason": "x"}',
    '{"is_match": true}',
    '{"is_match": true, "reason": 1}',
    '{"is_match": true, "reason": "x", "score": 9}',
    "[]",
  ])("rejects unparseable or off-schema output %p", (content) => {
    expect(failureOf({ content })._tag).toBe("MatchOutputInvalid");
  });
});
