"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { statusLabels } from "@/components/run-card";
import { fetchRuns, type Run } from "@/lib/runs";

// The runs before the latest one. Analyze shows the latest run above, so the list is left out
// while that is the only run; with no runs at all it points to the start button above it.
export function PastRuns({ runs }: { runs: readonly Run[] }) {
  // The same list Analyze loaded, read from the cache to tell "no runs" from "only the latest".
  const all = useQuery({ queryKey: ["runs"], queryFn: fetchRuns });

  if (runs.length === 0) {
    if (all.data?.length !== 0) return null;
    return (
      <section className="flex flex-col gap-4">
        <h2 className="text-2xl font-bold tracking-tight">Past runs</h2>
        <p className="border-y py-6 text-muted-foreground">
          No runs yet. Start your first run with the Analyze button above.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-2xl font-bold tracking-tight">Past runs</h2>
      <ul className="divide-y border-y">
        {runs.map((run) => (
          <li key={run.id}>
            <Link
              href={`/runs/${run.id}`}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3 hover:bg-muted/50"
            >
              <span className="font-medium">{new Date(run.createdAt).toLocaleString()}</span>
              <span className="text-sm text-muted-foreground tabular-nums">
                {statusLabels[run.status]}, {run.checked} checked, {run.failed} failed
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
