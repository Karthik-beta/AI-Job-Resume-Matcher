# Self-hosting

Job Matcher runs on one machine with Docker Compose: the web app, the API, the run worker, PostgreSQL and Redis. Only the web app is published on a port; it reaches the API through its `/api` proxy. The images are prebuilt for amd64 and arm64, so the same steps work on Windows, macOS (Intel and Apple Silicon), Linux and a Raspberry Pi 4 or 5.

**Requirements:** Docker with Compose v2 ([Docker Desktop](https://docs.docker.com/get-docker/) includes both), about 2 GB of free memory, and 3 GB of disk.

## Install

### With the installer

```bash
# macOS / Linux / WSL
curl -fsSL https://raw.githubusercontent.com/Karthik-beta/AI-Job-Resume-Matcher/master/install.sh | sh
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/Karthik-beta/AI-Job-Resume-Matcher/master/install.ps1 | iex
```

The installer:
- Checks Docker.
- Downloads `compose.yml` and `.env.example` for the latest release into `~/job-matcher`.
- Writes `.env` with random secrets and the first free port from 8080.
- Asks for the API keys. Press Enter to skip them; with both keys the app runs in live mode, without them in demo mode.
- Starts the stack and waits until it is healthy.

It never asks for admin rights and writes only to the install folder. You can [read it first](../install.sh).

| Variable | Default | Effect |
| --- | --- | --- |
| `JOB_MATCHER_DIR` | `~/job-matcher` | Where the stack and its `.env` live |
| `JOB_MATCHER_VERSION` | the latest release | The release to install, e.g. `1.2.0` |
| `JOB_MATCHER_NONINTERACTIVE` | unset | `1` skips the prompts and reads `OPENROUTER_API_KEY` and `FIRECRAWL_API_KEY` from the environment |

### By hand

```bash
mkdir job-matcher && cd job-matcher
curl -fsSLO https://raw.githubusercontent.com/Karthik-beta/AI-Job-Resume-Matcher/master/deploy/compose.yml
curl -fsSL https://raw.githubusercontent.com/Karthik-beta/AI-Job-Resume-Matcher/master/deploy/.env.example -o .env
```

Fill in the **Required** section of `.env`:
- `POSTGRES_PASSWORD` and `BETTER_AUTH_SECRET` take long random values, e.g. the output of `openssl rand -hex 32`.
- `BETTER_AUTH_URL` is the address you will open, e.g. `http://localhost:8080`.

Then start it:

```bash
docker compose up -d --wait
```

### From source

To build the images yourself instead of pulling them:

```bash
git clone https://github.com/Karthik-beta/AI-Job-Resume-Matcher.git && cd AI-Job-Resume-Matcher
cp deploy/.env.example deploy/.env   # fill in the Required section
docker compose -f deploy/compose.yml -f deploy/compose.build.yml up -d --build --wait
```

## Demo and live mode

`PROVIDERS` in `.env` picks the mode:

- **`fake` (demo):** swaps the scraper, the LLM and Discord for built-in sample pages. Every feature works, with no keys and no cost.
- **`live`:** scrapes real job boards. It needs two keys:
  - `OPENROUTER_API_KEY` from [openrouter.ai/keys](https://openrouter.ai/keys). It pays for the AI matching; by default each job costs a fraction of a cent.
  - `FIRECRAWL_API_KEY` from [firecrawl.dev](https://www.firecrawl.dev/app/api-keys). The free plan scrapes 1,000 pages a month. Greenhouse, Lever, Ashby, SmartRecruiters and Recruitee boards are read through their public APIs and use no credits.

After editing `.env`, apply it with `docker compose up -d` in the install folder.

This stack scrapes with the Firecrawl cloud. To scrape with a self-hosted Firecrawl instead (`local` or `hybrid` mode), run one separately and set `FIRECRAWL_MODE` and `FIRECRAWL_LOCAL_URL`; see [Configuration](configuration.md#scraping-modes) for every setting.

## Opening it to other devices or the internet

Sign-in only works from the address in `BETTER_AUTH_URL`. To use the app from another device or a domain, change it to that address and run `docker compose up -d`.

- **On your network:** set `BETTER_AUTH_URL=http://<your-computer's-IP>:8080`.
- **On a domain with HTTPS:** put a reverse proxy in front. With [Caddy](https://caddyserver.com), which gets certificates automatically, a `Caddyfile` with these lines is enough:

  ```
  jobs.example.com {
    reverse_proxy localhost:8080
  }
  ```

  Then set `BETTER_AUTH_URL=https://jobs.example.com`.

Anyone who can reach the address can sign up, so don't expose an instance you don't want others to use.

## Upgrade

Run the installer again. It downloads the newest release, keeps your `.env` and data, and restarts the stack. Database migrations run automatically.

For a by-hand install, set `JOB_MATCHER_VERSION` in `.env` to the new release, download that release's `compose.yml`, and run `docker compose up -d --wait`.

## Back up and restore

Your data lives in the `job-matcher_postgres-data` Docker volume. To back it up:

```bash
docker compose exec -T postgres pg_dump -U postgres --clean --if-exists job_matcher > job-matcher-backup.sql
```

To restore it into a fresh install:

```bash
docker compose exec -T postgres psql -U postgres job_matcher < job-matcher-backup.sql
```

Keep `.env` alongside the backup: it holds the database password and the session secret.

## Uninstall

```bash
cd ~/job-matcher
docker compose down -v    # stops the stack and deletes its data
cd .. && rm -rf job-matcher
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Docker is installed but not running` | Start Docker Desktop and wait for it to say it is running, then run the installer again. |
| `A database from an earlier Job Matcher install exists` | You deleted the install folder without `docker compose down -v`. Restore that `.env`, or remove the old data with `docker volume rm job-matcher_postgres-data job-matcher_redis-data`. |
| Sign-in fails with an "invalid origin" error | The address in the browser must match `BETTER_AUTH_URL` exactly, including the port. |
| Port already in use | Change `WEB_PORT` and the port in `BETTER_AUTH_URL` in `.env`, then run `docker compose up -d`. |
| Analyze never finishes in live mode | Check the worker log with `docker compose logs worker`. It stops at startup if a key is missing or invalid. |
| `denied` when pulling images | The images are public; run `docker logout ghcr.io` in case an expired login is being used. |

Two health endpoints help with the rest:
- `/api/health` reports Postgres and Redis.
- `/api/health/worker` reports whether a worker is connected.

`docker compose ps` and `docker compose logs -f` show every service.
