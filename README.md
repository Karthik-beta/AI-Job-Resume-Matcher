# Job Matcher

Scrapes the job boards you follow, filters listings by location and experience, and checks each remaining job against your resume with an LLM. Matches are saved for you to track, and can be posted to Discord.

Built with Bun, TypeScript, NestJS, Next.js, Effect, PostgreSQL, Prisma, Redis and BullMQ.

**Demo:** there is no hosted demo; run it locally instead. With `PROVIDERS=fake` it uses fixture pages instead of real scrapes and AI calls, so it needs no API keys:

```bash
cp deploy/.env.example deploy/.env   # fill in POSTGRES_PASSWORD, BETTER_AUTH_SECRET, BETTER_AUTH_URL=http://localhost:8080
WEB_PORT=8080 docker compose -f deploy/compose.yml up -d --build
```

Then open http://localhost:8080, sign up, add any careers page URL and a resume URL in Settings, and press Analyze.

| Analyze | Matches |
| --- | --- |
| ![A completed run with two matches](docs/screenshots/analyze.png) | ![Pending matches with a Mark applied button](docs/screenshots/matches.png) |

![Landing page](docs/screenshots/home.png)

## Architecture

```mermaid
flowchart LR
  browser([Browser]) --> web[Next.js web app]
  web -- "/api proxy" --> api[NestJS API]
  api --> pg[(PostgreSQL)]
  api -- "enqueue run" --> redis[(Redis / BullMQ)]
  redis --> worker[Run worker]
  worker --> pg
  worker --> firecrawl[Firecrawl]
  worker --> openrouter[OpenRouter]
  worker --> discord[Discord webhook]
```

- **Web** (`apps/web`) is the only public service. It proxies `/api/*` to the API, so the browser talks to one origin and the session cookie stays first-party.
- **API** (`apps/api`) handles auth, sources, settings, runs and matches. Starting a run only creates a row and queues a job.
- **Worker** (`apps/api/src/worker.ts`) processes one run at a time:
  1. Check the OpenRouter key and model.
  2. Scrape the resume and each source's listings.
  3. Dedupe and filter the listings.
  4. Evaluate each job against the resume.
  5. Save matches and send the Discord alerts.
- It also runs each user's scheduled re-checks.
- **Providers:** Firecrawl scrapes pages, OpenRouter evaluates jobs with a strict JSON schema, and Discord receives match alerts. `PROVIDERS=fake` swaps all three for fixtures.

## Design decisions

- **A queue, not the request.** A run scrapes several pages and makes one LLM call per job, which can take minutes on the free Firecrawl plan's 10 requests a minute. The API answers immediately with a queued run, and the page polls for progress. The run id is the job id, so a double click can't queue the same run twice, and a per-user advisory lock stops two runs from starting at once.
- **Effect only where the failures are.** The matching pipeline (scraping, rate limiting, retries, evaluation, notifications) is written with Effect. That gives it typed errors: a 401 stops the run, a bad page only fails that job, and a Discord failure is just logged. Nest controllers and services stay plain async code. The two meet at one `ManagedRuntime`, built when the worker boots.
- **The cache lives in Postgres.** Scraped resumes, job pages and source listings are stored per user in a `PageCache` table: listings for 15 minutes (a day for search sources), everything else until the user clears it. The cache survives restarts, needs no extra service and can be cleared from Settings. Analysed jobs are keyed by a hash of the resume URL, sources, model and requirements, so running again continues where the last run stopped.
- **A single worker.** Concurrency is 1, so every run shares one Firecrawl rate limiter, and jobs are checked one at a time and never interleave. This is enough for a personal tool; more throughput would need a shared, Redis-backed limiter first.

## Project structure

```
apps/api         NestJS API and the run worker
apps/web         Next.js frontend
packages/shared  Request schemas shared by both apps
prisma/          Database schema and migrations
e2e/             Playwright end-to-end test
deploy/          Docker Compose stack for one host
```

## Getting started

