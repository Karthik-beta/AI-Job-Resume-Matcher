# Configuration

The worker reads its settings from environment variables: `.env` for development, or `.env` next to `compose.yml` for a self-hosted install. This page covers the settings for live mode. Demo mode (`PROVIDERS=fake`) needs none of them.

## Scraping modes

`FIRECRAWL_MODE` picks where pages are scraped:

| Mode | Needs | What it does |
| --- | --- | --- |
| `cloud` (default) | `FIRECRAWL_API_KEY` | Every scrape, map and search goes to Firecrawl's cloud, 1 credit a page. `FIRECRAWL_CLOUD_PROXY=auto` retries blocked pages with enhanced proxies at no extra cost. |
| `local` | `FIRECRAWL_LOCAL_URL` | A self-hosted Firecrawl (below). No credits and no plan rate limit; a site that blocks it fails just that job. Search sources need `FIRECRAWL_LOCAL_SEARCH=true` (SearXNG on the instance). |
| `hybrid` | both | Local first; only a page the site blocked, or one the local instance could not answer, is retried on the cloud with the auto proxy. A site that blocks the local instance twice in a row goes straight to the cloud for a week. Search sources use the cloud. |

A run in `local` or `hybrid` mode stops at once if the local instance is not running. Each job on the run page shows where its text came from (job board API, cache, local or cloud scrape), and the run shows the cloud credits it used.

## Self-hosted Firecrawl

`local` and `hybrid` mode scrape with a self-hosted Firecrawl. `docker-compose.yml` runs one under the `firecrawl` profile, on Firecrawl's published images (pinned to 2.11.506): set `COMPOSE_PROFILES=firecrawl` and `FIRECRAWL_LOCAL_URL=http://localhost:3002` in `.env`, and `bun run dev` starts it with its own Postgres, Redis and RabbitMQ. The images take about 6 GB on disk; once pulled, the API is ready in about 95 seconds, and its container uses about 3.5 GB of memory under light scraping (the compose file caps it at 8 GB). It needs no API key and only publishes port 3002.

For search sources in `local` mode, run a [SearXNG](https://docs.searxng.org) instance with JSON output enabled, set `SEARXNG_ENDPOINT` (and optionally `SEARXNG_ENGINES` and `SEARXNG_CATEGORIES`) in `.env` for the Firecrawl container, and `FIRECRAWL_LOCAL_SEARCH=true` for the app. Without it, search sources are skipped in `local` mode with a warning in the API log saying so, and the run reads its other sources.

To stop the self-hosted Firecrawl without touching the app's database:

```bash
docker compose --profile firecrawl stop firecrawl-api firecrawl-playwright firecrawl-redis firecrawl-rabbitmq firecrawl-postgres
```

## Job sources

Add sources on the Settings page:

- **ATS boards** (Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee) are detected from the board URL and read from the board's public API, with no Firecrawl credits. Job ads come with the listings, or from the API one job at a time.
- **Web pages** (any careers page) are scraped. Job links are read from the page's markdown across its "next" pages (`maxPages`, default 3), optionally only inside a CSS `selector` (both set on the `JobSource` row; not in the UI yet); when the links carry no titles, the LLM reads the page. A page source can instead take its job links from Firecrawl's **site map** (1 credit), falling back to the page when the map has none. A page that embeds an ATS board is offered as a switch to that board.
- **Searches** run a web search for a query, limited to the ATS job boards and the past week (`/search` with `includeDomains`, including the EU Greenhouse and Lever hosts, and `tbs=qdr:w`; 10 results, 2 credits, and an empty search is counted as 2 too). Results on an ATS host are read through that ATS's API where it has a per-job endpoint (Greenhouse, Lever, SmartRecruiters) and scraped otherwise. A search runs at most once a day; the rest of the day's runs reuse its results. A search that cannot run (no SearXNG in `local` mode, or no cloud credits left in `hybrid` mode) is skipped with a warning in the log, and the run goes on with its other sources.

## Filters and triage

Listings are filtered by your locations and experience, then by **title filters**: a title must contain one of the include keywords (when there are any) and none of the exclude keywords, matched as whole words. With **title triage** on (the default), the LLM ranks the remaining titles against your resume in batches, and only likely fits are read and evaluated, best first, up to the run size. Skipped jobs are listed on the run page and not triaged again in the same context.

## Firecrawl credits

The free cloud plan has 1,000 credits a month with no rollover, and 10 requests a minute for scrape, map and search ([billing](https://docs.firecrawl.dev/billing), [rate limits](https://docs.firecrawl.dev/rate-limits)). In `cloud` and `hybrid` mode each run reads the plan's remaining credits once and keeps `FIRECRAWL_CREDIT_RESERVE` (default 50) untouched:

- A **manual** run may spend everything above the reserve.
- **Scheduled** runs share one allowance per day (UTC): an even share per day left in the billing period (the end of the calendar month when Firecrawl reports none, or one already past). Each scheduled run gets what the day's earlier scheduled runs left of it, and leaves out jobs that would not fit, so a frequent schedule cannot spend the month early. Manual runs do not count against it. Jobs read from an ATS API or the cache count as free.
- In `cloud` mode a run stops when even its sources would not fit, or once it has spent its share: "Firecrawl credit reserve reached (N left until <date>)", or "Firecrawl daily credit allowance reached (…)" for a scheduled run. In `hybrid` mode the local scrapes go on, and pages that need the cloud fail with "needs cloud; credit reserve reached" (a search source that needs the cloud is skipped).

Spending is counted from each request's reported cost, with no further API calls.

## OpenRouter and GPT-6 Luna on flex

Evaluations, listing extraction and title triage go through OpenRouter. The defaults run `openai/gpt-6-luna:floor` on OpenAI's flex tier at low reasoning effort:

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENROUTER_MODEL` | `openai/gpt-6-luna:floor` | The model, any OpenRouter model id |
| `OPENROUTER_SERVICE_TIER` | `flex` | `auto`, `default`, `flex`, `priority` or `scale` |
| `OPENROUTER_PROVIDERS` | `openai` | Comma-separated providers the request may use |
| `OPENROUTER_MAX_PRICE_PROMPT` | `0.05` | Price cap, USD per million prompt tokens |
| `OPENROUTER_MAX_PRICE_COMPLETION` | `0.25` | Price cap, USD per million completion tokens |
| `OPENROUTER_REASONING_EFFORT` | `low` | Reasoning effort |

Each run first checks that the model has a (flex) endpoint from the allowed providers under the price cap, and stops if not. Flex capacity comes and goes, so a 429 or 503 backs off for 1, 2, 4, 8 and 16 minutes before that job fails, and a reply served on another tier than flex is logged as a warning.

