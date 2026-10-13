import { describe, expect, test } from "bun:test";
import { defaultSettings } from "@job-matcher/shared";
import type { Settings } from "../generated/prisma/client";
import { hasPreferences, nextStepOf, onboardingOf } from "./onboarding";

const row = (changes: Partial<Settings> = {}): Settings => ({
  userId: "user-1",
  ...defaultSettings,
  locations: [],
  titleInclude: [],
  titleExclude: [],
  onboardingCompletedAt: null,
  onboardingDismissedAt: null,
  ...changes,
});

const steps = (
  done: Partial<Record<"resume" | "preferences" | "source" | "firstRun", boolean>>,
) => ({
  resume: false,
  preferences: false,
  source: false,
  firstRun: false,
  ...done,
});

describe("hasPreferences", () => {
  test("is false without a row, or with only the defaults and a resume", () => {
    expect(hasPreferences(null)).toBe(false);
    expect(hasPreferences(row())).toBe(false);
    expect(hasPreferences(row({ resumeUrl: "https://example.com/cv.pdf" }))).toBe(false);
    // A row the onboarding flags created holds the defaults.
    expect(hasPreferences(row({ onboardingDismissedAt: new Date() }))).toBe(false);
  });

  test.each<Partial<Settings>>([
    { experienceYears: 3 },
    { locations: ["Remote"] },
    { titleExclude: ["senior"] },
    { includeUnknown: false },
    { scheduleMinutes: 60 },
    { discordWebhookUrl: "https://discord.com/api/webhooks/1/x" },
  ])("is true once a setting differs from the defaults: %o", (changes) => {
    expect(hasPreferences(row(changes))).toBe(true);
  });
});

describe("nextStepOf", () => {
  test("starts at the resume", () => {
    expect(nextStepOf(steps({}))).toBe("resume");
    expect(nextStepOf(steps({ preferences: true, source: true }))).toBe("resume");
  });

  test("offers preferences between the resume and the first source", () => {
    expect(nextStepOf(steps({ resume: true }))).toBe("preferences");
    expect(nextStepOf(steps({ resume: true, preferences: true }))).toBe("source");
  });

  test("skips preferences once a source exists", () => {
    expect(nextStepOf(steps({ resume: true, source: true }))).toBe("firstRun");
  });

  test("is null once the required steps are done, with or without preferences", () => {
    expect(nextStepOf(steps({ resume: true, source: true, firstRun: true }))).toBeNull();
    expect(
      nextStepOf(steps({ resume: true, preferences: true, source: true, firstRun: true })),
    ).toBeNull();
  });
});

describe("onboardingOf", () => {
  test("reports a new user", () => {
    expect(onboardingOf(null, 0, false)).toEqual({
      steps: steps({}),
      nextStep: "resume",
      completedAt: null,
      dismissedAt: null,
    });
  });

  test("reports the steps and the stored times", () => {
    const settings = row({
      resumeUrl: "https://example.com/cv.pdf",
      locations: ["Remote"],
      onboardingCompletedAt: new Date("2026-10-13T10:00:00.000Z"),
      onboardingDismissedAt: new Date("2026-10-13T11:00:00.000Z"),
    });
    expect(onboardingOf(settings, 2, true)).toEqual({
      steps: steps({ resume: true, preferences: true, source: true, firstRun: true }),
      nextStep: null,
      completedAt: "2026-10-13T10:00:00.000Z",
      dismissedAt: "2026-10-13T11:00:00.000Z",
    });
  });
});
