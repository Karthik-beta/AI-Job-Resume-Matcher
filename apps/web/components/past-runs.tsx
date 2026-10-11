import Link from "next/link";
import { statusLabels } from "@/components/run-card";
import type { Run } from "@/lib/runs";

export function PastRuns({ runs }: { runs: readonly Run[] }) {
  if (runs.length === 0) return null;

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
