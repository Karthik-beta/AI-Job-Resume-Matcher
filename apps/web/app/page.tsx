import Link from "next/link";
import { ExampleRun } from "@/components/example-run";
import { HeaderNav } from "@/components/header-nav";
import { Logo } from "@/components/logo";
import { buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

const repoUrl = "https://github.com/Karthik-beta/AI-Job-Resume-Matcher";

const steps = [
  {
    title: "Read your job boards",
    body: "Pulls every listing from the boards you add. Listings are cached for 15 minutes, so a second run doesn't scrape the same page again.",
  },
  {
    title: "Filter before reading",
    body: "Drops listings outside your years of experience or your cities before any job page is opened, which saves scraping credits.",
  },
  {
    title: "Check against your resume",
    body: "Sends each remaining listing and your resume to an LLM. It answers match or no match, with a reason you can check.",
  },
  {
    title: "Save and notify",
    body: "Adds matches to your list, where you mark them applied. If you connect a Discord channel, each match is posted there too.",
  },
];

export default function Home() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 sm:px-8">
      <header className="flex items-center justify-between py-6">
        <Logo href="/" />
        <nav className="flex items-center gap-1">
          <a href={repoUrl} className={buttonVariants({ variant: "outline" })}>
            <GitHubIcon />
            <span className="hidden sm:inline">GitHub</span>
            <span className="sr-only sm:hidden">Source code on GitHub</span>
          </a>
          <HeaderNav />
        </nav>
      </header>

      <main className="flex flex-col gap-24 pb-24">
        <section className="grid items-start gap-12 pt-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-16 lg:pt-16">
          <div className="flex max-w-xl flex-col gap-6 lg:sticky lg:top-12">
            <h1 className="text-5xl font-extrabold leading-[0.95] tracking-[-0.035em] sm:text-6xl">
              Find the listings worth applying to.
            </h1>
            <p className="text-lg leading-relaxed text-muted-foreground">
              Job Matcher reads the job boards you follow, drops listings outside your experience
              and cities, and asks an LLM to check the rest against your resume. You get a short
              list, with the reason behind every verdict.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/sign-up" className={buttonVariants({ size: "lg" })}>
                Create an account
              </Link>
              <a
                href="#how-it-works"
                className={buttonVariants({ size: "lg", variant: "outline" })}
              >
                How a run works
              </a>
            </div>
          </div>
          <ExampleRun />
        </section>

        <section id="how-it-works" className="flex scroll-mt-8 flex-col gap-8">
          <h2 className="max-w-xl text-3xl font-bold tracking-tight">How a run works</h2>
          <ol className="border-y border-foreground/15">
            {steps.map((step, index) => (
              <li key={step.title}>
                {index > 0 && <Separator />}
                <div className="grid gap-2 py-6 sm:grid-cols-[3rem_minmax(0,16rem)_minmax(0,1fr)] sm:gap-8">
                  <span className="text-sm font-semibold tabular-nums text-match">{index + 1}</span>
                  <h3 className="font-semibold">{step.title}</h3>
                  <p className="max-w-prose leading-relaxed text-muted-foreground">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="flex flex-col gap-2 border-t py-8 text-sm text-muted-foreground sm:flex-row sm:justify-between">
        <p>Built with Bun, NestJS, Next.js, Effect, PostgreSQL and Prisma.</p>
        <a href={repoUrl} className="underline-offset-4 hover:text-foreground hover:underline">
          Karthik-beta/AI-Job-Resume-Matcher
        </a>
      </footer>
    </div>
  );
}

// Lucide dropped its brand icons, so the GitHub mark is drawn here.
function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}
