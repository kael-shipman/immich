# Resume here

The handoff for whoever works on this fork next, person or agent. Read [README.md](README.md) (why the fork exists,
how it's maintained, how to resolve conflicts) and [IMPLEMENTATION.md](IMPLEMENTATION.md) (the design) first. Update
this file at the end of every working session.

**Last updated:** 2026-11-03.

## Where things stand

- **The patch is done:** hooks H1–H6 and rules R1–R6, all behind `IMMICH_SHARE_DERIVED_DATA` (off by default). It's
  on `twins`, based on upstream `v3.3.5` (`fork/BASE`), as the stack README.md describes: `docs(fork)`,
  `feat(server)`, `test(server)`, `ci(fork)`.
- **Tests:**
  - upstream's whole server unit suite (2,347 tests), lint, format and type check pass with the patch;
  - so do the fork's 25 unit tests and 7 medium tests, and upstream's medium tests for the person and OCR services;
  - upstream's other medium tests fail locally only where they need the `e2e/test-assets` submodule or the plugin
    build (IMPLEMENTATION.md, section 5). CI runs them with both.
- **Workflows:** `fork-release.yml` (rebase, test, build amd64 and arm64, publish) and `fork-ci.yml` (tests on
  `dev/**`). The first release run builds `v3.3.5`, which needs no rebase.
- **Not done yet:**
  - the end-to-end check on a dev instance: two users with libraries over one folder, the processing time and disk
    use saved, People matching, a face correction in one account showing in the other;
  - automated end-to-end tests of H1 and H2 through `MediaService` with real files, and of the race between two
    scans (IMPLEMENTATION.md, section 9).

## Next

1. **Watch the first `Fork release` run** (Actions tab). If it fails, the `report` job opens an issue.
2. **Make the package public:** `ghcr.io/kael-shipman/immich-server`, Package settings → Change visibility. Check with
   an anonymous `docker pull ghcr.io/kael-shipman/immich-server:v3.3.5`.
3. **Add the `FORK_PUSH_TOKEN` secret** (IMPLEMENTATION.md, section 6.1) before the next upstream release, or that
   release's rebase fails with a clear error.
4. **Run the dev-instance check** above, then deploy with the switch on.
5. **After one upstream release has gone through on its own,** propose the option upstream (a GitHub discussion
   linking the `feat(server)` and `test(server)` commits).

## Gotchas

- **Never push to `main`,** and never move upstream's `vX.Y.Z` tags.
- **Develop on `dev/**` branches,** then fold the result into the stack: code into `feat(server)` or `test(server)`,
  docs into `docs(fork)`, workflows into `ci(fork)`.
- **A local push of workflow files** needs a token with the `workflow` scope.
- **The release workflow only runs from the default branch,** which must be `twins`.
