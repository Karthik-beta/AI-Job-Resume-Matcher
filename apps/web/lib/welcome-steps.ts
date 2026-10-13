import type { Onboarding } from "@job-matcher/shared";

export type Steps = Onboarding["steps"];

// The setup wizard's steps, in order. The id is the `step` in the URL.
export const wizardSteps = [
  { id: "welcome", label: "Welcome", heading: "How it works" },
  { id: "resume", label: "Resume", heading: "Add your resume" },
  { id: "preferences", label: "Matching", heading: "Matching basics" },
  { id: "source", label: "Job sources", heading: "Add a job source" },
  { id: "firstRun", label: "First run", heading: "Start your first run" },
] as const;
export type WizardStep = (typeof wizardSteps)[number]["id"];

const isWizardStep = (value: string | null): value is WizardStep =>
  wizardSteps.some((step) => step.id === value);

// Required steps can't be skipped: matching and sources need a resume, the first run a source.
export function reachable(step: WizardStep, steps: Steps) {
  if (step === "welcome" || step === "resume") return true;
  if (step === "firstRun") return steps.resume && steps.source;
  return steps.resume;
}

// The welcome counts as done once anything else is.
export function done(step: WizardStep, steps: Steps) {
  if (step === "welcome") return steps.resume || steps.preferences || steps.source;
  return steps[step];
}

// The step setup continues at: the first missing required step, with the optional matching
// step offered in order after the resume, unless the user chose to keep the defaults. Mirrors
// the API's `nextStep`, which can't know about that choice (it is remembered in the browser).
export function nextStepOf(steps: Steps, skippedPreferences = false): Onboarding["nextStep"] {
  if (!steps.resume) return "resume";
  if (!steps.source) return steps.preferences || skippedPreferences ? "source" : "preferences";
  if (!steps.firstRun) return "firstRun";
  return null;
}

// Where the wizard opens without a step in the URL: the welcome for someone who has done
// nothing yet, otherwise the next step (the first run once all is set).
export function startStep({ steps }: Onboarding, skippedPreferences = false): WizardStep {
  if (!done("welcome", steps)) return "welcome";
  return nextStepOf(steps, skippedPreferences) ?? "firstRun";
}

// The step to show for the URL's `step`: it when known and reachable, otherwise the start step.
export function resolveStep(
  requested: string | null,
  onboarding: Onboarding,
  skippedPreferences = false,
): WizardStep {
  return isWizardStep(requested) && reachable(requested, onboarding.steps)
    ? requested
    : startStep(onboarding, skippedPreferences);
}
