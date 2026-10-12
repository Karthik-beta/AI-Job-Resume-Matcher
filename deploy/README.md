# Deploying the demo

The whole stack runs on one host with Docker Compose: the web app, the API, the run worker, Postgres and Redis. Only the web app is published; the API is reached through its `/api` proxy.

## First deploy

1. On a host with Docker, clone the repository.
2. Create the secrets file from the template and fill it in. `deploy/.env` is gitignored and stays on the host.

   ```bash
   cp deploy/.env.example deploy/.env
   ```

   - `POSTGRES_PASSWORD` and `BETTER_AUTH_SECRET`: long random values, e.g. `openssl rand -hex 32`. The stack refuses to start while either is empty.
   - `BETTER_AUTH_URL`: the exact origin people will open, including the port when `WEB_PORT` is not 80. Sign-in fails if it does not match.
   - `PROVIDERS=fake` runs the demo on fixtures, so it needs no Firecrawl or OpenRouter keys and costs nothing. Set `PROVIDERS=live` and both keys to scrape real pages.
   - Live runs use the Firecrawl cloud: `FIRECRAWL_MODE=cloud` (the default) needs only `FIRECRAWL_API_KEY`, and `FIRECRAWL_CREDIT_RESERVE` (default 50) is the part of the plan's credits runs never spend. This stack does not run a self-hosted Firecrawl, so `local` and `hybrid` mode would need one reachable from the worker (`FIRECRAWL_LOCAL_URL`, plus the API key for `hybrid`), for example the `firecrawl` profile of the root `docker-compose.yml` on a host with about 6 GB of disk and 4 GB of memory to spare. Search sources need the cloud, or `FIRECRAWL_LOCAL_SEARCH=true` with SearXNG on that instance. See [Scraping modes](../README.md#scraping-modes).

3. Build and start:

   ```bash
   docker compose -f deploy/compose.yml up -d --build
   ```

   The `migrate` service applies pending Prisma migrations before the API and worker start. The web app listens on port 80; set `WEB_PORT` to change it. Put a TLS proxy (Caddy, a load balancer, or the host's own) in front for HTTPS.

4. Check `https://<your-host>/api/health` returns `{"database":"up","redis":"up"}`, then sign up.

## Updating

```bash
git pull
docker compose -f deploy/compose.yml up -d --build
```

Migrations run again on every deploy; already-applied ones are skipped.

CI builds both images and starts this stack with `PROVIDERS=fake` on every push (the `docker` job in `.circleci/config.yml`), so a broken image fails the PR rather than the deploy.
