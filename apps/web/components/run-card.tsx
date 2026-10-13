import { RetrySaveButton } from "@/components/retry-save-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { HintBadge, type Verdict, VerdictBadge } from "@/components/verdict-badge";
import {
  isActive,
  type JobResult,
  type RunDetail,
  type RunStatus,
  type ScrapeVia,
} from "@/lib/runs";

export const statusLabels: Record<RunStatus, string> = {
  QUEUED: "Waiting to start",
  RUNNING: "Running",
  COMPLETED: "Completed",
  STOPPED: "Stopped",
  FAILED: "Failed",
};

// How the job's ad was read, with a plain explanation shown with the badge.
const scrapedViaLabels: Record<ScrapeVia, { label: string; hint: string }> = {
  ATS: { label: "From job board", hint: "Read from the job board's public listings, at no cost" },
  CACHE: { label: "Saved copy", hint: "Read from a copy saved on an earlier run, at no cost" },
  LOCAL: { label: "Read directly", hint: "Read by visiting the page directly, at no cost" },
  CLOUD: { label: "Read with Firecrawl", hint: "Read with Firecrawl, which uses your credits" },
};

// Remaining is known only when the run read the cloud plan's credits.
function CloudCredits({ run }: { run: RunDetail }) {
  if (run.cloudCreditsAtStart === null && run.cloudCredits === 0) return null;
  const remaining =
    run.cloudCreditsAtStart === null
      ? null
      : Math.max(0, run.cloudCreditsAtStart - run.cloudCredits);
  return (
    <p className="text-sm text-muted-foreground">
      Firecrawl credits used: {run.cloudCredits}
      {remaining !== null && ` · remaining: ${remaining}`}
    </p>
  );
}

function verdictOf(result: JobResult): Verdict {
  if (result.skipped === "EXPIRED") return "expired";
  if (result.skipped === "TRIAGE") return "skipped";
  if (result.error !== null || result.isMatch === null) return "failed";
  return result.isMatch ? "match" : "no-match";
}

const isTriaged = (result: JobResult) => result.skipped === "TRIAGE";

// The API records a title ranking skip as "Skipped by title triage", with the model's reason.
const triagePrefix = /^Skipped by title triage:?\s*/;

function reasonOf(result: JobResult) {
  if (result.error !== null) return result.error;
  if (result.reason === null || !isTriaged(result)) return result.reason;
  const why = result.reason.replace(triagePrefix, "");
  return why === ""
    ? "Its title looks unlikely to fit your resume, so the ad wasn't read."
    : `Its title looks unlikely to fit: ${why}`;
}

// The run stores how many jobs passed the filters, not how many it picked,
// so while it runs, progress is measured against the run size, less the jobs triage skipped.
export const plannedJobs = (run: RunDetail, maxJobsPerRun: number) =>
  Math.min(run.eligible - run.results.filter(isTriaged).length, maxJobsPerRun);

function progressValue(run: RunDetail, maxJobsPerRun: number) {
  if (!isActive(run.status)) return 100;
  const planned = plannedJobs(run, maxJobsPerRun);
  return planned === 0 ? null : (run.checked / planned) * 100;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

export function RunCard({ run, maxJobsPerRun }: { run: RunDetail; maxJobsPerRun: number }) {
  const startedAt = new Date(run.createdAt).toLocaleString();
  const triaged = run.results.filter(isTriaged);
  // Checked jobs first; the ones triage skipped follow.
  const results = [...run.results.filter((result) => !isTriaged(result)), ...triaged];

  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <CardTitle className="text-base">{statusLabels[run.status]}</CardTitle>
          <CardDescription>Started {startedAt}</CardDescription>
        </div>
        {run.stopReason && <p className="text-sm text-destructive">{run.stopReason}</p>}
        <dl className="grid grid-cols-4 gap-4 text-sm">
          <Stat label="Found" value={run.found} />
          <Stat label="Eligible" value={run.eligible} />
          <Stat label="Checked" value={run.checked} />
          <Stat label="Failed" value={run.failed} />
        </dl>
        <CloudCredits run={run} />
        {triaged.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Skipped because their titles look unlikely to fit: {triaged.length}
          </p>
        )}
        <Progress
          value={progressValue(run, maxJobsPerRun)}
          aria-label="Run progress"
          className="[&_[data-slot=progress-indicator]]:bg-match"
        />
      </CardHeader>
      {run.results.length === 0 && !isActive(run.status) && (
        <CardContent>
          <p className="text-sm text-muted-foreground">No jobs were checked in this run.</p>
        </CardContent>
      )}
      {run.results.length > 0 && (
        <CardContent className="px-0">
          <ul>
            {results.map((result, index) => (
              <li key={result.id}>
                {index > 0 && <Separator />}
                <div className="grid gap-1.5 px-(--card-spacing) py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <a
                        href={result.jobUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium leading-snug underline-offset-4 hover:underline"
                      >
                        {result.title}
                      </a>
                      <p className="text-sm text-muted-foreground">{result.company}</p>
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                      {result.scrapedVia && (
                        <HintBadge
                          variant="outline"
                          hint={scrapedViaLabels[result.scrapedVia].hint}
                        >
                          {scrapedViaLabels[result.scrapedVia].label}
                        </HintBadge>
                      )}
                      <VerdictBadge verdict={verdictOf(result)} />
                    </div>
                  </div>
                  {reasonOf(result) && (
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {reasonOf(result)}
                    </p>
                  )}
                  {result.isMatch === true && !result.matchSaved && (
                    <>
                      <p className="text-sm text-destructive">This match could not be saved.</p>
                      <RetrySaveButton runId={run.id} resultId={result.id} />
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}
