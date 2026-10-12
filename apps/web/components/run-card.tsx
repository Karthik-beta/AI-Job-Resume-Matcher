import { RetrySaveButton } from "@/components/retry-save-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { type Verdict, VerdictBadge } from "@/components/verdict-badge";
import { isActive, type JobResult, type RunDetail, type RunStatus } from "@/lib/runs";

export const statusLabels: Record<RunStatus, string> = {
  QUEUED: "Waiting to start",
  RUNNING: "Running",
  COMPLETED: "Completed",
  STOPPED: "Stopped",
  FAILED: "Failed",
};

function verdictOf(result: JobResult): Verdict {
  if (result.skipped === "EXPIRED") return "expired";
  if (result.skipped === "TRIAGE") return "skipped";
  if (result.error !== null || result.isMatch === null) return "failed";
  return result.isMatch ? "match" : "no-match";
}

const isTriaged = (result: JobResult) => result.skipped === "TRIAGE";

// The run stores how many jobs passed the filters, not how many it picked,
// so while it runs the bar measures against the run size, less the jobs triage skipped.
function progressValue(run: RunDetail, maxJobsPerRun: number) {
  if (!isActive(run.status)) return 100;
  const planned = Math.min(run.eligible - run.results.filter(isTriaged).length, maxJobsPerRun);
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
        {triaged.length > 0 && (
          <p className="text-sm text-muted-foreground">Skipped by title triage: {triaged.length}</p>
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
                    <VerdictBadge verdict={verdictOf(result)} />
                  </div>
                  {(result.error ?? result.reason) && (
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {result.error ?? result.reason}
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
