import { describe, expect, test } from "bun:test";
import { acceptsTitle, canonicalTitleFilters, noTitleFilters } from "./title-filters";

describe("acceptsTitle", () => {
  test("accepts every title without filters", () => {
    expect(acceptsTitle(noTitleFilters, "Anything")).toBe(true);
  });

  test.each([
    ["Senior Backend Engineer", true],
    ["backend developer", true],
    ["Full-Stack Developer", true],
    ["Data Engineering Manager", false],
    ["Backender", false],
    ["Site Reliability Engineer", true],
    ["Site  reliability Engineer", true],
  ])("includes any of the words or phrases: %s", (title, accepted) => {
    const filters = { include: ["backend", "full-stack", "site reliability"], exclude: [] };
    expect(acceptsTitle(filters, title)).toBe(accepted);
  });

  test.each([
    ["Senior Engineer", false],
    ["Engineer (C++)", false],
    ["Engineer, Intern", false],
    ["Seniority Engineer", true],
    ["Internal Tools Engineer", true],
  ])("excludes every word or phrase: %s", (title, accepted) => {
    const filters = { include: [], exclude: ["senior", "c++", "INTERN", " "] };
    expect(acceptsTitle(filters, title)).toBe(accepted);
  });

  test("applies both lists", () => {
    const filters = { include: ["engineer"], exclude: ["manager"] };
    expect(acceptsTitle(filters, "Engineer")).toBe(true);
    expect(acceptsTitle(filters, "Engineering Manager")).toBe(false);
    expect(acceptsTitle(filters, "Engineer Manager")).toBe(false);
  });
});

describe("canonicalTitleFilters", () => {
  test("lowercases, sorts and dedupes each list", () => {
    expect(
      canonicalTitleFilters({ include: ["Go", "backend", " go "], exclude: ["Senior", ""] }),
    ).toEqual({ include: ["backend", "go"], exclude: ["senior"] });
  });
});
