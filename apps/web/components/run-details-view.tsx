"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { RunCard } from "@/components/run-card";
import { SignedInPage } from "@/components/signed-in-page";
import { buttonVariants } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { fetchSettings, useRun } from "@/lib/runs";

export function RunDetailsView() {
  const { id } = useParams<{ id: string }>();
  return (
    <SignedInPage title="Run details">
      <RunDetails id={id} />
    </SignedInPage>
  );
}

function RunDetails({ id }: { id: string }) {
  const run = useRun(id);
  const settings = useQuery({ queryKey: ["settings"], queryFn: fetchSettings });

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

  return <RunCard run={run.data} maxJobsPerRun={settings.data.maxJobsPerRun} />;
}
