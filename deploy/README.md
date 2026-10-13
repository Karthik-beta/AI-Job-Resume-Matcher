# Deploy

The Docker Compose stack for self-hosting:

- `compose.yml` runs the published images: web, API, worker, a one-off migration job, PostgreSQL and Redis.
- `compose.build.yml` is an override that builds the images from this checkout instead.
- `.env.example` is the settings template. The installer copies it to `.env` and fills it in.

See [docs/self-hosting.md](../docs/self-hosting.md) for installing, upgrading, HTTPS, backups and troubleshooting.

CI builds both images from source, starts this stack with `PROVIDERS=fake`, and runs `install.sh` against it on every push (the `docker` job in `.github/workflows/ci.yml`). A broken image or installer fails the pull request rather than someone's install.
