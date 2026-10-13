import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge";

export type Verdict = "match" | "no-match" | "failed" | "checking" | "expired" | "skipped";

// A badge with a short explanation: a tooltip for the mouse, and text that screen readers read
// after the label. The explanation sits beside the badge, not in it, so the badge's own text
// stays just its label.
export function HintBadge({
  hint,
  children,
  ...props
}: ComponentProps<typeof Badge> & { hint: string }) {
  return (
    <>
      <Badge title={hint} {...props}>
        {children}
      </Badge>
      <span className="sr-only">({hint})</span>
    </>
  );
}

// What each verdict means.
const hints: Record<Verdict, string> = {
  match: "The job ad fits your resume and preferences",
  "no-match": "The job ad doesn't fit closely enough; the reason says why",
  skipped: "Its title looked unlikely to fit, so the ad wasn't read",
  expired: "The posting had closed",
  failed: "The ad couldn't be read or judged; it's tried again on the next run",
  checking: "This job is being checked now",
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const hint = hints[verdict];
  switch (verdict) {
    case "match":
      return (
        <HintBadge className="bg-match text-primary-foreground" hint={hint}>
          Match
        </HintBadge>
      );
    case "no-match":
      return (
        <HintBadge variant="outline" hint={hint}>
          No match
        </HintBadge>
      );
    case "skipped":
      return (
        <HintBadge variant="secondary" hint={hint}>
          Skipped
        </HintBadge>
      );
    case "expired":
      return (
        <HintBadge variant="outline" hint={hint}>
          Expired
        </HintBadge>
      );
    case "failed":
      return (
        <HintBadge variant="destructive" hint={hint}>
          Couldn't check
        </HintBadge>
      );
    case "checking":
      return (
        <HintBadge variant="secondary" className="motion-safe:animate-pulse" hint={hint}>
          Checking
        </HintBadge>
      );
  }
}
