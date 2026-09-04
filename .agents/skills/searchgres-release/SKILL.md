---
name: searchgres-release
description: Prepare, tag, publish, and verify stable releases of the searchgres core npm package. Use when asked to bump the searchgres version, create a release PR, continue a release after merge, push a vX.Y.Z tag, monitor the npm trusted-publishing workflow, investigate a release failure, or verify a published searchgres package.
license: Apache-2.0
compatibility: Requires git, GitHub CLI (gh), Node/npm, Docker for the full test gate, network access to GitHub and npm, and repository write access.
metadata:
  author: timescale
  version: "1.0"
---

# Searchgres release

Release only the unscoped core npm package `searchgres` from `packages/core`.
Do not publish private workspace packages or create binary releases.

## Establish current truth

Work from the Searchgres repository root. Before changing or publishing anything:

1. Read `DEVELOPMENT.md`, especially **Publishing the core package**.
2. Read `.github/workflows/release.yml` completely.
3. Inspect `git status`, the current branch, `origin/main`, existing `v*` tags,
   `packages/core/package.json`, `packages/core/src/version.ts`, `bun.lock`, and
   the top of `CHANGELOG.md`.
4. Check the latest published version and dist-tag with `npm view searchgres`.
5. Check GitHub authentication with `gh auth status`.

Treat the checked-in workflow and development guide as authoritative when they
conflict with this skill. Never expose npm credentials or GitHub tokens.

## Resolve the requested version safely

A stable release version is `X.Y.Z`; its tag is `vX.Y.Z`.

- Normalize an unambiguous input such as `0.2.0` or `v0.2.0`.
- If the requested version is absent, ambiguous, already published, lower than
  the current version, or a surprising jump, stop and ask the user to confirm.
- In particular, do not infer a major-version jump from a likely typo.
- Ensure the package version, `LIBRARY_VERSION`, lockfile workspace version,
  changelog heading, and eventual tag all use the exact same version.
- npm versions are immutable. Never overwrite, move, or reuse a release tag.

Before starting, run checks equivalent to:

```sh
version=X.Y.Z
tag="v$version"
npm view "searchgres@$version" version --json
git tag --list "$tag"
```

A not-found response from the version-specific npm query is expected for a new
release. If either npm or Git already contains the target, inspect it and stop
unless the user's request is only to verify that existing release.

## Prepare the release PR

Skip this section only when the exact release commit has already been merged to
`main` and the user asked to continue with tagging.

1. Start from a clean, current `main`:

   ```sh
   git switch main
   git pull --ff-only
   git switch -c "release/$version"
   ```

2. Update exactly these version records:
   - `packages/core/package.json`
   - `packages/core/src/version.ts`
   - the `packages/core` workspace entry in `bun.lock`

   Do not regenerate the entire lockfile merely to change the workspace version.

3. Add a dated `## [X.Y.Z] - YYYY-MM-DD` section immediately below
   `## [Unreleased]` in `CHANGELOG.md`. Derive factual notes from the changes
   since the previous release. Do not invent user-visible fixes; ask the user
   when release scope is unclear.

4. Run the complete local gate:

   ```sh
   ./bun run check:full
   ```

5. Build and inspect the exact package:

   ```sh
   release_dir="$(mktemp -d)"
   ./bun run --filter searchgres build
   ./bun pm pack --cwd packages/core --destination "$release_dir"
   tar -tzf "$release_dir/searchgres-$version.tgz"
   ```

   Require `package.json`, `README.md`, `LICENSE`, `NOTICE`, `dist/index.js`, and
   `dist/index.d.ts`. Reject source TypeScript (except declarations), tests,
   integration fixtures, `node_modules`, or missing legal files.

6. Install that tarball in a new scratch npm project and import `searchgres` by
   package name. Require `LIBRARY_VERSION === version`.

7. Review `git diff --check`, the complete diff, and repository status. Commit,
   push, and open a PR against `main`, for example:

   ```sh
   git commit -m "chore: release core $version"
   git push -u origin "release/$version"
   gh pr create --base main --head "release/$version" \
     --title "chore: release core $version"
   ```

8. Watch PR checks with `gh pr checks --watch`. Do not merge while checks fail.
   Do not use administrator privileges to bypass required reviews or branch
   protection. If policy requires another reviewer or manual merge, report the
   ready PR and stop until the user says it has merged.

## Tag the merged commit

Tag only after the release PR is merged.

1. Refresh `main` and require a clean worktree:

   ```sh
   git switch main
   git pull --ff-only
   ```

2. Verify all of the following before tagging:
   - `HEAD` is the intended merged release commit and is contained in
     `origin/main`.
   - The package, library constant, lockfile, and changelog all say `X.Y.Z`.
   - `vX.Y.Z` does not exist locally or remotely.
   - `searchgres@X.Y.Z` is not already published.
   - The CI push run for this `main` commit completed successfully.

3. Create an annotated tag on that exact commit and push only that tag:

   ```sh
   git tag -a "v$version" -m "searchgres $version" HEAD
   git push origin "v$version"
   ```

Do not tag a release branch. Do not move the tag after pushing it.

## Monitor trusted publishing

Pushing the tag starts `.github/workflows/release.yml`.

1. Find the run associated with the exact tag, not merely the latest release
   run.
2. Watch it to completion:

   ```sh
   gh run list --workflow release.yml --branch "v$version"
   gh run watch RUN_ID --exit-status
   ```

3. On failure, inspect `gh run view RUN_ID --log-failed` before acting.

The expected path uses npm trusted publishing through GitHub OIDC and publishes
provenance. A bootstrap `NPM_TOKEN` is historical first-release support only;
do not create or restore one for ordinary releases.

If a run appears cancelled or fails after the publish step, query npm before
retrying: publication may already have completed. A workflow rerun is safe only
because the workflow skips an already-published exact version. If the pushed tag
points at defective source and npm has not published it, do not move the tag;
prepare a new patch version instead.

## Verify the public release

A green workflow is necessary but not sufficient. Verify the public artifact:

1. Require npm metadata and `latest` to report the target version:

   ```sh
   npm view "searchgres@$version" \
     name version license repository dist.integrity dist.tarball --json
   npm view searchgres dist-tags.latest
   ```

2. Confirm the metadata includes provenance/attestation information when
   available.
3. Poll the exact `dist.tarball` URL until it returns HTTP 200. npm registry or
   Cloudflare caches can retain a pre-publication 404 for roughly five minutes;
   metadata may become visible first. Wait and retry for up to ten minutes
   rather than declaring failure immediately.
4. In a brand-new temporary directory, run:

   ```sh
   npm init -y
   npm install "searchgres@$version" --prefer-online
   node --input-type=module -e '
     const m = await import("searchgres");
     console.log(m.LIBRARY_VERSION);
   '
   ```

   Require the imported version to equal `X.Y.Z` and remove the temporary
   directory afterward.
5. Report the tag commit, main CI run, release workflow run, npm version,
   `latest` dist-tag, provenance result, and fresh-install result.

## Failure rules

- Diagnose the first substantive error; ignore unrelated package-install or
  container noise around it.
- Never disable tests, provenance, trusted publishing, or branch protection to
  make a release pass.
- Never publish manually from a developer machine when the tag workflow is the
  configured release path.
- Never call `npm unpublish`, deprecate a version, delete a remote tag, or force
  push without explicit user authorization and a clear recovery plan.
- Leave the repository clean and on `main` after a completed release.
