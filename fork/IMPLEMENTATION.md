# Implementation: reusing derived data between assets of the same file

The design of this fork's patch, its tests, and how it's published. Why the fork exists and how to resolve rebase
conflicts are in [README.md](README.md).

Written against Immich **v3.3.5** and checked against **v3.4.0-rc.1**. Paths are from the repository root; line
numbers are v3.3.5's and drift with each release. Search for the named function rather than trusting the number.

**Keep this document current:** a commit that changes the patch's behavior updates this file in the same commit
(README.md, "Keeping this documentation current"). The [Change history](#10-change-history) records each change.

## 1. Overview

- **Twins:** library assets that refer to the same file. The fork lets an asset reuse what its twin already
  computed, instead of computing it again:
  - thumbnails, previews and full-size conversions (hard links);
  - video transcodes (hard links);
  - CLIP embeddings (copied rows);
  - OCR results (copied rows);
  - face detections, with their person assignments (copied rows).
- **When twins are processed at the same time,** one does the work and the others wait for it (R6).
- **Manual face corrections** on one asset (reassign, add, delete) are applied to its twins (H6).
- **The switch:** everything is behind `IMMICH_SHARE_DERIVED_DATA=true`, and falls back to upstream's behavior on
  any error.
- **The size:** about 600 lines of code, plus tests.
  - One new file holds the logic.
  - Small hooks go into upstream's job and service handlers.
  - Queries are appended to one repository.
  - Small hunks add delayed re-queuing and a `link` method.

## 2. How upstream works (v3.3.5)

### 2.1 Derived files

- **Paths are fixed per owner and asset.**
  - Thumbnails, previews and full-size images go to `thumbs/<ownerId>/<aa>/<bb>/<assetId>_<type>[_edited].<format>`
    (`server/src/cores/storage.core.ts`, `getImagePath`, line 124).
  - Transcodes go to `encoded-video/<ownerId>/<aa>/<bb>/<assetId>.mp4` (`getEncodedVideoPath`, line 132).
  - The `asset_file` table records each one: type, path, `isEdited`, `isProgressive`, `isTransparent`.
  - Regenerating writes to the same path.
- **Files are written in place.** sharp's `toFile` (`server/src/repositories/media.repository.ts`,
  `generateThumbnail`, line 190) and ffmpeg's output (`transcode`, line 444) open the existing path for writing. A
  hard-linked file is therefore rewritten for every asset that links to it. That's intended (R4).
- **Deletion is an unlink.**
  - The `FileDelete` job (`server/src/services/storage.service.ts`, `handleDeleteFiles`, line 137) unlinks each
    path.
  - `syncFiles` (`server/src/services/media.service.ts`, line 776) only deletes paths that the asset's own
    `asset_file` rows held.
  - With hard links, the last unlink frees the space, and a twin's file is never removed by another asset.
- **Integrity checks** (`server/src/services/integrity.service.ts`): a file counts as untracked only if no
  `asset_file` row names its path. Each link has its own row, so links count as tracked. The checksum check covers
  originals only.
- **Storage migration** (`media.service.ts`, `handleAssetMigration`, line 139) renames files whose expected path
  changed. A rename keeps the link.
- **Why each asset needs its own path** (and why the fork links files rather than pointing two `asset_file` rows at
  one path): deleting an asset deletes the paths in its rows, and storage migration moves any file that isn't at the
  asset's expected path. Both would break the twin.

### 2.2 When derived data is made

- **Thumbnails** (`media.service.ts`, `handleGenerateThumbnails`, line 192) run:
  - for a new asset, after its first metadata extraction;
  - from "queue all", for assets missing a thumbnail, preview or thumbhash
    (`server/src/repositories/asset-job.repository.ts`, `streamForThumbnailJob`, line 64);
  - from "regenerate" (`server/src/services/asset.service.ts`, `run`, line 490), or "queue all" with `force`.
- **What follows:** `server/src/services/job.service.ts`, `onDone`, lines 167–185. After a new asset's thumbnails,
  it queues smart search, face detection and OCR, plus transcoding for videos. **`onDone` runs when a handler returns
  `Success` or `Skipped`** (`onJobRun`, line 91), and only then.
- **A metadata refresh** (`AssetExtractMetadata`) re-reads the metadata only. It doesn't regenerate thumbnails or
  re-run machine learning.
