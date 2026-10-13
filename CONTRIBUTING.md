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

## Releases

Releases follow semantic versioning. To cut one from `master`:

```bash
gh release create v1.2.0 --generate-notes
```

The `vX.Y.Z` tag runs the CircleCI checks again. Once they pass:
- `publish-amd64` and `publish-arm64` build the images natively and push them to `ghcr.io/karthik-beta/job-matcher-api` and `ghcr.io/karthik-beta/job-matcher-web`.
- `publish-manifest` joins them into the multi-arch `1.2.0` and `latest` tags.

The installers pick up the newest GitHub release, so the next install or upgrade uses it.

The publish jobs read `GHCR_USER` and `GHCR_TOKEN` from the CircleCI context `ghcr`. The token is a GitHub personal access token (classic) with the `write:packages` scope.
