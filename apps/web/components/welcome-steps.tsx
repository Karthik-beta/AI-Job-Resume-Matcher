"use client";

import type { UpdateSettings } from "@job-matcher/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { type JobSource, JobSources } from "@/components/job-sources";
import { MatchingSection } from "@/components/matching-section";
import { ResumeSection } from "@/components/resume-section";
import { EmbeddedSections } from "@/components/settings-section";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { fetchOverview, overviewKey } from "@/lib/overview";
import { fetchSources, startRun } from "@/lib/runs";
import { useEditableSettings } from "@/lib/settings";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

// Back, and the step's way forward, under its form.
function StepActions({ onBack, children }: { onBack?: () => void; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t pt-6">
      {onBack && (
        <Button variant="outline" size="lg" onClick={onBack}>
          Back
        </Button>
      )}
      {children}
    </div>
  );
}

function Examples({ title, items, tone }: { title: string; items: ReactNode[]; tone?: "bad" }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <ul
        className={cn(
          "flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground",
          tone === "bad" && "marker:text-destructive",
        )}
      >
        {items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of examples
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

const Code = ({ children }: { children: ReactNode }) => (
  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs break-all text-foreground">
    {children}
  </code>
);

export function WelcomeStep({ onStart }: { onStart: () => void }) {
  return (
    <>
      <ol className="flex list-decimal flex-col gap-3 pl-5 text-lg marker:text-muted-foreground">
        <li>We read your resume.</li>
        <li>We check the job pages you add for new listings.</li>
        <li>We score each listing for how well it fits you, and keep the matches.</li>
      </ol>
      <p className="text-muted-foreground">Setup takes a few minutes. You can finish it later.</p>
      <div className="flex flex-wrap items-center gap-3 border-t pt-6">
        <Button size="lg" onClick={onStart}>
          Let's set up
        </Button>
        <Link href="/home" className={buttonVariants({ variant: "ghost", size: "lg" })}>
          Skip for now
        </Link>
      </div>
    </>
  );
}

export function ResumeStep({
  saved,
  onSaved,
  onBack,
  onNext,
}: {
  // Whether a resume is saved already, so the user may move on without saving again.
  saved: boolean;
  onSaved: (settings: UpdateSettings) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <>
      <p>Every job is checked against your resume. Paste a link to it that anyone can open.</p>
      <div className="grid gap-6 sm:grid-cols-2">
        <Examples
          title="Links that work"
          items={[
            <>
              A public link to a PDF, like <Code>https://example.com/resume.pdf</Code>
            </>,
            "A Google Drive or Dropbox share link to a PDF, shared with anyone who has the link",
            "A page anyone can open, such as a Google Doc shared with anyone who has the link",
          ]}
        />
        <Examples
          title="Links that don't"
          tone="bad"
          items={[
            "A Google Drive or Dropbox link only you can open",
            "A LinkedIn profile, which needs signing in to read",
          ]}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        The resume is read when a run starts, so check the link opens in a private browser window.
      </p>
      <EmbeddedSections>
        <ResumeSection onSaved={onSaved} />
      </EmbeddedSections>
      <StepActions onBack={onBack}>
        <Button size="lg" disabled={!saved} onClick={onNext}>
          Next
        </Button>
        {!saved && <p className="text-sm text-muted-foreground">Save a resume link to continue.</p>}
      </StepActions>
    </>
  );
}

export function PreferencesStep({
  onSaved,
  onBack,
  onSkip,
}: {
  onSaved: () => void;
  onBack: () => void;
  onSkip: () => void;
}) {
  return (
    <>
      <p>
        Listings outside your experience, cities or job titles are skipped before they are read, so
        runs only spend time on jobs that could fit. Everything starts at the defaults: change what
        you like and save, or keep them.
      </p>
      <EmbeddedSections>
        <MatchingSection onSaved={onSaved} />
      </EmbeddedSections>
      <p className="text-sm text-muted-foreground">
        How many jobs each run reads, title ranking and scheduled checks stay in{" "}
        <Link href="/settings#runs" className="underline underline-offset-4 hover:text-foreground">
          Settings
        </Link>
        , where you can change them any time.
      </p>
      <StepActions onBack={onBack}>
        <Button variant="secondary" size="lg" onClick={onSkip}>
          Use defaults
        </Button>
      </StepActions>
    </>
  );
}

export function SourceStep({
  hasSource,
  onChange,
  onBack,
  onNext,
}: {
  hasSource: boolean;
  onChange: (sources: readonly JobSource[]) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <>
      <Examples
        title="What you can add"
        items={[
          <>
            A Greenhouse, Lever, Ashby, SmartRecruiters or Recruitee job board, like{" "}
            <Code>https://boards.greenhouse.io/stripe</Code> or{" "}
            <Code>https://jobs.lever.co/company</Code>
          </>,
          <>
            Any company's careers page, like <Code>https://example.com/careers</Code>
          </>,
          "A search of those job boards, like “backend engineer typescript”",
        ]}
      />
      <p className="text-sm text-muted-foreground">
        Each source shows the type it was detected as. Add as many as you like.
      </p>
      <EmbeddedSections>
        <JobSources onChange={onChange} />
      </EmbeddedSections>
      <StepActions onBack={onBack}>
        <Button size="lg" disabled={!hasSource} onClick={onNext}>
          Next
        </Button>
        {!hasSource && (
          <p className="text-sm text-muted-foreground">Add a job source to continue.</p>
        )}
      </StepActions>
    </>
  );
}

export function FirstRunStep({
  sourceCount,
  activeRunId,
  onBack,
}: {
  sourceCount: number;
  activeRunId: string | null;
  onBack: () => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const settings = useEditableSettings();
  const maxJobs = settings.data?.settings.maxJobsPerRun;

  // Runs every saved source, as the home page does. Starting the first run also completes
  // setup on the server, so the overview is refreshed.
  const start = useMutation({
    mutationFn: async () => {
      const sources = await queryClient.fetchQuery({
        queryKey: ["sources"],
        queryFn: fetchSources,
      });
      return startRun(sources.map(({ id }) => id));
    },
    onSuccess: (run) => {
      void queryClient.invalidateQueries({ queryKey: overviewKey });
      void queryClient.invalidateQueries({ queryKey: ["runs"], exact: true });
      router.push(`/runs/${run.id}?first=1`);
    },
    onError: async (error) => {
      // A run is already going: open it.
      if (error instanceof ApiError && error.status === 409) {
        const overview = await queryClient
          .fetchQuery({ queryKey: overviewKey, queryFn: fetchOverview, staleTime: 0 })
          .catch(() => null);
        if (overview?.activeRun) {
          toast.info("A run is already in progress");
          router.push(`/runs/${overview.activeRun.id}`);
          return;
        }
      }
      toast.error(error instanceof ApiError ? error.message : "Could not start the run.");
    },
  });

  return (
    <>
      <dl className="grid gap-4 border-y py-6 sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Job sources to check</dt>
          <dd className="text-2xl font-semibold tabular-nums">{sourceCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Most jobs read per run</dt>
          <dd className="text-2xl font-semibold tabular-nums">
            {maxJobs ?? <Skeleton className="mt-1 h-7 w-12" />}
          </dd>
        </div>
      </dl>
      <ul className="flex list-disc flex-col gap-2 pl-5 text-muted-foreground">
        <li>
          The run checks your {plural(sourceCount, "job source")} for listings that fit your
          experience and cities, then reads
          {maxJobs === undefined ? " the" : ` up to ${plural(maxJobs, "listing")}`} and scores each
          against your resume.
        </li>
        <li>It usually takes a few minutes. You can leave the page while it runs.</li>
        <li>
          Careers pages and searches may use Firecrawl credits. Boards read from their public APIs
          use none.
        </li>
      </ul>
      <StepActions onBack={onBack}>
        {activeRunId ? (
          <>
            <Link href={`/runs/${activeRunId}`} className={buttonVariants({ size: "lg" })}>
              View the run in progress
            </Link>
            <p className="text-sm text-muted-foreground">A run is already in progress.</p>
          </>
        ) : (
          <Button
            size="lg"
            disabled={start.isPending || start.isSuccess}
            onClick={() => start.mutate()}
          >
            {start.isPending || start.isSuccess ? "Starting" : "Start first run"}
          </Button>
        )}
      </StepActions>
    </>
  );
}
