import { describe, expect, test } from "bun:test";
import { contextKey, type MatchContext } from "./context-key";
import { defaultRequirements } from "./requirements";

const context: MatchContext = {
  resumeUrl: "https://example.com/resume.pdf",
  sourceIds: ["b", "a", "c"],
  model: "openai/gpt-4o-mini",
  requirements: { ...defaultRequirements, experienceYears: 3, locations: ["Bengaluru", "Pune"] },
};

describe("contextKey", () => {
  test("returns a sha256 hex digest", () => {
    expect(contextKey(context)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("ignores source order and duplicates", () => {
    expect(contextKey({ ...context, sourceIds: ["c", "a", "b", "a"] })).toBe(contextKey(context));
  });

  test("ignores location order", () => {
    const requirements = { ...context.requirements, locations: ["Pune", "Bengaluru"] };
    expect(contextKey({ ...context, requirements })).toBe(contextKey(context));
  });

  test.each<Partial<MatchContext>>([
    { resumeUrl: "https://example.com/other.pdf" },
    { sourceIds: ["a", "b"] },
    { model: "anthropic/claude-sonnet" },
    { requirements: { ...context.requirements, includeUnknown: false } },
    { requirements: { ...context.requirements, jobMaxYears: 5 } },
  ])("changes when an input changes %#", (change) => {
    expect(contextKey({ ...context, ...change })).not.toBe(contextKey(context));
  });
});
