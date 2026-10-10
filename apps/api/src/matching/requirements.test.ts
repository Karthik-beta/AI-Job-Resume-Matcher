import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { acceptsJob, type JobFacts, makeRequirements, type Requirements } from "./requirements";

const requirements: Requirements = {
  experienceYears: 3,
  experienceMonths: 4,
  jobMinYears: 2,
  jobMaxYears: 4,
  locations: ["Bengaluru", "Bangalore"],
  includeUnknown: true,
};

const job = (fields: Partial<JobFacts> = {}): JobFacts => ({
  locations: [],
  experienceMinYears: null,
  experienceMaxYears: null,
  ...fields,
});

describe("acceptsJob", () => {
  test.each([[["bengaluru, Karnataka"]], [["BANGALORE"]], [["Mumbai", "Bengaluru"]]])(
    "accepts city aliases case-insensitively in any listed location %p",
    (locations) => {
      expect(acceptsJob(requirements, job({ locations }))).toBe(true);
    },
  );

  test.each([[["Mumbai"]], [["Bangaloreville"]], [["Remote"]]])(
    "rejects locations without a whole-word city match %p",
    (locations) => {
      expect(acceptsJob(requirements, job({ locations }))).toBe(false);
    },
  );

  test("uses only the configured cities", () => {
    const other = { ...requirements, locations: ["Chennai"] };
    expect(acceptsJob(other, job({ locations: ["Chennai"] }))).toBe(true);
    expect(acceptsJob(other, job({ locations: ["Bangalore"] }))).toBe(false);
  });

  test.each([
    [3, 5],
    [3, null],
    [2, 4],
    [null, 3],
    [3.25, null],
  ])("accepts experience range %p to %p", (min, max) => {
    expect(
      acceptsJob(requirements, job({ experienceMinYears: min, experienceMaxYears: max })),
    ).toBe(true);
  });

  test.each([
    [5, null],
    [4, 6],
    [0, 1],
    [3.5, null],
  ])("rejects experience range %p to %p", (min, max) => {
    expect(
      acceptsJob(requirements, job({ experienceMinYears: min, experienceMaxYears: max })),
    ).toBe(false);
  });

  test("includes unknown details but still excludes known conflicts", () => {
    expect(acceptsJob(requirements, job())).toBe(true);
    expect(acceptsJob(requirements, job({ locations: ["Mumbai"] }))).toBe(false);
    expect(acceptsJob(requirements, job({ experienceMinYears: 6 }))).toBe(false);
  });

  test("excludes unknown details when includeUnknown is off", () => {
    const strict = { ...requirements, includeUnknown: false };
    expect(acceptsJob(strict, job())).toBe(false);
    expect(acceptsJob(strict, job({ locations: ["Bangalore"] }))).toBe(false);
    expect(acceptsJob(strict, job({ experienceMinYears: 3 }))).toBe(false);
    expect(acceptsJob(strict, job({ locations: ["Bangalore"], experienceMinYears: 3 }))).toBe(true);
  });
});

describe("makeRequirements", () => {
  test.each<Partial<Requirements>>([
    { jobMinYears: 5, jobMaxYears: 2 },
    { experienceMonths: 12 },
    { experienceYears: -1 },
  ])("rejects invalid input %p", (input) => {
    const exit = Effect.runSyncExit(makeRequirements(input));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("fills defaults for valid input", () => {
    const result = Effect.runSync(makeRequirements({ experienceYears: 2 }));
    expect(result).toEqual({
      experienceYears: 2,
      experienceMonths: 0,
      jobMinYears: null,
      jobMaxYears: null,
      locations: [],
      includeUnknown: true,
    });
  });
});
