"use client";

import { CheckCircle2, Circle } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useDismissOnboarding } from "@/lib/onboarding";
import type { Overview } from "@/lib/overview";

type Onboarding = Overview["onboarding"];
type Step = keyof Onboarding["steps"];

const items: { step: Step; label: string; href?: string; optional?: boolean }[] = [
  { step: "resume", label: "Add your resume", href: "/settings#resume" },
  { step: "preferences", label: "Tune matching", href: "/settings#matching", optional: true },
  { step: "source", label: "Add a job source", href: "/settings#sources" },
  { step: "firstRun", label: "Run your first check" },
];

const required = items.filter((item) => !item.optional);

// Shown on the home page until onboarding is completed or the user hides it.
export function SetupChecklist({
  onboarding,
  onStartRun,
  starting,
}: {
  onboarding: Onboarding;
  onStartRun: () => void;
  starting: boolean;
}) {
  const dismiss = useDismissOnboarding();
  const { steps, nextStep } = onboarding;
  const doneCount = required.filter((item) => steps[item.step]).length;
  const canRun = steps.resume && steps.source;

  return (
    <ChecklistCard
      title="Get set up"
      description={`${doneCount} of ${required.length} required done`}
    >
      <ul aria-label="Setup steps" className="flex w-full flex-col divide-y text-sm">
        {items.map((item) => {
          const done = steps[item.step];
          return (
            <li
              key={item.step}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5"
            >
              <span className="flex min-w-0 items-center gap-2">
                {done ? (
                  <CheckCircle2 aria-hidden className="size-4 shrink-0 text-match" />
                ) : (
                  <Circle aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                )}
                {item.href ? (
                  <Link href={item.href} className="underline-offset-4 hover:underline">
                    {item.label}
                  </Link>
                ) : (
                  <span>{item.label}</span>
                )}
                <span className="text-muted-foreground">
                  {item.optional ? "(optional) · " : "· "}
                  {done ? "Done" : "Not done"}
                </span>
              </span>
              {item.step === "firstRun" &&
                !done &&
                (canRun ? (
                  <Button size="sm" disabled={starting} onClick={onStartRun}>
                    Start first run
                  </Button>
                ) : (
                  <span className="text-muted-foreground">Needs your resume and a job source</span>
                ))}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Link
          href={nextStep ? `/welcome?step=${nextStep}` : "/welcome"}
          className={buttonVariants()}
        >
          Continue setup
        </Link>
        <Button
          variant="ghost"
          disabled={dismiss.isPending}
          onClick={() =>
            dismiss.mutate(undefined, {
              onError: () => toast.error("Could not hide the checklist. Try again."),
            })
          }
        >
          Hide checklist
        </Button>
      </div>
    </ChecklistCard>
  );
}

const allSetWindow = 24 * 60 * 60 * 1000;
const ackKey = (userId: string) => `ajm:onboarding-all-set-seen:${userId}`;

function readAck(userId: string) {
  try {
    return window.localStorage.getItem(ackKey(userId)) !== null;
  } catch {
    return false;
  }
}

// Whether to show the one-time "You're all set" card: onboarding finished in the last day, the
// checklist wasn't hidden, and this user hasn't closed the card in this browser yet.
export function useAllSet(onboarding: Onboarding | undefined, userId: string | undefined) {
  const [acked, setAcked] = useState<string | null>(null);
  const recent =
    onboarding?.completedAt != null &&
    onboarding.dismissedAt === null &&
    Date.now() - Date.parse(onboarding.completedAt) < allSetWindow;
  const show = recent && userId !== undefined && acked !== userId && !readAck(userId);

  const acknowledge = () => {
    if (!userId) return;
    try {
      window.localStorage.setItem(ackKey(userId), new Date().toISOString());
    } catch {
      // Storage is unavailable; the card still closes for this visit.
    }
    setAcked(userId);
  };

  return { show, acknowledge };
}

export function AllSetCard({ onClose }: { onClose: () => void }) {
  return (
    <ChecklistCard
      title="You're all set"
      description="Setup is done. New matches show up here after each run."
    >
      <Button variant="outline" onClick={onClose}>
        Got it
      </Button>
    </ChecklistCard>
  );
}

function ChecklistCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle className="text-lg font-semibold">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-4">{children}</CardContent>
    </Card>
  );
}
