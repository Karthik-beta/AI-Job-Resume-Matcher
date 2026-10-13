import { Badge } from "@/components/ui/badge";

export type Verdict = "match" | "no-match" | "failed" | "checking" | "expired" | "skipped";

// What each verdict means, shown as the badge's tooltip.
const hints: Record<Verdict, string> = {
  match: "The job ad fits your resume and preferences",
  "no-match": "The job ad doesn't fit closely enough; the reason says why",
  skipped: "Its title looked unlikely to fit, so the ad wasn't read",
  expired: "The posting had closed",
  failed: "The ad couldn't be read or judged; it's tried again on the next run",
  checking: "This job is being checked now",
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const title = hints[verdict];
  switch (verdict) {
    case "match":
      return (
        <Badge className="bg-match text-primary-foreground" title={title}>
          Match
        </Badge>
      );
    case "no-match":
      return (
        <Badge variant="outline" title={title}>
          No match
        </Badge>
      );
    case "skipped":
      return (
        <Badge variant="secondary" title={title}>
          Skipped
        </Badge>
      );
    case "expired":
      return (
        <Badge variant="outline" title={title}>
          Expired
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" title={title}>
          Couldn't check
        </Badge>
      );
    case "checking":
      return (
        <Badge variant="secondary" className="motion-safe:animate-pulse" title={title}>
          Checking
        </Badge>
      );
  }
}
