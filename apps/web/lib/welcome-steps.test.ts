/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { Onboarding } from "@job-matcher/shared";
import { nextStepOf, resolveStep } from "./welcome-steps";

const onboarding = (
  steps: Partial<Onboarding["steps"]>,
  nextStep: Onboarding["nextStep"],
): Onboarding => ({
  steps: { resume: false, preferences: false, source: false, firstRun: false, ...steps },
  nextStep,
  completedAt: null,
  dismissedAt: null,
});

const fresh = onboarding({}, "resume");
const resumeOnly = onboarding({ resume: true }, "preferences");
const withPreferences = onboarding({ resume: true, preferences: true }, "source");
const ready = onboarding({ resume: true, source: true }, "firstRun");
const allDone = onboarding({ resume: true, source: true, firstRun: true }, null);

describe("resolveStep", () => {
  test("opens a new user at the welcome", () => {
    expect(resolveStep(null, fresh)).toBe("welcome");
  });

  test.each([
    [resumeOnly, "preferences"],
    [withPreferences, "source"],
    [ready, "firstRun"],
    [allDone, "firstRun"],
  ] as const)("opens at the next step without one in the URL", (state, expected) => {
    expect(resolveStep(null, state)).toBe(expected);
  });

  test.each([
    ["bogus", ready, "firstRun"],
    ["", resumeOnly, "preferences"],
  ] as const)("replaces an unknown step %p", (requested, state, expected) => {
    expect(resolveStep(requested, state)).toBe(expected);
  });

  test.each([
    ["preferences", fresh, "welcome"],
    ["source", fresh, "welcome"],
    ["firstRun", resumeOnly, "preferences"],
    ["firstRun", withPreferences, "source"],
  ] as const)("does not skip past a required step to %p", (requested, state, expected) => {
    expect(resolveStep(requested, state)).toBe(expected);
  });

  test.each([
    ["welcome", ready],
    ["resume", ready],
    ["preferences", ready],
    ["source", ready],
    ["resume", fresh],
    ["source", resumeOnly],
  ] as const)("revisits %p", (requested, state) => {
    expect(resolveStep(requested, state)).toBe(requested);
  });
});

describe("after the user chose to keep the default matching settings", () => {
  test.each([
    [resumeOnly, "source"],
    [withPreferences, "source"],
    [ready, "firstRun"],
  ] as const)("opens past the matching step", (state, expected) => {
    expect(resolveStep(null, state, true)).toBe(expected);
  });

  test("still opens a new user at the welcome", () => {
    expect(resolveStep(null, fresh, true)).toBe("welcome");
  });

  test("still lets them revisit the matching step", () => {
    expect(resolveStep("preferences", resumeOnly, true)).toBe("preferences");
  });
});

describe("nextStepOf", () => {
  test.each([
    [fresh, false, "resume"],
    [fresh, true, "resume"],
    [resumeOnly, false, "preferences"],
    [resumeOnly, true, "source"],
    [withPreferences, false, "source"],
    [ready, false, "firstRun"],
    [allDone, false, null],
  ] as const)("matches the API's order (skipped matching: %#)", (state, skipped, expected) => {
    expect(nextStepOf(state.steps, skipped)).toBe(expected);
  });
});
