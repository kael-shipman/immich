# This fork: processing shared library files once

This repository is a fork of [Immich](https://github.com/immich-app/immich). Upstream's own README is at the
repository root. This document covers only what the fork adds, why, and how it's kept current. The full design is in
[IMPLEMENTATION.md](IMPLEMENTATION.md).

**Status:** implemented, tested and published (`v3.3.6`, with the second patch); not yet proven on a real instance. Section [Status](#status) tracks progress,
and [RESUME.md](RESUME.md) is the handoff for whoever picks up the work next.

## Why it exists

Some Immich instances have **several users whose external libraries index the same folders.** A typical case is a
household with one shared archive on disk: each member's account covers its own subset of the folders (selected
with exclusion patterns), and the subsets overlap.

They do it that way because of how ownership works in Immich:
- **Only an asset's owner** can rate it, tag it or delete it, and only the owner gets it in People, search and the
  map with every feature.
- **Partner sharing** is view-only, and all or nothing.

So the way to give two users full use of the same files, and of only some of them, is for each user's library to
index those files. Each user then owns an asset for the same file: the asset and its **twin**.

**The cost:** stock Immich computes derived data separately for every asset. Each file indexed by two accounts is
processed twice:
- thumbnails and previews;
- video transcodes;
- CLIP embeddings for smart search;
- text recognition (OCR);
- face detection.

On small hardware, such as a Raspberry Pi, that's hours of extra CPU and tens of gigabytes of extra files. On top of
that, manual face corrections (moving a face to the right person, adding a missed face, deleting a false one) apply
only to the asset they're made on, so the twins drift apart.

## Goals

1. **Each file's derived data is computed once,** however many assets refer to it. The others reuse it: files as
   hard links, database results as copies.
2. **Manual face corrections on one asset apply to its twins.**
3. **Opt-in.** With `IMMICH_SHARE_DERIVED_DATA` and `IMMICH_FIND_NEW_SIDECARS` unset or `false`, the fork behaves
   exactly like upstream.
4. **No changes to the database schema, the API, the OpenAPI spec or job types.** Switching an instance back to
   upstream's image needs no database work.
5. **A small, self-contained patch** that can be rebased onto every upstream release automatically, and that could
   be proposed upstream as an option.

**A second, independent patch** fixes a gap the same deployments hit: Immich reads a sidecar that appeared after it
indexed the file only once an admin runs the instance-wide sidecar Discover job. With `IMMICH_FIND_NEW_SIDECARS=true`,
metadata extraction (a refresh, for example) finds such a sidecar first, as Discover would, and reads it
(IMPLEMENTATION.md, section 10). It could be proposed upstream on its own, as a fix.

**Not goals:**
- Sharing per-user data between accounts (albums, favorites, ratings, tags, descriptions). Where needed, a
  deployment can keep those in step through XMP sidecars, outside Immich.
- Uploaded (non-library) assets.
- Edited versions of an asset.
- Sharing people's names. Immich's people sharing (3.3 and later) already does that within a cluster group.

## Using it

- **Image:** `ghcr.io/kael-shipman/immich-server`, under upstream's tags (`v3`, `vX.Y.Z`, `release`). Each tag is
  upstream's release of the same version plus this patch, never ahead of upstream. The machine-learning image stays
  upstream's (`ghcr.io/immich-app/immich-machine-learning`).
- **Switches**, in the server container's environment (for example in `.env`):
  - `IMMICH_SHARE_DERIVED_DATA=true`: twins reuse each other's derived data, and face corrections follow;
  - `IMMICH_FIND_NEW_SIDECARS=true`: metadata extraction finds and reads a sidecar that appeared after indexing.
- **Users who share files should be in the same cluster group** (Immich 3.2 and later). Face mirroring needs it:
  people belong to a cluster group. Without it, everything except face mirroring still works.
- **Going back to upstream:** change the image back. Files already shared stay as hard links, which upstream treats
  as ordinary files.

## Status

| Date | State |
|---|---|
| 2026-11-03 | Fork created; design written ([IMPLEMENTATION.md](IMPLEMENTATION.md)); this documentation committed on `twins`, based on `v3.3.5`. |
| 2026-11-03 | The patch (hooks H1–H6), its unit and medium tests, and the `fork-release` and `fork-ci` workflows committed on `twins`. Upstream's server unit suite (2,347 tests), lint, format and type check pass with it; so do the fork's 25 unit and 7 medium tests. |
| 2026-11-03 | First release published by `fork-release`: `ghcr.io/kael-shipman/immich-server:v3.3.5` (also `v3` and `release`), amd64 and arm64, public. Tagged `twins/v3.3.5`. The first attempt failed in the medium suite (run from the wrong directory, plus a registry rate limit), which the workflow now handles. |

| 2026-11-07 | Upstream `v3.3.6`: the first automatic rebase, published (after `FORK_PUSH_TOKEN` was replaced). |
| 2026-11-08 | The second patch, finding new sidecars (`IMMICH_FIND_NEW_SIDECARS`, IMPLEMENTATION.md section 10), with 5 unit and 2 medium tests; `v3.3.6` republished with it. |

Next: see [RESUME.md](RESUME.md).

## How the fork is organized

- **`twins`** is the working branch, and the default branch once the release workflow exists. It's one upstream
  release (the tag in [`BASE`](BASE)) plus a short stack of commits:
  1. `docs(fork): …`: this folder, and the notice at the top of the root `README.md`;
  2. `feat(server): …`: the feature;
  3. `test(server): …`: its tests;
  4. `fix(server): …`: the second patch, finding new sidecars, with its tests;
  5. `ci(fork): …`: `.github/workflows/fork-*.yml`.

  Commits 2 and 3 are what would be proposed upstream as an option, and commit 4 on its own as a fix. `docs(fork)`
  must stay first: the release workflow folds `fork/BASE` into the stack's first commit.
- **Each upstream stable release,** the stack is rebased onto it (`git rebase --onto <new tag> <old base> twins`),
  tested and published. That's done by the release workflow (IMPLEMENTATION.md, section 6). A published build is
  tagged `twins/vX.Y.Z`.
- **`main`** is left as GitHub created it. Never push to it: upstream's workflows trigger on pushes to `main`.
- **Upstream's `vX.Y.Z` tags** are never moved or re-created.
- **Upstream's workflows** are disabled in this fork. Only `fork-*.yml` workflows run.
- **The `FORK_PUSH_TOKEN` secret** lets the release workflow push rebases, which carry upstream's workflow changes
  that GitHub's default token may not push (IMPLEMENTATION.md, section 6.1).

## Keeping this documentation current

These two files are the source of truth for the fork, for people and for coding agents.

- **Behavior changes:** any change to the patch's behavior updates [IMPLEMENTATION.md](IMPLEMENTATION.md) in the
  same push: its rules, hooks, file layout and tests. Since the stack keeps documentation in the `docs(fork)` commit,
  fold the doc change into that commit (`git commit --fixup=<docs commit>`, then `git rebase -i --autosquash`).
- **Handoff:** [RESUME.md](RESUME.md) says where things stand and what's next. Update it at the end of every working
  session.
- **Status:** when the state of the fork changes (the patch lands, the workflow starts publishing, a hook is
  dropped), add a row to [Status](#status).
- **Conflicts:** every resolved rebase conflict gets an entry in the [Conflict log](#conflict-log), even a trivial
  one.
- **Rebasing:** these documents ride along with the stack, so they rebase with it.

## Resolving rebase conflicts

For whoever resolves them, person or agent. Read this whole section, then the hook table in IMPLEMENTATION.md,
section 3.4, before editing anything.

### Invariants: a resolution must keep all of these

1. **Switches off means upstream.** With `IMMICH_SHARE_DERIVED_DATA` and `IMMICH_FIND_NEW_SIDECARS` unset, every
   code path behaves exactly as upstream does.
2. **No schema, migration, API, DTO, OpenAPI or job-type changes.** Optional fields in internal job data and a
   `delay` option for the fork's re-queued jobs are the only exceptions.
3. **Every hook is guarded by the switch, and falls back to upstream's code path on any error.**
4. **Hooks stay small.** Logic lives in `server/src/utils/derived-twins.ts` and the queries appended at the end of
   `server/src/repositories/asset-job.repository.ts`. A hook is a few lines in an upstream handler.
5. **Upstream's changes are never dropped** to make ours fit.

### Steps

1. **Reproduce:**
   ```sh
   git fetch upstream --tags
   git switch twins
   git rebase --onto <new tag> "$(cat fork/BASE)" twins
   ```
2. **For each conflicting file:** take upstream's new version as the base, then re-apply the fork's hook at the
   equivalent place. IMPLEMENTATION.md, section 3.4, says for each hook:
   - what it needs as input;
   - what it returns;
   - what must happen before and after it.

   Usually upstream renamed, moved or reshaped something around the hook. Adapt the helper in `derived-twins.ts` to
   the new shape, and keep the hook itself small.
3. **Known cases:**
   - **`README.md`:** keep upstream's version, and put the fork notice back as its first lines.
   - **`fork/**` and `.github/workflows/fork-*.yml`:** upstream has none of these, so a conflict there means a stale
     rebase base. Keep ours.
   - **`server/src/services/person.service.ts`:** the most likely conflict, since upstream reworks people often. The
     detection hook replaces one call. The face-mirroring hooks are one call each, after the stock change succeeds.
   - **`server/src/repositories/asset-job.repository.ts`:** our queries are appended at the end of the class. Keep
     both upstream's additions and ours.
   - **`server/src/services/metadata.service.ts`:** the second patch's one hook (H7), in `handleMetadataExtraction`
     just after the asset is loaded. Keep it there; if upstream now finds new sidecars itself, drop the `fix(server)`
     commit (IMPLEMENTATION.md, section 10).
   - **Finding the fork's hunks:** every one is marked `// fork: derived-twins` or `// fork: new-sidecars`
     (`git grep -n "fork: "`).
     The handlers take the whole job data (`job`) rather than `{ id }`; keep that when upstream changes a signature.
   - **The job data object:** R6 relies on upstream handing a handler the same data object that `onDone` passes to
     the follow-up jobs (IMPLEMENTATION.md, R6). If upstream changes that, nothing breaks, but check that follow-up jobs
     aren't delayed.
4. **Stop rather than force it** if upstream changed the model the fork relies on. For example: derived-file paths
   no longer per asset, `asset_file` replaced, ML results moved to other tables, or faces no longer per asset. In
   that case:
   - don't write a large rewrite inside a conflict resolution;
   - write up what changed in the release workflow's issue, and propose either dropping the affected hook (each hook
     is independent) or a redesign;
   - leave the published image as it is.
5. **Update `fork/BASE`** to the new tag, in the `docs(fork)` commit.
6. **Run the tests:** `mise run ci-unit` and `mise run ci-medium`, from `server/`. All of
   upstream's tests and all of the fork's must pass. The fork's are listed in IMPLEMENTATION.md, section 5, which
   also says how to run them without mise. Don't skip, disable or loosen a test to get green.
7. **Record the resolution** in the [Conflict log](#conflict-log): the release, the files, what upstream changed,
   and what you did.
8. **Publish:** run the release workflow by hand for the new tag (`workflow_dispatch`). Or, if the workflow already
   holds the resolved branch, push `twins` with `--force-with-lease` and let the scheduled run pick it up.

## Conflict log

| Release | Files | What upstream changed | Resolution |
|---|---|---|---|
| (none yet) | | | |

## License

AGPL-3.0, as upstream. See [LICENSE](../LICENSE).
