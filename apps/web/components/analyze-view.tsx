"use client";

import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { HeaderNav } from "@/components/header-nav";
import { RunCard } from "@/components/run-card";
import { Button, buttonVariants } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import {
  fetchRun,
  fetchRuns,
  fetchSettings,
  fetchSources,
  isActive,
  type Run,
  type Source,
  startRun,
} from "@/lib/runs";

const pollMs = 2_000;

export function AnalyzeView() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();

  useEffect(() => {
    if (!isPending && !session) router.replace("/sign-in");
  }, [isPending, session, router]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 sm:px-8">
      <header className="flex items-center justify-between py-6">
        <Link href="/" className="text-lg font-bold tracking-tight">
          Job Matcher
        </Link>
        <nav className="flex items-center gap-1">
          <HeaderNav />
        </nav>
      </header>
      <main className="flex max-w-2xl flex-col gap-10 pt-10 pb-24 lg:pt-16">
        <h1 className="text-4xl font-extrabold tracking-[-0.03em]">Analyze</h1>
        {session && <Analyze />}
      </main>
    </div>
  );
}

function Analyze() {
  const sources = useQuery({ queryKey: ["sources"], queryFn: fetchSources });
  const settings = useQuery({ queryKey: ["settings"], queryFn: fetchSettings });
  const runs = useQuery({ queryKey: ["runs"], queryFn: fetchRuns });
  const latestId = runs.data?.[0]?.id;
  const latest = useQuery({
    queryKey: ["runs", latestId],
    queryFn: latestId ? () => fetchRun(latestId) : skipToken,
    refetchInterval: (query) =>
      query.state.data && !isActive(query.state.data.status) ? false : pollMs,
  });

  if (sources.isError || settings.isError || runs.isError) {
    return <p className="text-destructive">Could not load your runs. Refresh to try again.</p>;
  }
  if (!sources.data || !settings.data || !runs.data) return null;

  const missing = [
    ...(settings.data.resumeUrl ? [] : ["a resume URL"]),
    ...(sources.data.length > 0 ? [] : ["a job source"]),
  ];
  if (missing.length > 0) {
    return (
      <div className="flex flex-col items-start gap-4 border-y py-8">
        <p className="text-muted-foreground">
          Add {missing.join(" and ")} in Settings before your first run.
        </p>
        <Link href="/settings" className={buttonVariants()}>
          Go to Settings
        </Link>
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
          <h2 className="text-2xl font-bold tracking-tight">Latest run</h2>
          <RunCard run={latest.data} maxJobsPerRun={settings.data.maxJobsPerRun} />
        </section>
      )}
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
            <span className="truncate">{source.url}</span>
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
