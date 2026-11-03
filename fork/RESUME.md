# Resume here

The handoff for whoever works on this fork next, person or agent. Read [README.md](README.md) (why the fork exists,
how it's maintained, how to resolve conflicts) and [IMPLEMENTATION.md](IMPLEMENTATION.md) (the design) first. Update
this file at the end of every working session.

**Last updated:** 2026-11-10 (rebased onto `v3.4.0` by hand after the automatic rebase conflicted).

## Where things stand

- **The patch is done and published:** hooks H1–H6 and rules R1–R6, all behind `IMMICH_SHARE_DERIVED_DATA` (off by
  default), on `twins` (the default branch), based on upstream `v3.4.0` (`fork/BASE`).
- **The second patch is done** (2026-11-08): H7, metadata extraction finds a sidecar that appeared after indexing,
  behind `IMMICH_FIND_NEW_SIDECARS` (off by default; IMPLEMENTATION.md, section 10). Its 5 unit and 2 medium tests
  pass, and upstream's metadata tests with it. The stack is `docs(fork)`, `feat(server)`, `test(server)`,
  `fix(server)` (the second patch), `ci(fork)`.
- **v3.4.0 (2026-11-10):** the automatic rebase conflicted in `media.service.ts` and `smart-info.service.ts`
  (issue #4); resolved by hand (README.md, Conflict log), tested by `fork-ci` and published as `v3.4.0`.
- **Published before it:** `ghcr.io/kael-shipman/immich-server:v3.3.6`, also tagged `v3` and `release`, for amd64 and arm64,
  public. The first automatic rebase (onto `v3.3.6`, 2026-11-07) went through once `FORK_PUSH_TOKEN` was replaced;
  `v3.3.6` was then rebuilt by hand with the second patch, and again (2026-11-08) with the R6 fix below. Git tag
  `twins/v3.3.6` marks the build.
- **Tests:**
  - on GitHub, upstream's whole server unit and medium suites pass with the patch, the fork's own tests included;
  - locally, upstream's medium tests that need the `e2e/test-assets` submodule or the plugin build fail without them
    (IMPLEMENTATION.md, section 5).
- **Workflows:** `fork-release.yml` (rebase, test, build amd64 and arm64, publish, report) runs every 6 hours.
  `fork-ci.yml` tests `dev/**` branches. Upstream's 27 workflows are disabled; Issues are on.
- **The `FORK_PUSH_TOKEN` secret** is set (replaced 2026-11-07: a fine-grained token for this repository, Contents
  and Workflows read/write). When it expires, rebases fail with an issue until it's replaced.
- **The dev-instance check** (2026-11-08, IMPLEMENTATION.md section 9): each kind of work runs once for two users,
  disk use halves, and face edits reach the twin both ways. **It found a bug in R6:** `queueAll`'s bulk path drops job
  options, so a waiting job re-ran at once, used up its 20 waits in about a second, and did the work itself. A single
  new file arriving in both libraries was then processed twice, as on stock Immich. Nothing broke, and twins scanned
  one after the other weren't affected.
  - **The fix:** a third R6 hunk in `queueAll` (delayed jobs go through `add()`), with 2 unit tests in the new
    `server/src/repositories/job.repository.spec.ts` (the delay one fails without the fix). It was checked on the dev
    instance by mounting the patched compiled file.
  - **Where it stands:** tested on `dev/r6-delay` by `fork-ci`, folded into the stack (`feat(server)`,
    `test(server)`, `docs(fork)`), and published by rebuilding `v3.3.6`. Builds before it have the bug.
- **Not done yet:** automated end-to-end tests of H1 and H2 through `MediaService` with real files, and of the race
  between two scans (IMPLEMENTATION.md, section 9).

## Next

1. **Propose the option upstream** (a GitHub discussion linking the `feat(server)` and `test(server)` commits), and
   the second patch as a pull request of its own (the `fix(server)` commit). `queueAll`'s lost
   options are upstream's bug too (it also drops `PersonGenerateThumbnail`'s `priority: 1`): worth an issue of its
   own.

## Gotchas

- **Never push to `main`,** and never move upstream's `vX.Y.Z` tags.
- **Develop on `dev/**` branches,** then fold the result into the stack: code into `feat(server)` or `test(server)`,
  docs into `docs(fork)`, workflows into `ci(fork)`.
- **A local push of workflow files** needs a token with the `workflow` scope.
- **The release workflow only runs from the default branch,** which must be `twins`.
- **Run the server suites from `server/`** (`mise run ci-unit`, `mise run ci-medium`). From the repository root, the
  medium suite finds no test files.
