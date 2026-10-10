import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";

type Segment = string | { met: string };

type ExampleJob = {
  title: string;
  company: string;
  location: string;
  verdict: "match" | "no-match" | "failed" | "checking";
  reason: Segment[];
};

const jobs: ExampleJob[] = [
  {
    title: "Backend Engineer, Payments",
    company: "Northwind Labs",
    location: "Bengaluru",
    verdict: "match",
    reason: [
      "Asks for ",
      { met: "2–4 years with Node.js" },
      " and ",
      { met: "PostgreSQL" },
      ". The resume shows three years building NestJS services on Postgres.",
    ],
  },
  {
    title: "Senior Platform Engineer",
    company: "Tidepool Systems",
    location: "Pune",
    verdict: "no-match",
    reason: ["Requires 6+ years running Kubernetes in production. The resume shows one year."],
  },
  {
    title: "Full Stack Developer",
    company: "Fieldnote",
    location: "Remote",
    verdict: "match",
    reason: [
      "Wants ",
      { met: "React and TypeScript" },
      " with some ",
      { met: "API design" },
      ". Both appear in the last two roles.",
    ],
  },
  {
    title: "Software Engineer II",
    company: "Larkspur Health",
    location: "Bengaluru",
    verdict: "failed",
    reason: ["The listing page didn't load. It's counted as failed and skipped."],
  },
  {
    title: "Backend Developer, Search",
    company: "Copperline",
    location: "Hyderabad",
    verdict: "checking",
    reason: [],
  },
];

const checked = jobs.filter((job) => job.verdict !== "checking").length;

function Verdict({ verdict }: { verdict: ExampleJob["verdict"] }) {
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

function Reason({ segments }: { segments: Segment[] }) {
  return (
    <p className="text-sm leading-relaxed text-muted-foreground">
      {segments.map((segment) =>
        typeof segment === "string" ? (
          segment
        ) : (
          <mark
            key={segment.met}
            className="rounded-[2px] bg-highlight/70 px-0.5 text-foreground [box-decoration-break:clone]"
          >
            {segment.met}
          </mark>
        ),
      )}
    </p>
  );
}

export function ExampleRun() {
  return (
    <Card className="[--card-spacing:--spacing(5)] shadow-[0_1px_0_var(--border),0_12px_32px_-12px_rgb(28_42_35/0.25)]">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <CardTitle className="text-base">Example run</CardTitle>
          <CardDescription>2 job boards, started 4 minutes ago</CardDescription>
        </div>
        <dl className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <dt className="text-muted-foreground">Found</dt>
            <dd className="text-2xl font-semibold tabular-nums">48</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Eligible</dt>
            <dd className="text-2xl font-semibold tabular-nums">11</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Checked</dt>
            <dd className="text-2xl font-semibold tabular-nums">
              {checked}
              <span className="text-base font-normal text-muted-foreground"> of {jobs.length}</span>
            </dd>
          </div>
        </dl>
        <Progress
          value={(checked / jobs.length) * 100}
          aria-label="Run progress"
          className="[&_[data-slot=progress-indicator]]:bg-match"
        />
      </CardHeader>
      <CardContent className="px-0">
        <ul>
          {jobs.map((job, index) => (
            <li key={job.title}>
              {index > 0 && <Separator />}
              <div className="grid gap-1.5 px-(--card-spacing) py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium leading-snug">{job.title}</p>
                    <p className="text-sm text-muted-foreground">
                      {job.company}, {job.location}
                    </p>
                  </div>
                  <Verdict verdict={job.verdict} />
                </div>
                {job.reason.length > 0 && <Reason segments={job.reason} />}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
