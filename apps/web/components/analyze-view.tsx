"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { AppPage } from "@/components/app-page";
import { PastRuns } from "@/components/past-runs";
import { RunCard } from "@/components/run-card";
import { Button, buttonVariants } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import {
  fetchRuns,
  fetchSettings,
  fetchSources,
  isActive,
  type Run,
  type Source,
  startRun,
  useRun,
} from "@/lib/runs";

export function AnalyzeView() {
  return (
    <AppPage title="Analyze">
      <Analyze />
    </AppPage>
  );
}

function Analyze() {
  const sources = useQuery({ queryKey: ["sources"], queryFn: fetchSources });
  const settings = useQuery({ queryKey: ["settings"], queryFn: fetchSettings });
  const runs = useQuery({ queryKey: ["runs"], queryFn: fetchRuns });
  const latest = useRun(runs.data?.[0]?.id);

  if (sources.isError || settings.isError || runs.isError) {
    return <p className="text-destructive">Could not load your runs. Refresh to try again.</p>;
  }
  if (!sources.data || !settings.data || !runs.data) return null;

  // Each missing piece links to its own Settings section.
  const missing = [
    ...(settings.data.resumeUrl
      ? []
      : [{ text: "a resume URL", label: "Add your resume", href: "/settings#resume" }]),
    ...(sources.data.length > 0
      ? []
      : [{ text: "a job source", label: "Add a job source", href: "/settings#sources" }]),
  ];
  if (missing.length > 0) {
    return (
      <div className="flex flex-col items-start gap-4 border-y py-8">
        <p className="text-muted-foreground">
          Add {missing.map(({ text }) => text).join(" and ")} in Settings before your first run.
        </p>
        <div className="flex flex-wrap gap-2">
          {missing.map(({ label, href }, index) => (
            <Link
              key={href}
              href={href}
              className={buttonVariants({ variant: index === 0 ? "default" : "outline" })}
            >
              {label}
            </Link>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <StartForm
        sources={sources.data}
        latest={runs.data[0]}
        running={isRunning(latest.data ?? runs.data[0])}
      />
      {latest.isError && <p className="text-destructive">Could not load the latest run.</p>}
      {latest.data && (
        <section className="flex flex-col gap-4">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-2xl font-bold tracking-tight">Latest run</h2>
            <Link
              href={`/runs/${latest.data.id}`}
              className="text-sm underline-offset-4 hover:underline"
            >
              Details
            </Link>
          </div>
          <RunCard run={latest.data} maxJobsPerRun={settings.data.maxJobsPerRun} />
        </section>
      )}
      <PastRuns runs={runs.data.slice(1)} />
    </>
  );
}

const isRunning = (run: Run | undefined) => run !== undefined && isActive(run.status);

function StartForm({
  sources,
  latest,
  running,
}: {
  sources: readonly Source[];
  latest: Run | undefined;
  running: boolean;
}) {
  const queryClient = useQueryClient();
  const known = new Set(sources.map(({ id }) => id));
  const initial = latest?.sourceIds.filter((id) => known.has(id)) ?? [];
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(initial.length > 0 ? initial : known),
  );

  const start = useMutation({
    mutationFn: startRun,
    onSuccess: (run) => queryClient.setQueryData<Run[]>(["runs"], (runs = []) => [run, ...runs]),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not start the run."),
  });

  function toggle(id: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const chosen = sources.filter(({ id }) => selected.has(id)).map(({ id }) => id);
  const again = latest !== undefined && !running;

  return (
    <section className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 text-2xl font-bold tracking-tight">Job sources</legend>
        {sources.map((source) => (
          <label key={source.id} className="flex items-center gap-3">
            <input
              type="checkbox"
              className="size-4 accent-match"
              checked={selected.has(source.id)}
              onChange={(event) => toggle(source.id, event.target.checked)}
            />
            <span className="truncate">
              {source.query === null ? source.url : `Search: ${source.query}`}
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-col items-start gap-2">
        <Button
          size="lg"
          disabled={chosen.length === 0 || running || start.isPending}
          onClick={() => start.mutate(chosen)}
        >
          {again ? "Analyze again" : "Analyze"}
        </Button>
        {again && (
          <p className="text-sm text-muted-foreground">
            Jobs already checked with the same sources and settings are skipped, so the next run
            continues where this one stopped.
          </p>
        )}
      </div>
    </section>
  );
}
