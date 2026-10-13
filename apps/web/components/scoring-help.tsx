import { cn } from "cn";
import Link from "next/link";

const linkClass = "underline underline-offset-4 hover:text-foreground";

// How a job becomes a match, as the run's matching code decides it: settings filters, then an
// optional title ranking, then an AI check of the full job ad against the resume.
export function ScoringHelp({ className }: { className?: string | undefined }) {
  return (
    <details className={cn("rounded-lg border px-4 py-3 text-sm", className)}>
      <summary className="cursor-pointer font-medium marker:text-muted-foreground">
        How matching works
      </summary>
      <div className="mt-3 flex flex-col gap-3 leading-relaxed text-muted-foreground">
        <p>Jobs aren't given a number score: each one gets a yes or no verdict with a reason.</p>
        <ol className="flex list-decimal flex-col gap-2 pl-5">
          <li>
            <span className="text-foreground">Your filters.</span> Listings outside your experience,
            cities or job title words (set in{" "}
            <Link href="/settings#matching" className={linkClass}>
              Matching preferences
            </Link>
            ) are left out before anything is read.
          </li>
          <li>
            <span className="text-foreground">Title ranking (optional).</span> If it's on in{" "}
            <Link href="/settings#runs" className={linkClass}>
              Run settings
            </Link>
            , an AI model rates each job title against your resume. Titles that look unlikely to fit
            are skipped without reading the ad; when unsure, the job is kept.
          </li>
          <li>
            <span className="text-foreground">The full job ad.</span> An AI model reads the ad and
            compares it with your resume, experience and cities. It is strict: a job is a match only
            when you meet roughly 75% of its requirements and its location and experience fit. If
            the ad leaves out experience or location, the reason says what couldn't be verified;
            turning off “Include listings with unknown experience or location” rejects those jobs.
          </li>
        </ol>
        <p>
          The reason under each job says what fit and what didn't, so read it before applying.
          Expired jobs had closed, and jobs marked “Couldn't check” could not be read or judged;
          they are tried again on the next run.
        </p>
      </div>
    </details>
  );
}
