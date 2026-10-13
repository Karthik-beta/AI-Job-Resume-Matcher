"use client";

import { useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { Check } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AppPage } from "@/components/app-page";
import { Button, buttonVariants } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  FirstRunStep,
  PreferencesStep,
  ResumeStep,
  SourceStep,
  WelcomeStep,
} from "@/components/welcome-steps";
import { type Overview, overviewKey, useOverview } from "@/lib/overview";
import {
  done,
  reachable,
  resolveStep,
  type Steps,
  type WizardStep,
  wizardSteps,
} from "@/lib/welcome-steps";

export function WelcomeView() {
  return (
    <AppPage title="Get set up">
      <Wizard />
    </AppPage>
  );
}

function Wizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const overview = useOverview();
  const data = overview.data;

  // Whether setup was already finished when the page opened. Decided once, so starting the
  // first run (which completes setup) doesn't send the user home instead of to the run.
  const [finishedOnArrival, setFinishedOnArrival] = useState<boolean | null>(null);
  if (data && finishedOnArrival === null) {
    setFinishedOnArrival(data.onboarding.completedAt !== null);
  }
  useEffect(() => {
    if (finishedOnArrival) router.replace("/home");
  }, [finishedOnArrival, router]);

  // The step lives in the URL so refresh and the browser's back button keep it. A missing,
  // unknown or not yet reachable step is replaced by the one the user should be on.
  const requested = searchParams.get("step");
  const step = data ? resolveStep(requested, data.onboarding) : null;
  useEffect(() => {
    if (finishedOnArrival === false && step && requested !== step) {
      router.replace(`/welcome?step=${step}`, { scroll: false });
    }
  }, [finishedOnArrival, step, requested, router]);

  // Focus moves to the step's heading whenever the step changes, but not on first load.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef<WizardStep | null>(null);
  useEffect(() => {
    if (!step || finishedOnArrival !== false) return;
    if (shownStep.current !== null && shownStep.current !== step) headingRef.current?.focus();
    shownStep.current = step;
  }, [step, finishedOnArrival]);

  if (!data || finishedOnArrival !== false || !step) {
    if (overview.isError) {
      return (
        <div className="flex flex-col items-start gap-4 border-y py-8">
          <p className="text-destructive">Could not load your setup.</p>
          <Button
            variant="outline"
            disabled={overview.isFetching}
            onClick={() => overview.refetch()}
          >
            Try again
          </Button>
        </div>
      );
    }
    return <WizardSkeleton />;
  }

  const steps = data.onboarding.steps;
  const go = (next: WizardStep) => router.push(`/welcome?step=${next}`, { scroll: false });

  // Saved changes are written into the cached overview before moving on, so the next step is
  // reachable at once rather than after the overview is refetched.
  const markStep = (key: keyof Steps, value: boolean, sourceCount?: number) =>
    queryClient.setQueryData<Overview>(overviewKey, (current) =>
      current
        ? {
            ...current,
            setup: sourceCount === undefined ? current.setup : { ...current.setup, sourceCount },
            onboarding: {
              ...current.onboarding,
              steps: { ...current.onboarding.steps, [key]: value },
            },
          }
        : current,
    );

  const index = wizardSteps.findIndex(({ id }) => id === step);
  const current = wizardSteps[index] ?? wizardSteps[0];

  return (
    <div className="flex flex-col gap-8">
      <StepProgress step={step} index={index} steps={steps} />
      <section aria-labelledby="wizard-step-heading" className="flex flex-col gap-6">
        <h2
          id="wizard-step-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-2xl font-bold tracking-tight outline-none"
        >
          {current.heading}
        </h2>
        {step === "welcome" && <WelcomeStep onStart={() => go("resume")} />}
        {step === "resume" && (
          <ResumeStep
            saved={steps.resume}
            onSaved={(settings) => {
              markStep("resume", settings.resumeUrl !== null);
              if (settings.resumeUrl !== null) go("preferences");
            }}
            onBack={() => go("welcome")}
            onNext={() => go("preferences")}
          />
        )}
        {step === "preferences" && (
          <PreferencesStep
            onSaved={() => go("source")}
            onBack={() => go("resume")}
            onSkip={() => go("source")}
          />
        )}
        {step === "source" && (
          <SourceStep
            hasSource={steps.source}
            onChange={(sources) => markStep("source", sources.length > 0, sources.length)}
            onBack={() => go("preferences")}
            onNext={() => go("firstRun")}
          />
        )}
        {step === "firstRun" && (
          <FirstRunStep
            sourceCount={data.setup.sourceCount}
            activeRunId={data.activeRun?.id ?? null}
            onBack={() => go("source")}
          />
        )}
      </section>
    </div>
  );
}

function StepProgress({ step, index, steps }: { step: WizardStep; index: number; steps: Steps }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <p className="text-sm font-medium">
          Step {index + 1} of {wizardSteps.length}
          <span className="text-muted-foreground"> · {wizardSteps[index]?.label}</span>
        </p>
        {step !== "welcome" && (
          <Link
            href="/home"
            className={cn(buttonVariants({ variant: "link" }), "h-auto px-0 text-muted-foreground")}
          >
            Finish later
          </Link>
        )}
      </div>
      <Progress
        value={((index + 1) / wizardSteps.length) * 100}
        aria-label="Setup progress"
        getAriaValueText={() => `Step ${index + 1} of ${wizardSteps.length}`}
        className="w-full"
      />
      <nav aria-label="Setup steps" className="hidden sm:block">
        <ol className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          {wizardSteps.map(({ id, label }, position) => {
            const isCurrent = id === step;
            const isDone = done(id, steps);
            const content = (
              <>
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-flex size-5 items-center justify-center rounded-full border text-xs tabular-nums",
                    isDone && "border-primary bg-primary text-primary-foreground",
                    isCurrent && !isDone && "border-foreground",
                  )}
                >
                  {isDone ? <Check className="size-3" /> : position + 1}
                </span>
                {label}
                {isDone && <span className="sr-only"> (done)</span>}
              </>
            );
            return (
              <li key={id}>
                {reachable(id, steps) && !isCurrent ? (
                  <Link
                    href={`/welcome?step=${id}`}
                    scroll={false}
                    className="inline-flex items-center gap-1.5 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {content}
                  </Link>
                ) : (
                  <span
                    aria-current={isCurrent ? "step" : undefined}
                    className={cn(
                      "inline-flex items-center gap-1.5",
                      isCurrent ? "font-medium" : "text-muted-foreground/60",
                    )}
                  >
                    {content}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    </div>
  );
}

function WizardSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading</span>
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-1 w-full" />
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
    </div>
  );
}
