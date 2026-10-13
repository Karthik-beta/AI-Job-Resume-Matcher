"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { type ReactNode, useEffect } from "react";
import { toast } from "sonner";
import { AppPage } from "@/components/app-page";
import { plannedJobs, statusLabels } from "@/components/run-card";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { type Overview, overviewKey, useOverview } from "@/lib/overview";
import { formatRelative } from "@/lib/relative-time";
import { fetchSettings, fetchSources, isActive, startRun, useRun } from "@/lib/runs";

// What a new user still has to do before a run, in order. The first missing step is the
// one the setup card links to.
const setupSteps: {
  label: string;
  href: string;
  missing: (setup: Overview["setup"]) => boolean;
}[] = [
  { label: "Add your resume", href: "/settings", missing: (setup) => !setup.hasResume },
  { label: "Add a job source", href: "/settings", missing: (setup) => setup.sourceCount === 0 },
];

const scheduleHref = "/settings#schedule";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "es"}`;

export function HomeView() {
  return (
    <AppPage title="Home">
      <Home />
    </AppPage>
  );
}

function Home() {
  const overview = useOverview();

  if (!overview.data) {
    if (overview.isError) {
      return (
        <div className="flex flex-col items-start gap-4 border-y py-8">
          <p className="text-destructive">Could not load your overview.</p>
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
    return <HomeSkeleton />;
  }

  const { setup, activeRun, latestRun, pendingMatches, nextScheduledRunAt } = overview.data;
  const missing = setupSteps.filter((step) => step.missing(setup));
  // While a run is active the primary card shows it, so the latest run card would repeat it.
  const showLatest = latestRun !== null && latestRun.id !== activeRun?.id;

  return (
    <div className="flex flex-col gap-4">
      {activeRun ? (
        <ActiveRunCard runId={activeRun.id} />
      ) : missing.length > 0 ? (
        <SetupCard missing={missing} />
      ) : (
        <StartRunCard firstRun={!setup.hasRun} />
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <PendingMatchesCard count={pendingMatches} />
        {showLatest && <LatestRunCard run={latestRun} />}
      </div>
      <ScheduleLine nextAt={nextScheduledRunAt} />
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading</span>
      <Skeleton className="h-40 w-full rounded-xl" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

function PrimaryCard({
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

function SetupCard({ missing }: { missing: typeof setupSteps }) {
  const [next] = missing;
  return (
    <PrimaryCard
      title="Finish setting up"
      description="A few things are needed before your first run."
    >
      <ul className="list-disc pl-5 text-sm">
        {missing.map((step) => (
          <li key={step.label}>{step.label}</li>
        ))}
      </ul>
      {next && (
        <Link href={next.href} className={buttonVariants()}>
          {next.label}
        </Link>
      )}
    </PrimaryCard>
  );
}

function ActiveRunCard({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const run = useRun(runId);
  const settings = useQuery({ queryKey: ["settings"], queryFn: fetchSettings });
  const finished = run.isError || (run.data !== undefined && !isActive(run.data.status));

  // Once the run settles, refresh the overview so the page moves on to the next action.
  useEffect(() => {
    if (!finished) return;
    void queryClient.invalidateQueries({ queryKey: overviewKey });
    void queryClient.invalidateQueries({ queryKey: ["runs"], exact: true });
  }, [finished, queryClient]);

  const planned =
    run.data && settings.data ? plannedJobs(run.data, settings.data.maxJobsPerRun) : 0;
  let status = "Checking the run…";
  if (run.data?.status === "QUEUED") status = "Waiting to start…";
  else if (run.data?.status === "RUNNING") {
    status =
      planned > 0
        ? `Checking ${Math.min(run.data.checked, planned)} of ${planned} jobs…`
        : "Looking for jobs…";
  } else if (run.data) status = statusLabels[run.data.status];

  return (
    <PrimaryCard title="Run in progress" description={status}>
      <Progress
        value={planned > 0 && run.data ? Math.min(run.data.checked / planned, 1) * 100 : null}
        aria-label="Run progress"
        className="w-full [&_[data-slot=progress-indicator]]:bg-match"
      />
      <Link href={`/runs/${runId}`} className={buttonVariants()}>
        View run
      </Link>
    </PrimaryCard>
  );
}

function StartRunCard({ firstRun }: { firstRun: boolean }) {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: overviewKey });
    void queryClient.invalidateQueries({ queryKey: ["runs"], exact: true });
  };

  // Runs every saved source, as Analyze does when nothing else is picked.
  const start = useMutation({
    mutationFn: async () => {
      const sources = await queryClient.fetchQuery({
        queryKey: ["sources"],
        queryFn: fetchSources,
      });
      return startRun(sources.map(({ id }) => id));
    },
    onSuccess: (run) => {
      queryClient.setQueryData<Overview>(
        overviewKey,
        (overview) => overview && { ...overview, activeRun: { id: run.id, status: "QUEUED" } },
      );
      refresh();
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : "Could not start the run.");
      // Another run is already going; the overview shows it once refreshed.
      if (error instanceof ApiError && error.status === 409) refresh();
    },
  });

  return (
    <PrimaryCard
      title={firstRun ? "Ready for your first run" : "Look for new matches"}
      description="Check every job source for new listings that fit your resume."
    >
      <Button size="lg" disabled={start.isPending} onClick={() => start.mutate()}>
        Start a run
      </Button>
    </PrimaryCard>
  );
}

function PendingMatchesCard({ count }: { count: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pending matches</CardTitle>
        <CardDescription>
          {count === 0 ? "No new matches yet" : `${plural(count, "match")} to review`}
        </CardDescription>
      </CardHeader>
      {count > 0 && (
        <CardContent>
          <Link href="/matches" className={buttonVariants({ variant: "outline" })}>
            Review matches
          </Link>
        </CardContent>
      )}
    </Card>
  );
}

function LatestRunCard({ run }: { run: NonNullable<Overview["latestRun"]> }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Latest run</CardTitle>
          <Badge variant={run.status === "FAILED" ? "destructive" : "secondary"}>
            {statusLabels[run.status]}
          </Badge>
        </div>
        <CardDescription>
          <time dateTime={run.createdAt} title={new Date(run.createdAt).toLocaleString()}>
            Started {formatRelative(run.createdAt)}
          </time>
          {" · "}
          {plural(run.matchCount, "match")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Link
          href={`/runs/${run.id}`}
          className="text-sm underline underline-offset-4 hover:text-foreground"
        >
          View run
        </Link>
      </CardContent>
    </Card>
  );
}

function ScheduleLine({ nextAt }: { nextAt: string | null }) {
  if (nextAt === null) {
    return (
      <p className="text-sm text-muted-foreground">
        Automatic checks are off ·{" "}
        <Link href={scheduleHref} className="text-foreground underline underline-offset-4">
          Turn on
        </Link>
      </p>
    );
  }
  const due = new Date(nextAt).getTime() <= Date.now();
  return (
    <p className="text-sm text-muted-foreground">
      {due ? "Next automatic check is due now" : `Next automatic check ${formatRelative(nextAt)}`}
    </p>
  );
}
