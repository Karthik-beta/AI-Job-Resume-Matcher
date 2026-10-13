# Contributing

See [Development](README.md#development) in the README to get a local setup running.

## Checks

`bun run check` runs lint, typecheck, unit and integration tests, and the Playwright end-to-end tests. CI runs the same checks, plus a `docker` job that builds the images, starts the self-hosted stack and runs the installer against it.

`bun install` points git at `.githooks`:
- The pre-commit hook runs lint and typecheck.
- The commit-msg hook rejects `Co-Authored-By` and "Generated with" lines. Merge commits skip the message check.

## Pull requests

`master` is protected, for admins too: a commit needs a passing CircleCI `check` status before it can land, and force pushes and deletion are blocked.

A PR stacked on another feature branch must be retargeted before its base branch goes away. GitHub closes a PR whose base branch is deleted, and it can't be reopened. To merge a stack:

1. Merge the bottom PR into `master`. Keep its branch for now.
2. Change the base of the next PR to `master` (`gh pr edit <number> --base master`), and merge `master` into its branch if GitHub reports conflicts.
3. Only then delete the merged branch.
4. Repeat for each PR up the stack.

Before merging, check that the base shown at the top of the PR is `master`, so it doesn't land in another feature branch.

## Website

The marketing page is the static site in `site/`: plain HTML, CSS and JavaScript with no build step. Biome lints its CSS and JavaScript with the rest of the repo. To preview it, serve the folder, for example with `python -m http.server 5180 --directory site`.

When a change to `site/` lands on `master`, the GitHub Actions workflow `.github/workflows/pages.yml` publishes it to https://karthik-beta.github.io/AI-Job-Resume-Matcher/. The images in `site/assets/` are copies of the ones in `docs/`, so when a screenshot in `docs/screenshots/` changes, copy it into `site/assets/` too.

## Releases

Releases follow semantic versioning. To cut one from `master`:

```bash
gh release create v1.2.0 --generate-notes
```

The `vX.Y.Z` tag runs the CircleCI checks again. Once they pass:
- `publish-amd64` and `publish-arm64` build the images natively and push them to `ghcr.io/karthik-beta/job-matcher-api` and `ghcr.io/karthik-beta/job-matcher-web`.
- `publish-manifest` joins them into the multi-arch `1.2.0` and `latest` tags.

The installers pick up the newest GitHub release, so the next install or upgrade uses it.

The publish jobs read `GHCR_USER` and `GHCR_TOKEN` from the CircleCI context `ghcr`. GitHub Packages only accepts personal access tokens (classic), not fine-grained ones, so the token is kept as narrow as a classic token allows:

- **Scope:** `write:packages` only. Create it from [this link](https://github.com/settings/tokens/new?scopes=write:packages&description=CircleCI%20GHCR%20publish), which leaves out the `repo` scope the form otherwise adds alongside it. Use an expiry date, at most 90 days.
- **Context restrictions** (Organization Settings → Contexts → `ghcr`):
  - a project restriction to this repository
  - the expression restriction `pipeline.git.tag starts-with "v" and not job.ssh.enabled`, so only release tags can read the token, and never from a job rerun with SSH

To rotate the token, create a new one the same way, replace `GHCR_TOKEN` in the context, and delete the old token on GitHub.
