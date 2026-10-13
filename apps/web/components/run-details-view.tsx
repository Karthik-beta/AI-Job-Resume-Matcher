"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { AppPage } from "@/components/app-page";
import { FirstRunExplainer } from "@/components/first-run-explainer";
import { RunCard } from "@/components/run-card";
import { ScoringHelp } from "@/components/scoring-help";
import { buttonVariants } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { fetchRuns, fetchSettings, isActive, type RunDetail, useRun } from "@/lib/runs";

export function RunDetailsView() {
  return (
    <AppPage title="Run details">
      {/* The run id and whether it's the first run are read from the URL, so only the details
          wait for them; the title is part of the prerendered shell. */}
      <Suspense>
        <RunDetails />
      </Suspense>
    </AppPage>
  );
}

// The wizard opens the first run with ?first=1; otherwise a user's only run counts as first.
function useIsFirstRun(id: string) {
  const first = useSearchParams().get("first") === "1";
  // Shares the Analyze page's runs list, so it is usually already cached.
  const runs = useQuery({ queryKey: ["runs"], queryFn: fetchRuns, enabled: !first });
  return first || (runs.data?.length === 1 && runs.data[0]?.id === id);
}

function RunDetails() {
  const { id } = useParams<{ id: string }>();
  const run = useRun(id);
  const settings = useQuery({ queryKey: ["settings"], queryFn: fetchSettings });
  const firstRun = useIsFirstRun(id);

  if (run.error instanceof ApiError && run.error.status === 404) {
    return (
      <div className="flex flex-col items-start gap-4 border-y py-8">
        <p className="text-muted-foreground">This run doesn't exist or belongs to someone else.</p>
        <Link href="/analyze" className={buttonVariants()}>
          Back to Analyze
        </Link>
      </div>
    );
  }
  if (run.isError || settings.isError) {
    return <p className="text-destructive">Could not load this run. Refresh to try again.</p>;
  }
  if (!run.data || !settings.data) return null;

  return (
    <div className="flex flex-col gap-6">
      {firstRun && <FirstRunExplainer active={isActive(run.data.status)} />}
      <RunOutcome run={run.data} />
      <RunCard run={run.data} maxJobsPerRun={settings.data.maxJobsPerRun} />
      <ScoringHelp />
    </div>
  );
}

const linkClass = "font-medium text-foreground underline underline-offset-4";

// What to do once the run has ended: open the matches, or widen the search when there are none.
function RunOutcome({ run }: { run: RunDetail }) {
  if (isActive(run.status) || run.status === "FAILED") return null;
  const matches = run.results.filter((result) => result.isMatch === true).length;
  // Title ranking skipped every new job, so none was read.
  const allTriaged =
    run.checked === 0 &&
    run.results.length > 0 &&
    run.results.every((result) => result.skipped === "TRIAGE");

  if (matches > 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted px-4 py-3 text-sm">
        <p>
          This run found {matches} {matches === 1 ? "job that fits" : "jobs that fit"} your resume.
        </p>
        <Link href="/matches" className={buttonVariants({ size: "sm" })}>
          See your matches
        </Link>
      </div>
    );
  }
  // A stopped run says why above its numbers; fixing that comes before widening the search.
  if (run.status !== "COMPLETED") return null;

  return (
    <div className="rounded-lg bg-muted px-4 py-3 text-sm leading-relaxed">
      <p className="font-medium">No matches this time</p>
      <p className="text-muted-foreground">
        {allTriaged ? (
          <>
            Title ranking judged the titles of all {run.results.length} new{" "}
            {run.results.length === 1 ? "job" : "jobs"} unlikely to fit your resume, so none were
            read. Try{" "}
            <Link href="/settings#sources" className={linkClass}>
              more sources
            </Link>{" "}
            or turn off{" "}
            <Link href="/settings#runs" className={linkClass}>
              title ranking
            </Link>
            .
          </>
        ) : run.found === 0 ? (
          <>
            Your sources listed no jobs. Check their URLs or{" "}
            <Link href="/settings#sources" className={linkClass}>
              add more sources
            </Link>
            .
          </>
        ) : (
          <>
            {run.eligible === 0
              ? `None of the ${run.found} jobs found passed your filters.`
              : run.checked === 0
                ? "No new jobs were checked this time."
                : "None of the jobs checked fit your resume closely enough."}{" "}
            Try{" "}
            <Link href="/settings#sources" className={linkClass}>
              more sources
            </Link>{" "}
            or loosen the{" "}
            <Link href="/settings#matching" className={linkClass}>
              title and experience filters
            </Link>
            .
          </>
        )}
      </p>
    </div>
  );
}
