"use client";

import type { MatchStatus } from "@job-matcher/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { useState } from "react";
import { toast } from "sonner";
import { SignedInPage } from "@/components/signed-in-page";
import { Button } from "@/components/ui/button";
import { fetchMatches, type Match, setMatchStatus } from "@/lib/matches";

const tabs: { status: MatchStatus; label: string }[] = [
  { status: "PENDING", label: "Pending" },
  { status: "APPLIED", label: "Applied" },
];

export function MatchesView() {
  return (
    <SignedInPage title="Matches">
      <Matches />
    </SignedInPage>
  );
}

function Matches() {
  const [status, setStatus] = useState<MatchStatus>("PENDING");
  const matches = useQuery({ queryKey: ["matches", status], queryFn: () => fetchMatches(status) });

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
      {matches.data?.length === 0 && (
        <p className="text-muted-foreground">
          {status === "PENDING"
            ? "No pending matches. New matches from your runs appear here."
            : "Nothing marked as applied yet."}
        </p>
      )}
      {matches.data && matches.data.length > 0 && (
        <ul className="divide-y border-y">
          {matches.data.map((match) => (
            <MatchItem key={match.id} match={match} />
          ))}
        </ul>
      )}
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
