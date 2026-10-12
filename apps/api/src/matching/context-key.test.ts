import { describe, expect, test } from "bun:test";
import { contextKey, type MatchContext } from "./context-key";
import { defaultRequirements } from "./requirements";
import { noTitleFilters } from "./title-filters";

const context: MatchContext = {
  resumeHash: "a".repeat(64),
  sourceIds: ["b", "a", "c"],
  model: "openai/gpt-4o-mini",
  requirements: { ...defaultRequirements, experienceYears: 3, locations: ["Bengaluru", "Pune"] },
  titleFilters: noTitleFilters,
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

  test("keeps the key it had before title filters existed when there are none", () => {
    expect(contextKey(context)).toBe(
      "d7178dbc76205406d684c608a61f9c0ffb3bb37cb86d104e64515955371801fc",
    );
  });

  test("ignores the case, order and duplicates of title keywords", () => {
    const titleFilters = { include: ["Go", "Backend"], exclude: ["senior"] };
    expect(
      contextKey({
        ...context,
        titleFilters: { include: ["backend", "go", "GO"], exclude: ["Senior"] },
      }),
    ).toBe(contextKey({ ...context, titleFilters }));
  });

  test.each<Partial<MatchContext>>([
    { resumeHash: "b".repeat(64) },
    { sourceIds: ["a", "b"] },
    { model: "anthropic/claude-sonnet" },
    { requirements: { ...context.requirements, includeUnknown: false } },
    { requirements: { ...context.requirements, jobMaxYears: 5 } },
    { titleFilters: { include: ["backend"], exclude: [] } },
    { titleFilters: { include: [], exclude: ["backend"] } },
  ])("changes when an input changes %#", (change) => {
    expect(contextKey({ ...context, ...change })).not.toBe(contextKey(context));
  });
});