- **Transcoding:** `media.service.ts`, `handleVideoConversion`, line 554. If the transcode policy requires it, ffmpeg
  writes the asset's `encoded-video` path (line 600), and the asset gets an `EncodedVideo` file row.
- **Machine learning:** each handler makes one call to the ML service, then works only on the result.
  - **Smart search:** `server/src/services/smart-info.service.ts`, `handleEncodeClip`, line 103:
    `encodeImage(previewPath)`, then `searchRepository.upsert(id, embedding)`.
  - **OCR:** `server/src/services/ocr.service.ts`, `handleOcr`, line 47: `ocr(previewPath)`, then
    `parseOcrResults`, `ocrRepository.upsert`, and `ocrAt` in `asset_job_status`.
  - **Faces:** `server/src/services/person.service.ts`, `handleDetectFaces`, line 400:
    `detectFaces(previewPath)` returns `{ imageWidth, imageHeight, faces: [{ boundingBox, embedding }] }`.
    - The rest of the handler matches faces against existing ones and writes `asset_face` and `face_search`
      (`refreshFaces`).
    - It queues `FacialRecognition` for each new face, and sets `facesRecognizedAt`.
  - All three read **the preview file**.
- **Forced re-runs delete before re-queuing:**
  - face detection deletes all ML faces (`handleQueueDetectFaces`);
  - OCR deletes all OCR (`handleQueueOcr`);
  - a CLIP model change deletes all embeddings (`smart-info.service.ts`, `init`).

### 2.3 People

Four tables, from `server/src/schema/tables/`:
- **`cluster_group`:** a set of users whose faces are clustered together (3.2).
- **`person_group`:** an identity within a cluster group. `asset_face.personGroupId` points here.
- **`person`:** each user's own record for a person group (`ownerId`, `personGroupId`, name, birth date, hidden,
  favorite).
- **`person_user`:** sharing a person group with another user, with a role (3.3).

What follows from that:
- **Recognition** (`person.service.ts`, `handleRecognizeFaces`, line 543) searches faces across the whole cluster
  group. It skips faces that already have a `personGroupId`. When it assigns a group for the first time, it creates
  the owner's `person` row.
  - So a twin's face, whose embedding is identical, is assigned the same person group automatically, as long as both
    owners are in one cluster group.
- **Manual corrections** change one `asset_face` row:
  - `reassignFaces` (line 88) and `reassignFacesById` (line 132) set `personGroupId`;
  - `createFace` (line 749) inserts a `Manual` face;
  - `deleteFace` (line 824) soft-deletes it, or hard-deletes it with `force`.

  Twins don't follow. That's what H6 adds.
- **Names** are per `person` row. A rename also updates the rows of owners who shared that person group with the
  renaming user with a write role (`person.repository.ts`, `updateForWritableOwners`).
- **Merges** apply across owners who share the people (`mergePeople`).
- Keeping names in step is a deployment concern, handled by Immich's people sharing. The fork doesn't touch it.

### 2.4 Finding twins

A library asset's `checksum` is a hash of its path (`server/src/services/library.service.ts`, `processEntity`:
`sha1('path:' + path)`). `asset` has an index on `(originalPath, libraryId)` (`server/src/schema/tables/asset.table.ts`,
line 57). So "the same file in other libraries" is one indexed lookup on `originalPath`.

The unique index is `(ownerId, libraryId, checksum)`, so different users' libraries, or one user's two libraries,
may index the same file.

### 2.5 Jobs and delays

`server/src/repositories/job.repository.ts`, `getJobOptions`, line 257, sets per-job BullMQ options. Upstream
already uses `delay` for `NotifyAlbumUpdate`. The asset job data type is `IEntityJob` (`server/src/types.ts`,
line 235): `{ id, source?, notify? }`.

## 3. Design

### 3.1 Switch

`IMMICH_SHARE_DERIVED_DATA=true` turns everything on. It's read with `process.env`, the way upstream reads
`IMMICH_PROCESS_INVALID_IMAGES` (`media.service.ts`, line 247), so `dtos/env.dto.ts` isn't touched. It's off by
default.

### 3.2 Twins

Asset **T** is a twin of asset **A** when:
- T isn't A;
- both are library assets (`libraryId` not null), with the same `originalPath`;
- T isn't deleted (`deletedAt` null) or offline (`isOffline` false);
- T has the same `type` and the same `fileModifiedAt` (the same version of the file);
- T isn't edited (`isEdited` false), since an edited asset's thumbhash is the edited version's.

