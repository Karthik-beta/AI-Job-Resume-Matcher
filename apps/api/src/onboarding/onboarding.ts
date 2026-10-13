import {
  defaultSettings,
  type Onboarding,
  type OnboardingStep,
  type UpdateSettings,
} from "@job-matcher/shared";
import type { Settings } from "../generated/prisma/client";

type Steps = Onboarding["steps"];

const same = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((value, index) => value === b[index])
    : a === b;

const preferenceKeys = (Object.keys(defaultSettings) as (keyof UpdateSettings)[]).filter(
  (key) => key !== "resumeUrl",
);

// True once a saved setting other than the resume differs from the defaults. A row alone is not
// enough: saving a resume creates it, and so do the onboarding flags (both with the defaults).
export const hasPreferences = (settings: Settings | null) =>
  settings !== null && preferenceKeys.some((key) => !same(settings[key], defaultSettings[key]));

// The wizard's starting step: the first incomplete required step (resume, source, firstRun).
// Preferences are optional, so they are offered only in wizard order, between a done resume and
// a missing source.
export const nextStepOf = (steps: Steps): OnboardingStep | null => {
  if (!steps.resume) return "resume";
  if (!steps.source) return steps.preferences ? "source" : "preferences";
  if (!steps.firstRun) return "firstRun";
  return null;
};

export const onboardingOf = (
  settings: Settings | null,
  sourceCount: number,
  hasRun: boolean,
): Onboarding => {
  const steps = {
    resume: Boolean(settings?.resumeUrl),
    preferences: hasPreferences(settings),
    source: sourceCount > 0,
    firstRun: hasRun,
  };
  return {
    steps,
    nextStep: nextStepOf(steps),
    completedAt: settings?.onboardingCompletedAt?.toISOString() ?? null,
    dismissedAt: settings?.onboardingDismissedAt?.toISOString() ?? null,
  };
};
