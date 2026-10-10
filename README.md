# Job Matcher

Scrapes job boards, filters listings by location and experience, and checks each job against your resume with an LLM.

Built with Bun, TypeScript, NestJS, Next.js, Effect, PostgreSQL and Prisma.

## Project structure

```
apps/api    NestJS API
apps/web    Next.js frontend
prisma/     database schema and migrations
```

The web app proxies `/api/*` to the API, so the browser only talks to one origin.

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

If port 5432 is already in use, change `POSTGRES_PORT` and the port in `DATABASE_URL`.

## Scripts

| Script | Description |
| --- | --- |
| `bun run dev` | Start Postgres and Redis, then both apps |
| `bun run db:migrate` | Create and apply Prisma migrations |
| `bun run lint` | Lint and format check with Biome |
| `bun run typecheck` | Type-check every app |
| `bun run test` | Run tests |
| `bun run check` | Lint, type-check and test (used by CI) |
