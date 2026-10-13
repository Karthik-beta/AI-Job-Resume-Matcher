"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useDismissed } from "@/lib/user-flags";

// The statuses and numbers the run card shows, in the order a run goes through them.
const stages: { term: string; meaning: string }[] = [
  { term: "Waiting to start", meaning: "The run is in line and starts in a moment." },
  {
    term: "Found",
    meaning: "Jobs listed on your sources. A job listed on more than one source counts once.",
  },
  { term: "Eligible", meaning: "Jobs that pass your experience, city and job title filters." },
  {
    term: "Checked",
    meaning:
      "Jobs whose full ad was read and compared with your resume, up to your jobs-per-run limit. Each gets a verdict and a reason.",
  },
  {
    term: "Failed",
    meaning:
      "Jobs that couldn't be read or checked, which are tried again on your next run, and matches that couldn't be saved, which you can save from this page with Retry saving match.",
  },
  {
    term: "Stopped",
    meaning: "The run ended early, for the reason shown. Jobs checked so far are kept.",
  },
];

// Shown above the run card on a user's first run, until they close it.
export function FirstRunExplainer({ active }: { active: boolean }) {
  const { dismissed, dismiss } = useDismissed("first-run");
  if (dismissed) return null;

  return (
    <Card size="sm" role="region" aria-labelledby="first-run-title">
      <CardHeader>
        <CardTitle id="first-run-title">What happens during a run</CardTitle>
        <CardAction>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Dismiss run guide"
            className="-mt-1"
            onClick={dismiss}
          >
            <X />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 leading-relaxed">
        <dl className="grid gap-2 sm:grid-cols-[auto_1fr] sm:gap-x-4">
          {stages.map(({ term, meaning }) => (
            <div key={term} className="contents">
              <dt className="font-medium">{term}</dt>
              <dd className="text-muted-foreground">{meaning}</dd>
            </div>
          ))}
        </dl>
        {active && (
          <p className="text-muted-foreground">
            A run usually takes a few minutes. It's safe to leave this page: the run keeps going,
            and if you've added a{" "}
            <Link href="/settings#schedule" className="underline underline-offset-4">
              Discord webhook
            </Link>{" "}
            you'll get an alert for each match.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
