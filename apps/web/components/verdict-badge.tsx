import { Badge } from "@/components/ui/badge";

export type Verdict = "match" | "no-match" | "failed" | "checking";

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  switch (verdict) {
    case "match":
      return <Badge className="bg-match text-primary-foreground">Match</Badge>;
    case "no-match":
      return <Badge variant="outline">No match</Badge>;
    case "failed":
      return <Badge variant="destructive">Couldn't check</Badge>;
    case "checking":
      return (
        <Badge variant="secondary" className="motion-safe:animate-pulse">
          Checking
        </Badge>
      );
  }
}