The owner doesn't matter for derived files and ML results. Face assignments (H5's pull and H6) also need both owners
in the same cluster group, because a `person_group` belongs to one cluster group.

### 3.3 Rules

- **R1. First time only.** Derived data is reused only when A has none of that kind yet:
  - no thumbnail or preview row, for thumbnails;
  - no `EncodedVideo` row, for transcodes;
  - no embedding, for smart search;
  - `ocrAt` null, for OCR;
  - `facesRecognizedAt` null, for faces.

  "Regenerate", forced re-runs, config changes and edits always take upstream's path. That rules out reusing data
  that's stale relative to something the user just did.
- **R2. Fresh relative to the file.**
  - A twin's derived file counts only if it's newer than the original (the derived file's mtime ≥ the original's
    mtime, both `stat`ed).
  - ML results count only if A's preview is the same inode as T's preview, which proves identical input. It is, when
    A's thumbnails were linked under R3.
- **R3. Files are hard-linked.** For each of T's non-edited files (preview, thumbnail, full-size if present, or the
  encoded video):
  1. Build A's own path with upstream's path functions.
  2. Make the folders.
  3. `link(T's path, A's path)`.
  4. Upsert A's `asset_file` row with T's `isProgressive` and `isTransparent`.

  For thumbnails, also copy T's thumbhash. The file extensions must match the configured formats
  (`image.preview.format`, `image.thumbnail.format`); otherwise, take upstream's path.
- **R4. A rewrite is shared, by design.** Regenerating any linked asset rewrites the shared file in place (2.1), so
  every twin gets the new version.
  - That's correct: twins have the same original, and the config is server-wide. Edited versions, the only thing
    that differs per asset, use separate `_edited` paths and are never linked.
  - **Side effects, accepted:**
    - during a rewrite, every twin sees the partial file;
    - a rewrite that fails leaves every twin with a broken file until any of them is regenerated;
    - the other twins keep their old thumbhash until they're regenerated themselves.
  - No code is needed for this rule.
- **R5. Any failure falls back.** Any error while finding or using a twin (a missing file, a race with a deletion, a
  failed query) is logged at `debug`, and the handler continues as upstream's code.
- **R6. One twin does the work; the others wait for it.**
  - **The race:** new files are usually seen by every library that indexes them within seconds, so the twins' jobs
    run at about the same time, and none finds a finished twin. R1–R3 alone would process most new files more than
    once.
  - **The leader:** among a file's twins (A included), the one with the lowest asset ID. It's deterministic, needs no
    lock, and every job computes the same answer.
  - **For each kind of data,** the job does this:
    1. If any twin already has the data and it passes R2, reuse it (R3, or the ML copies in 3.4).
    2. Otherwise, if A is the leader, do the work as upstream does.
    3. Otherwise, re-queue this job with a delay, and stop. The delay is 30 s for thumbnails and ML, and 2 min for
       transcodes. A counter, `twinWaits`, in the job data counts the waits.
    4. Once the waits pass a budget (10 min for thumbnails and ML, 2 h for transcodes), do the work anyway. That
       covers a leader that failed, is hidden, or was deleted.
  - **The waiting job must not return `Success` or `Skipped`** (2.2: `onDone` would queue A's follow-up jobs before
    A has a preview). It returns `Failed`. Checked in v3.3.5: the only consumer of that status is the optional
    telemetry counter (`telemetry.service.ts`, `onJobSuccess`); nothing retries, logs or shows it.
  - **The re-queue keeps the job's data** (`source`, `notify`), so A's follow-up jobs run once it finishes.
  - **Proceeding clears the wait fields.** A job that proceeds (reuse or work) deletes `twinWaits` and `delay` from
    its data. Upstream hands the handler the same data object that `onDone` passes on to the follow-up jobs
    (`job.repository.ts`, `run`; `job.service.ts`, `onDone`), so they start with no delay and a fresh wait budget.
    If upstream ever copies the data instead, the follow-up jobs simply start without the fields.
  - **Delays need two small hunks:**
    - `getJobOptions` returns `{ delay }` for the fork's re-queued jobs;
    - `IEntityJob` gets optional `twinWaits` and `delay` fields.

### 3.4 Hooks

Each hook is a few lines in upstream's handler and calls a helper in `server/src/utils/derived-twins.ts`. Each
helper returns `undefined` when it has nothing to offer, and the handler then continues as upstream does. Helpers
apply R1, R2, R5 and R6.

