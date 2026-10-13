"use client";

import type { MatchStatus } from "@job-matcher/shared";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { AppPage } from "@/components/app-page";
import { ScoringHelp } from "@/components/scoring-help";
import { Button, buttonVariants } from "@/components/ui/button";
import { fetchMatches, type Match, setMatchStatus } from "@/lib/matches";
import { useOverview } from "@/lib/overview";

const tabs: { status: MatchStatus; label: string }[] = [
  { status: "PENDING", label: "Pending" },
  { status: "APPLIED", label: "Applied" },
];

export function MatchesView() {
  return (
    <AppPage title="Matches">
      <Matches />
    </AppPage>
  );
}

function Matches() {
  const [status, setStatus] = useState<MatchStatus>("PENDING");
  const matches = useInfiniteQuery({
    queryKey: ["matches", status],
    queryFn: ({ pageParam }) => fetchMatches(status, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
  const items = matches.data?.pages.flatMap((page) => page.items);

  return (
    <div className="flex flex-col gap-6">
      <fieldset className="flex gap-1 border-b">
        <legend className="sr-only">Application status</legend>
        {tabs.map((tab) => (
          <button
            key={tab.status}
            type="button"
            aria-pressed={status === tab.status}
            onClick={() => setStatus(tab.status)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
              status === tab.status
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </fieldset>
      {matches.isError && <p className="text-destructive">Could not load your matches.</p>}
      {items?.length === 0 &&
        (status === "PENDING" ? (
          <NoPendingMatches />
        ) : (
          <p className="text-muted-foreground">Nothing marked as applied yet.</p>
        ))}
      {items && items.length > 0 && (
        <ul className="divide-y border-y">
          {items.map((match) => (
            <MatchItem key={match.id} match={match} />
          ))}
        </ul>
      )}
      {matches.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          disabled={matches.isFetchingNextPage}
          onClick={() => matches.fetchNextPage()}
        >
          {matches.isFetchingNextPage ? "Loading" : "Load more"}
        </Button>
      )}
      {items && items.length > 0 && <ScoringHelp />}
    </div>
  );
}

// The next step depends on whether the user has run a check yet.
function NoPendingMatches() {
  const overview = useOverview();
  const hasRun = overview.data?.setup.hasRun;
  const action = (label: string) => (
    <Link href="/analyze" className={buttonVariants({ variant: "outline" })}>
      {label}
    </Link>
  );

  if (hasRun === false) {
    return (
      <div className="flex flex-col items-start gap-4">
        <p className="text-muted-foreground">
          No matches yet. Run a check to find jobs that fit your resume.
        </p>
        {action("Run a check")}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-4">
      <p className="text-muted-foreground">
        No pending matches. New matches from your runs appear here.
      </p>
      {hasRun && action("Run another check")}
    </div>
  );
}

function MatchItem({ match }: { match: Match }) {
  const queryClient = useQueryClient();
  const next: MatchStatus = match.status === "PENDING" ? "APPLIED" : "PENDING";
  const update = useMutation({
    mutationFn: () => setMatchStatus(match.id, next),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["matches"] }),
    onError: () => toast.error("Could not update the match."),
  });

  return (
    <li className="flex flex-col gap-2 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <a
            href={match.jobUrl}
            target="_blank"
            rel="noreferrer"
            className="font-medium leading-snug underline-offset-4 hover:underline"
          >
            {match.title}
          </a>
          <p className="text-sm text-muted-foreground">
            {[match.company, ...match.locations].join(", ")} ·{" "}
            {new Date(match.matchedAt).toLocaleDateString()}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={update.isPending}
          onClick={() => update.mutate()}
        >
          {next === "APPLIED" ? "Mark applied" : "Move to pending"}
        </Button>
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">{match.reason}</p>
    </li>
  );
}
