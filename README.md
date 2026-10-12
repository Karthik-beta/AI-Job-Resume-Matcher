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
- **The cache lives in Postgres.** Scraped resumes, job pages and source listings are stored per user in a `PageCache` table: listings for 15 minutes, everything else until the user clears it. The cache survives restarts, needs no extra service and can be cleared from Settings. Analysed jobs are keyed by a hash of the resume URL, sources, model and requirements, so running again continues where the last run stopped.
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

The worker needs `OPENROUTER_API_KEY` and a Firecrawl to scrape with, chosen by `FIRECRAWL_MODE`: `cloud` (the default) needs `FIRECRAWL_API_KEY`; `local` needs `FIRECRAWL_LOCAL_URL` (a self-hosted Firecrawl, see below); `hybrid` needs both and sends only the pages that block the local instance to the cloud; a site that blocks it twice in a row goes straight to the cloud for a week. Without them the API still starts, but the worker exits. A run in `local` or `hybrid` mode stops at once if the local instance is not running. Set `PROVIDERS=fake` to run the worker on the fixtures in `apps/api/test/fixtures` instead, with no keys and no external calls.

### Self-hosted Firecrawl

`local` and `hybrid` mode scrape with a self-hosted Firecrawl. `docker-compose.yml` runs one under the `firecrawl` profile, on Firecrawl's published images (pinned to 2.11.506): set `COMPOSE_PROFILES=firecrawl` and `FIRECRAWL_LOCAL_URL=http://localhost:3002` in `.env`, and `bun run dev` starts it with Postgres and Redis. The images take about 6 GB on disk; once pulled, the stack is ready in about 90 seconds, and it uses about 4 GB of memory while scraping. It needs no API key and only publishes port 3002. To stop it without touching the app's database:

```bash
docker compose --profile firecrawl stop firecrawl-api firecrawl-playwright firecrawl-redis firecrawl-rabbitmq firecrawl-postgres
```

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
