# Resume here

The handoff for whoever works on this fork next, person or agent. Read [README.md](README.md) (why the fork exists,
how it's maintained, how to resolve conflicts) and [IMPLEMENTATION.md](IMPLEMENTATION.md) (the design) first. Update
this file at the end of every working session.

**Last updated:** 2026-11-03.

## Where things stand

- **The patch is done and published:** hooks H1–H6 and rules R1–R6, all behind `IMMICH_SHARE_DERIVED_DATA` (off by
  default), on `twins` (the default branch), based on upstream `v3.3.5` (`fork/BASE`). The stack is `docs(fork)`,
  `feat(server)`, `test(server)`, `ci(fork)`.
- **Published 2026-11-03:** `ghcr.io/kael-shipman/immich-server:v3.3.5`, also tagged `v3` and `release`, for amd64
  and arm64. It's public (an anonymous pull works). Git tag `twins/v3.3.5` marks the build.
- **Tests:**
  - on GitHub, upstream's whole server unit and medium suites pass with the patch, the fork's own tests included;
  - locally, upstream's medium tests that need the `e2e/test-assets` submodule or the plugin build fail without them
    (IMPLEMENTATION.md, section 5).
- **Workflows:** `fork-release.yml` (rebase, test, build amd64 and arm64, publish, report) runs every 6 hours.
  `fork-ci.yml` tests `dev/**` branches. Upstream's 27 workflows are disabled; Issues are on.
- **The `FORK_PUSH_TOKEN` secret** is set (2026-11-03: a fine-grained token for this repository, Contents and
  Workflows read/write). It's first used by the next upstream release's rebase. When it expires, rebases fail with
  an issue until it's replaced.
- **Not done yet:**
  - the end-to-end check on a dev instance: two users with libraries over one folder, the processing time and disk
    use saved, People matching, a face correction in one account showing in the other;
  - automated end-to-end tests of H1 and H2 through `MediaService` with real files, and of the race between two
    scans (IMPLEMENTATION.md, section 9).

## Next

1. **Run the dev-instance check** above, then deploy with the switch on.
2. **Watch the first automatic release** (the next upstream release): the rebase, tests and publish should go through
   on their own.
3. **After that,** propose the option upstream (a GitHub discussion linking the `feat(server)` and `test(server)`
   commits).

## Gotchas

- **Never push to `main`,** and never move upstream's `vX.Y.Z` tags.
- **Develop on `dev/**` branches,** then fold the result into the stack: code into `feat(server)` or `test(server)`,
  docs into `docs(fork)`, workflows into `ci(fork)`.
- **A local push of workflow files** needs a token with the `workflow` scope.
- **The release workflow only runs from the default branch,** which must be `twins`.
- **Run the server suites from `server/`** (`mise run ci-unit`, `mise run ci-medium`). From the repository root, the
  medium suite finds no test files.