| Hook | Where | Inputs, and the result it gives the handler | Must happen |
|---|---|---|---|
| **H1. Thumbnails** | `media.service.ts`, `handleGenerateThumbnails`, before choosing `generateVideoThumbnails` or `generateImageThumbnails` | `reuseTwinThumbnails(asset, config)`. Returns `{ files, thumbhash, fullsizeDimensions }`, the same shape `generateImageThumbnails` returns, with the files already linked (R3). Or it returns "wait" (R6), and the handler re-queues and returns. | Only when A has no files and isn't edited. Before `syncFiles`, so the upstream code upserts the rows. |
| **H2. Transcode** | `media.service.ts`, `handleVideoConversion`, after the "not required" early return, before `transcode` | `reuseTwinEncodedVideo(asset)`. It links T's encoded video (R3), and the handler upserts the `EncodedVideo` row and returns `Success`. Or "wait". | After the policy check, so a video that needs no transcode stays without one. |
| **H3. Smart search** | `smart-info.service.ts`, `handleEncodeClip`, the `encodeImage` call | `twinEmbedding(asset)`. Returns T's `smart_search.embedding`, or "wait". The handler uses it in place of `encodeImage`. | The model-change check after it stays as is. |
| **H4. OCR** | `ocr.service.ts`, `handleOcr`, the `machineLearningRepository.ocr` call | `twinOcr(asset)`. Returns the ML response shape (`{ box, boxScore, text, textScore }`) rebuilt from T's `asset_ocr` rows, so `parseOcrResults` and the rest stay unchanged. Or "wait". | `ocrAt` is set by the upstream code after it. |
| **H5. Face detection** | `person.service.ts`, `handleDetectFaces`, the `machineLearningRepository.detectFaces` call | `twinFaces(asset)`. Returns `{ imageWidth, imageHeight, faces: [{ boundingBox, embedding, score }] }` from T's ML-sourced, non-deleted faces and their `face_search` embeddings. Or "wait". | **Pull:** right after `refreshFaces`, before the recognition jobs are queued, if faces came from a twin: `mirrorFaces(T, only A)` (H6's function, skipped unless the owners share a cluster group). A's new faces then get T's person groups, including T's manual corrections, and their recognition jobs skip them as already assigned. |
| **H6. Face edits** | `person.service.ts`: `reassignFaces`, `reassignFacesById`, `createFace` (after upstream's change), and `deleteFace` (reads the face with `getTwinFace` first, then mirrors the deletion) | `mirrorFaces(A)` returns the twins' people whose feature face moved away; the handler passes them to upstream's `createNewFeaturePhoto`. `mirrorFaceDeletion(face, force)`. | Only when the owners share a cluster group. It writes through repositories, not service methods, so there's no recursion or permission re-check. |

**`mirrorFaces(source → target)`** makes the target's faces match the source's:
1. **Matching:** faces are matched by bounding box, normalized by each face's `imageWidth` and `imageHeight`, with
   IoU ≥ 0.9. Faces copied by H5 are identical, and independently detected ones are near-identical.
2. **A matched pair:** if the person groups differ, set the target face's `personGroupId` to the source's. If the
   target's owner has no `person` row for that group, create one, as `handleRecognizeFaces` does, and queue its
   person thumbnail.
3. **A source face with no match:** if it's `Manual`, create a `Manual` face on the target, with the same box and
   group. If it's ML-sourced, skip it: the target's own detection is authoritative for ML faces it doesn't have.
4. **A target face with no match:** if the source's matching face was deleted (soft or hard), delete it the same
   way. Otherwise (the target simply detected more), leave it.
5. **Conflicts:** the last edit wins, since each edit pushes to every twin.

Personal person properties (hidden, favorite, color, feature photo) are never mirrored. Merges need no hook:
`mergePeople` already applies across owners who share the people.

### 3.5 Code layout

Kept small and separate, for easy rebases:

| File | Change | Size |
|---|---|---|
| `server/src/utils/derived-twins.ts` (new) | The helpers (`reuseTwinThumbnails`, `reuseTwinEncodedVideo`, `twinEmbedding`, `twinOcr`, `twinFaces`, `mirrorFaces`, `mirrorFaceDeletion`, `faceIou`) and the shared decision (`resolveFromTwins`: R1, R2, R5, R6). Each takes the repositories it needs as arguments, so `base.service.ts`'s constructor (which every test helper mirrors) isn't touched. Links only ever happen inside Immich's `thumbs/` and `encoded-video/` folders; anything else is refused. | ~470 lines |
| `server/src/repositories/asset-job.repository.ts` | Queries appended at the end of the class: `getTwinGroup` (the asset and its twins, with files, job status, embedding flag and cluster group), `getTwinEmbedding`, `getTwinDetectedFaces` (ML faces with `face_search` embeddings), `getTwinFaces` (all live faces, with the owner's feature face), `getTwinFace`. No `@GenerateSql` decorators, so upstream's SQL snapshot check isn't involved. | ~130 lines |
| `media.service.ts`, `smart-info.service.ts`, `ocr.service.ts`, `person.service.ts` | The hooks (H1–H6). The handlers take the whole job data (`job`) instead of `{ id }`, to re-queue it. `media.service.ts` and `person.service.ts` each get a private `twinRepos()` / `twinFaceRepos()` method. Every hunk is marked `// fork: derived-twins`. | ~10–40 lines each |
| `server/src/repositories/job.repository.ts`, `server/src/types.ts` | `delay` in `getJobOptions` for the five job types; `twinWaits` and `delay` on `IEntityJob` (R6) | ~15 lines |
| `server/src/repositories/storage.repository.ts`, `server/test/repositories/storage.repository.mock.ts` | `link(source, target)`, and its mock | ~5 lines |
| `server/src/utils/derived-twins.spec.ts` (new) and `server/test/medium/specs/services/derived-twins.service.spec.ts` (new) | Tests (section 5) | ~700 lines |

### 3.6 Not shared

- **Edited versions** (`_edited` files): each asset makes its own.
- **Person thumbnails:** per user and person, cheap.
- **HLS streaming sessions:** made on the fly.
- **Uploaded assets** (no library): they have no twins.
- **Metadata extraction:** exiftool per asset, cheap, and each owner needs its own.
- **Facial recognition** (assigning faces to people): a database search per face, cheap. H5's pull makes it skip
  faces whose group came from a twin.

### 3.7 Edge cases

- **The twin is being deleted while A links to it:** the link fails, or the file vanishes. R5 makes A generate its
  own.
- **A forced face re-run while a new twin arrives:** T may have `facesRecognizedAt` set but its faces deleted, so A
  copies zero faces. "Refresh faces" on A fixes it. This is a known limitation.
- **A config change:** the format check in R3 catches format changes. A size or quality change without a forced
  regeneration leaves the twins at the old setting, as upstream already does for every asset.
- **Turning the switch off, or going back to upstream:** the links stay, and behave as R4 describes, because that's
  upstream's own in-place write.
- **More than two twins:** the same rules hold. The leader does the work once for all of them, and edits are
  mirrored to each.
- **Owners in different cluster groups:** files and ML results are still shared. Face assignments aren't mirrored
  (H5's pull and H6 are skipped).
- **Disk accounting:** `du` counts a linked file once, and content-addressed backups (such as restic) store it once.
  Immich's storage statistics count originals only.

## 4. Branches, commits and tags

- **`twins`:** upstream's latest stable release (`fork/BASE`) plus a commit stack:
  1. `docs(fork)`: `fork/` and the notice at the top of `README.md`;
  2. `feat(server)`: the feature;
  3. `test(server)`: its tests;
  4. `ci(fork)`: `.github/workflows/fork-*.yml`.

  Commits 2 and 3 are what would go upstream.
- **Rebasing, not merging:** each release rebases the stack, `git rebase --onto <new tag> <old base> twins`. That
  keeps `twins` readable as "release + 4 commits". Upstream's release branches cherry-pick fixes back, so merging
  tags from different branches into one long-lived branch would conflict for reasons unrelated to the patch.
- **Tags:** `twins/vX.Y.Z` marks each published build. Upstream's `vX.Y.Z` tags are never moved.
- **`main`:** never pushed to, so upstream's push-triggered workflows never fire.
- **Development:** happens on `dev/**` branches, tested by `fork-ci.yml`, then squashed into the stack.

## 5. Tests

**Unit tests** (Vitest, upstream's automocked repositories), for each hook:
- the switch off means upstream's path, and no twin queries;
- a twin with complete, fresh data means no call to sharp, ffmpeg or ML, and a link or copy instead;
- data already present (R1), a stale twin (R2) or a format mismatch means upstream's path;
- an error while linking falls back (R5);
- R6:
  - a non-leader with an unfinished leader re-queues with a delay, and doesn't return `Success` or `Skipped`;
  - after the budget, it does the work itself;
- `mirrorFaces`: a reassignment, a manual face and a deletion each reach the twin. Personal properties aren't
  mirrored. Different cluster groups mean nothing is mirrored.

**Medium tests** (real Postgres and a temporary file system): two users, each with a library over one folder holding
a JPEG and a short MP4.
- Run the first user's jobs, then the second's. **Check:**
  - the second asset's thumbnail, preview and encoded video have the first asset's inode (`nlink == 2`);
  - its embedding, OCR and faces equal the first's;
  - deleting the first asset (trash, then empty) leaves the second's files readable;
  - regenerating the second rewrites the shared file, and the first sees the new version (R4).
- **The race (R6):** both libraries scanned at the same time. Spies on the media and ML repositories confirm that
  each kind of work runs exactly once.
- **Face edits (H6):** with both users in one cluster group, reassign a face on the first asset; the second's
  matching face follows. Then add and delete a manual face.

**CI:** upstream's `mise run ci-unit` and `mise run ci-medium`, from `server/`, pass with the patch.

**What exists (2026-11-03):** 25 unit tests (`server/src/utils/derived-twins.spec.ts`, with a real temporary
directory for the links) and 7 medium tests (`derived-twins.service.spec.ts`: `getTwinGroup`, H3 reuse, H3 wait, the
switch off, H4, H5 with the pull, H6 deletion). Not yet automated: the full thumbnail and transcode jobs end to end,
and the race between two scans; those are covered by the dev-instance check before deployment.

**Running the tests without mise** (for example on a machine with only Docker): run them in a `node:24` container,
with pnpm from corepack, the clone mounted at `/src`, and the Docker socket mounted for the medium tests'
testcontainers (`--network host`). The medium tests that read `e2e/test-assets` (exif, library import) and the workflow
plugin tests need `git submodule update --init e2e/test-assets` and `mise run //:plugins` first; without them they
fail for reasons unrelated to the fork.

## 6. Publishing

### 6.1 `.github/workflows/fork-release.yml`

- **Triggers:** `schedule` (every 6 hours) and `workflow_dispatch`, with an optional `tag` input. No pull-request
  triggers.
- **Permissions:** `contents: write`, `packages: write`, `issues: write`, `actions: write`. Actions are pinned by
  SHA.
- **Concurrency:** one run at a time (`group: fork-release`, no cancel-in-progress).

**Jobs:**

1. **`check`:**
   - `gh api repos/immich-app/immich/releases/latest --jq .tag_name` (stable releases only).
   - Stop if `twins/<tag>` exists.
   - Outputs `tag` and `major`.
2. **`rebase`:**
   1. Check out `twins` with full history, fetch upstream's tags, and run
      `git rebase --onto <tag> "$(cat fork/BASE)" twins`.
   2. Update `fork/BASE` in the `docs(fork)` commit.
   3. **On a conflict:** abort, and open or update an issue, "Rebase onto <tag> failed". It lists the conflicting
      files and the commit, and links `fork/README.md`, "Resolving rebase conflicts". Then fail.
   4. Compare the reusable build workflow's pinned SHA (below) with the one in the release's own `docker.yml`. Note
      any difference in the run summary and the issue.
   5. Push the result to `twins-candidate`.
3. **`test`**, on the rebased commit, the way upstream's `test.yml` runs the server suites: Mise, then from
   `server/`, `mise run ci-unit` and `mise run ci-medium`, with the `e2e/test-assets` submodule checked out. Each is
   retried once, since the medium tests' testcontainers can hit a registry rate limit. Running `ci-medium` from the
   repository root (`//server:ci-medium`) finds no test files.
4. **`build`:** one job per platform, `linux/amd64` on `ubuntu-latest` and `linux/arm64` natively on
   `ubuntu-24.04-arm`. Each checks out the rebased commit and runs upstream's single-platform build action,
   `immich-app/devtools/actions/image-build` (pinned by SHA), the same step upstream's `docker.yml` runs through
   `multi-runner-build.yml`. That reusable workflow can't be used directly: it always builds the commit that triggered
   the run, not the rebased one. It pushes by digest, with `build-args: DEVICE=cpu`.
5. **`publish`:**
   1. Merge the two digests into one multi-platform image: `<tag>`, plus `<major>` and `release` when the tag is
      upstream's latest release (a manual rebuild of an older release doesn't move them).
   2. Push the rebased commit to `twins` (`--force-with-lease` against the commit the run started from), delete
      `twins-candidate`, and tag `twins/<tag>`.
   3. Close the tag's failure issues.
   4. Disable every workflow that isn't `fork-*.yml`: `gh workflow list --all --json id,path,state`, then
      `gh workflow disable`.
6. **`report`**, on any failure: opens (or comments on) the issue "Fork release <tag> failed", with the conflicting
   files when the rebase failed and a link to the run.

**Secrets and settings:**
- **`FORK_PUSH_TOKEN`:** a fine-grained personal access token for this repository only, with Contents and Workflows
  read/write. GitHub's default token can't push commits that change `.github/workflows/`, and every rebase onto a new
  upstream release carries upstream's workflow changes. It's only used when a rebase is needed; the run fails with a
  clear error without it.
- **Issues** must be enabled on the fork, for the failure reports.
- **`twins` must be the default branch:** scheduled workflows and the "Run workflow" button only see the default
  branch's workflows.

**Notes:**
- GitHub emails a failed scheduled run to whoever last changed the schedule, and the issue is a second, durable
  signal.
- GitHub disables scheduled workflows in public repositories after 60 days without activity. Each release's push
  counts as activity.

### 6.2 `.github/workflows/fork-ci.yml`

The `test` job's commands, on pushes to `dev/**` and by hand. It never builds or publishes.

### 6.3 The image

`ghcr.io/kael-shipman/immich-server` was created by the first publish (2026-11-03), and is public: it inherited the
repository's visibility, so instances pull it without a token. Check after any change to the package's settings. The image reports upstream's version (from
`server/package.json`), which the mobile apps check. Its "About" page links to upstream: the Dockerfile's build-info
variables are left as they are, to avoid a conflict-prone hunk.

## 7. Deploying

- **Compose:** point the server's `image:` at `ghcr.io/kael-shipman/immich-server:${IMMICH_VERSION:-release}`, or make
  the repository a variable. The machine-learning image stays upstream's.
- **Switch:** set `IMMICH_SHARE_DERIVED_DATA=true` in the server's environment.
- **Updates:** the same tags as upstream, published within about 6 hours of an upstream release, so `docker compose
  pull` within a pinned major version works as it does with upstream.
- **Going back:** switch the image back. Since the fork's tags never run ahead of upstream's versions, that's a
  same-version or forward move, and no database work is needed.
- **Staleness:** if the fork's workflow is stuck, the image stops following upstream. A deployment should compare its
  running version with upstream's latest release now and then.

## 8. Risks

- **Security lag:** a fix in an upstream release reaches the fork's image only after its rebase and tests pass. A
  conflict holds the image back until it's resolved (README.md).
- **Rebase conflicts:** most likely in `person.service.ts`, which upstream reworks often. Every hook is independent,
  so dropping a hook is always a fallback.
- **Upstream changing the derived-data model:** for example content-addressed files, or shared assets across users.
  The fork may then become unnecessary, or need redesigning.
- **Supply chain:** the workflow builds upstream's releases with the repository's token. Actions are pinned by SHA,
  and there are no pull-request triggers.

## 9. Open items

Resolved while implementing (2026-11-03):
- Returning `Failed` from a waiting job is only counted by the optional telemetry (R6).
- H5's pull runs right after `refreshFaces`, before the recognition jobs are queued, so they skip the pulled faces.
- `deleteFace` mirrors the soft or hard delete the user chose.
- `twinFaces` leaves out faces the twin's owner deleted, so a deleted false face isn't copied.

Still open:
- An end-to-end test of H1 and H2 through `MediaService` with real files, and of the R6 race between two scans.
- Whether a manual "refresh faces" on one twin should also refresh the other (today: no; each owner's refresh is
  their own).

## 10. Change history

| Date | Change |
|---|---|
| 2026-11-03 | First version, from v3.3.5's source: hooks H1–H6, rules R1–R6, publishing workflow. |
| 2026-11-03 | Implemented. Changes from the first version: the queries' real names (3.5); proceeding jobs clear their wait fields (R6); the build calls upstream's `image-build` action per platform rather than `multi-runner-build.yml` (6.1); `FORK_PUSH_TOKEN`, issues and the default branch (6.1); open items resolved (9). |