Requires [Bun](https://bun.sh) and Docker.

```bash
cp .env.example .env
bun install
bun run db:migrate
bun run dev
```

- Web: http://localhost:3000
- API: http://localhost:4000/api/health

Set `BETTER_AUTH_SECRET` in `.env` to a random string, for example the output of `openssl rand -base64 32`.

The worker needs `OPENROUTER_API_KEY` and a Firecrawl to scrape with (see [Scraping modes](#scraping-modes)). Without them the API still starts, but the worker exits. Set `PROVIDERS=fake` to run the worker on the fixtures in `apps/api/test/fixtures` instead, with no keys and no external calls.

### Scraping modes

`FIRECRAWL_MODE` picks where pages are scraped:

| Mode | Needs | What it does |
| --- | --- | --- |
| `cloud` (default) | `FIRECRAWL_API_KEY` | Every scrape, map and search goes to Firecrawl's cloud, 1 credit a page. `FIRECRAWL_CLOUD_PROXY=auto` retries blocked pages with enhanced proxies at no extra cost. |
| `local` | `FIRECRAWL_LOCAL_URL` | A self-hosted Firecrawl (below). No credits and no plan rate limit; a site that blocks it fails just that job. Search sources need `FIRECRAWL_LOCAL_SEARCH=true` (SearXNG on the instance). |
| `hybrid` | both | Local first; only a page the site blocked, or one the local instance could not answer, is retried on the cloud with the auto proxy. A site that blocks the local instance twice in a row goes straight to the cloud for a week. Search sources use the cloud. |

A run in `local` or `hybrid` mode stops at once if the local instance is not running. Each job on the run page shows where its text came from (job board API, cache, local or cloud scrape), and the run shows the cloud credits it used.

### Self-hosted Firecrawl

`local` and `hybrid` mode scrape with a self-hosted Firecrawl. `docker-compose.yml` runs one under the `firecrawl` profile, on Firecrawl's published images (pinned to 2.11.506): set `COMPOSE_PROFILES=firecrawl` and `FIRECRAWL_LOCAL_URL=http://localhost:3002` in `.env`, and `bun run dev` starts it with its own Postgres, Redis and RabbitMQ. The images take about 6 GB on disk; once pulled, the API is ready in about 95 seconds, and its container uses about 3.5 GB of memory under light scraping (the compose file caps it at 8 GB). It needs no API key and only publishes port 3002.

For search sources in `local` mode, run a [SearXNG](https://docs.searxng.org) instance with JSON output enabled, set `SEARXNG_ENDPOINT` (and optionally `SEARXNG_ENGINES` and `SEARXNG_CATEGORIES`) in `.env` for the Firecrawl container, and `FIRECRAWL_LOCAL_SEARCH=true` for the app. Without it, search sources fail in `local` mode with a message saying so.

To stop the self-hosted Firecrawl without touching the app's database:

```bash
docker compose --profile firecrawl stop firecrawl-api firecrawl-playwright firecrawl-redis firecrawl-rabbitmq firecrawl-postgres
```

### Job sources

Add sources on the Settings page:

- **ATS boards** (Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee) are detected from the board URL and read from the board's public API, with no Firecrawl credits. Job ads come with the listings, or from the API one job at a time.
- **Web pages** (any careers page) are scraped. Job links are read from the page's markdown across its "next" pages (`maxPages`, default 3), optionally only inside a CSS `selector` (both set on the `JobSource` row; not in the UI yet); when the links carry no titles, the LLM reads the page. A page source can instead take its job links from Firecrawl's **site map** (1 credit), falling back to the page when the map has none. A page that embeds an ATS board is offered as a switch to that board.
- **Searches** run a web search for a query, limited to the ATS job boards and the past week (`/search` with `includeDomains` and `tbs=qdr:w`, 10 results, 2 credits). Results on an ATS host are read through that ATS's API where it has a per-job endpoint (Greenhouse, Lever, SmartRecruiters) and scraped otherwise. A search runs at most once a day; the rest of the day's runs reuse its results.

### Filters and triage

Listings are filtered by your locations and experience, then by **title filters**: a title must contain one of the include keywords (when there are any) and none of the exclude keywords, matched as whole words. With **title triage** on (the default), the LLM ranks the remaining titles against your resume in batches, and only likely fits are read and evaluated, best first, up to the run size. Skipped jobs are listed on the run page and not triaged again in the same context.

### Firecrawl credits

The free cloud plan has 1,000 credits a month with no rollover, and 10 requests a minute for scrape, map and search ([billing](https://docs.firecrawl.dev/billing), [rate limits](https://docs.firecrawl.dev/rate-limits)). In `cloud` and `hybrid` mode each run reads the plan's remaining credits once and keeps `FIRECRAWL_CREDIT_RESERVE` (default 50) untouched:

- A **manual** run may spend everything above the reserve.
- **Scheduled** runs share one allowance per day (UTC): an even share per day left in the billing period (the end of the calendar month when Firecrawl reports none). Each scheduled run gets what the day's earlier scheduled runs left of it, and leaves out jobs that would not fit, so a frequent schedule cannot spend the month early. Manual runs do not count against it. Jobs read from an ATS API or the cache count as free.
- In `cloud` mode a run stops when even its sources would not fit, or once it has spent its share: "Firecrawl credit reserve reached (N left until <date>)", or "Firecrawl daily credit allowance reached (…)" for a scheduled run. In `hybrid` mode the local scrapes go on, and pages that need the cloud fail with "needs cloud; credit reserve reached".

Spending is counted from each request's reported cost, with no further API calls.

### OpenRouter and GPT-6 Luna on flex

Evaluations, listing extraction and title triage go through OpenRouter. The defaults run `openai/gpt-6-luna:floor` on OpenAI's flex tier at low reasoning effort:

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENROUTER_MODEL` | | The model, e.g. `openai/gpt-6-luna:floor` |
| `OPENROUTER_SERVICE_TIER` | `flex` | `auto`, `default`, `flex`, `priority` or `scale` |
| `OPENROUTER_PROVIDERS` | `openai` | Comma-separated providers the request may use |
| `OPENROUTER_MAX_PRICE_PROMPT` | `0.05` | Price cap, USD per million prompt tokens |
| `OPENROUTER_MAX_PRICE_COMPLETION` | `0.25` | Price cap, USD per million completion tokens |
| `OPENROUTER_REASONING_EFFORT` | `low` | Reasoning effort |

Each run first checks that the model has a (flex) endpoint from the allowed providers under the price cap, and stops if not. Flex capacity comes and goes, so a 429 or 503 backs off for 1, 2, 4, 8 and 16 minutes before that job fails, and a reply served on another tier than flex is logged as a warning.

When `.env.example` gains a new variable, copy it into your `.env`. The API refuses to start if a required variable is missing.

If port 5432 is already in use, change `POSTGRES_PORT` and the port in `DATABASE_URL`.

## Scripts

| Script | Description |
| --- | --- |
| `bun run dev` | Start Postgres and Redis, then the web app, API and run worker |
| `bun run db:migrate` | Create and apply Prisma migrations, then regenerate the Prisma client |
| `bun run db:generate` | Regenerate the Prisma client only |
| `bun run lint` | Lint and format check with Biome |
| `bun run typecheck` | Type-check every app |
| `bun run test` | Unit and integration tests, with per-file coverage thresholds of 90% of lines and 75% of functions |
| `bun run test:e2e` | Playwright happy path against fake providers, in its own `<database>_e2e` database |
| `bun run check` | All of the above (used by CI) |

`bun install` points git at `.githooks`. The pre-commit hook runs lint and typecheck, and the commit-msg hook rejects `Co-Authored-By` and "Generated with" lines. Merge commits skip the message check.

## Pull requests

`master` is protected, for admins too: a commit needs a passing CircleCI `check` status before it can land, and force pushes and deletion are blocked.

A PR stacked on another feature branch must be retargeted before its base branch goes away. GitHub closes a PR whose base branch is deleted, and it can't be reopened. To merge a stack:

1. Merge the bottom PR into `master`. Keep its branch for now.
2. Change the base of the next PR to `master` (`gh pr edit <number> --base master`), and merge `master` into its branch if GitHub reports conflicts.
3. Only then delete the merged branch.
4. Repeat for each PR up the stack.

Before merging, check the base shown at the top of the PR is `master`, so it doesn't land in another feature branch.

## Deploying

See [deploy/README.md](deploy/README.md) for running the whole stack on one host with Docker Compose.
