/**
fork: derived-twins.

Library assets that refer to the same file ("twins", e.g. when several users' libraries index the same folders)
reuse each other's derived data instead of computing it again: thumbnails and transcodes as hard links, and
embeddings, OCR and face detections as copies. Manual face edits on one twin are mirrored to the others. Opt-in
with IMMICH_SHARE_DERIVED_DATA=true. Design and rules (R1-R6, H1-H6): fork/IMPLEMENTATION.md.

Every helper falls back to upstream's behavior ("work") on any error, and does nothing when the switch is off.
*/
import { randomUUID } from 'node:crypto';
import { dirname, extname, isAbsolute, relative, resolve as resolvePath } from 'node:path';
import { ImagePathOptions, StorageCore, ThumbnailPathEntity } from 'src/cores/storage.core.js';
import { SystemConfig } from 'src/dtos/config.dto.js';
import { AssetFileType, JobName, SourceType, StorageFolder } from 'src/enum.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { Face, OCR } from 'src/repositories/machine-learning.repository.js';
import { OcrRepository } from 'src/repositories/ocr.repository.js';
import { PersonId, PersonRepository } from 'src/repositories/person.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { IEntityJob, JobItem } from 'src/types.js';

export const isDerivedDataSharingEnabled = () => process.env.IMMICH_SHARE_DERIVED_DATA === 'true';

/** R6: how long a twin waits between checks, and in total, before doing the work itself. */
export const TWIN_WAIT = {
  short: { delay: 30_000, budget: 10 * 60_000 },
  long: { delay: 2 * 60_000, budget: 2 * 60 * 60_000 },
};

/** Faces on twins are the same face when their normalized bounding boxes overlap at least this much. */
export const TWIN_FACE_MATCH_IOU = 0.9;

export type TwinJobName =
  | JobName.AssetGenerateThumbnails
  | JobName.AssetEncodeVideo
  | JobName.SmartSearch
  | JobName.Ocr
  | JobName.AssetDetectFaces;

export type TwinJob = { name: TwinJobName; data: IEntityJob };

export type TwinResult<T> = { action: 'reuse'; value: T; twinId: string } | { action: 'wait' } | { action: 'work' };

type TwinRow = Awaited<ReturnType<AssetJobRepository['getTwinGroup']>>[number];
type TwinFile = TwinRow['files'][number];

interface BaseRepos {
  assetJobRepository: AssetJobRepository;
  jobRepository: JobRepository;
  storageRepository: StorageRepository;
  logger: LoggingRepository;
}

const WORK = { action: 'work' } as const;

const getFile = (row: TwinRow, type: AssetFileType): TwinFile | undefined =>
  row.files.find((file) => file.type === type);

const loadGroup = async (repos: Pick<BaseRepos, 'assetJobRepository'>, id: string) => {
  const rows = await repos.assetJobRepository.getTwinGroup(id);
  const self = rows.find((row) => row.id === id);
  const others = rows.filter((row) => row.id !== id);
  // An edited twin's thumbhash and visible faces/OCR are the edited version's: never reuse from one.
  const twins = others.filter((row) => !row.isEdited);
  return { self, others, twins };
};

/** R6: the twin with the lowest ID does the work; the others re-queue themselves until it's done, up to a budget. */
const waitOrWork = async (
  repos: BaseRepos,
  self: TwinRow,
  twins: TwinRow[],
  job: TwinJob,
  wait: (typeof TWIN_WAIT)['short'],
): Promise<'wait' | 'work'> => {
  const leader = [self.id, ...twins.map((twin) => twin.id)].sort()[0];
  if (leader === self.id) {
    return 'work';
  }

  const waits = job.data.twinWaits ?? 0;
  if (waits * wait.delay >= wait.budget) {
    repos.logger.debug(`Twin ${leader} hasn't finished ${job.name} for asset ${self.id}; doing it here`);
    return 'work';
  }

  await repos.jobRepository.queue({
    name: job.name,
    data: { ...job.data, twinWaits: waits + 1, delay: wait.delay },
  } as JobItem);
  repos.logger.debug(`Asset ${self.id} waits for twin ${leader} to finish ${job.name}`);
  return 'wait';
};

/**
The shared decision for every kind of derived data:
R1 (only the first time), reuse from a twin when it passes `reuse` (R2/R3), otherwise R6, and R5 on any error.
*/
const resolveFromTwins = async <T>(
  repos: BaseRepos,
  id: string,
  job: TwinJob,
  wait: (typeof TWIN_WAIT)['short'],
  options: {
    selfHasData: (self: TwinRow) => boolean;
    twinHasData: (twin: TwinRow) => boolean;
    reuse: (self: TwinRow, twin: TwinRow) => Promise<T | undefined>;
  },
): Promise<TwinResult<T>> => {
  const result = await decide(repos, id, job, wait, options);
  if (result.action !== 'wait') {
    // Upstream passes this same data object on to the follow-up jobs (job.service.ts, onDone): they must start with
    // neither the delay nor this job's spent wait budget.
    delete job.data.twinWaits;
    delete job.data.delay;
  }
  return result;
};

const decide = async <T>(
  repos: BaseRepos,
  id: string,
  job: TwinJob,
  wait: (typeof TWIN_WAIT)['short'],
  options: {
    selfHasData: (self: TwinRow) => boolean;
    twinHasData: (twin: TwinRow) => boolean;
    reuse: (self: TwinRow, twin: TwinRow) => Promise<T | undefined>;
  },
): Promise<TwinResult<T>> => {
  if (!isDerivedDataSharingEnabled()) {
    return WORK;
  }

  try {
    const { self, twins } = await loadGroup(repos, id);
    if (!self || self.isEdited || options.selfHasData(self) || twins.length === 0) {
      return WORK;
    }

    const withData = twins.filter((twin) => options.twinHasData(twin));
    for (const twin of withData) {
      const value = await options.reuse(self, twin);
      if (value !== undefined) {
        repos.logger.debug(`Asset ${id} reuses ${job.name} results from twin ${twin.id}`);
        return { action: 'reuse', value, twinId: twin.id };
      }
    }

    // A twin has the data but it can't be reused (stale, other format, other preview): do our own, don't wait.
    if (withData.length > 0) {
      return WORK;
    }

    return { action: await waitOrWork(repos, self, twins, job, wait) };
  } catch (error: Error | any) {
    repos.logger.debug(`Not reusing twin data for asset ${id} (${job.name}): ${error?.message ?? error}`);
    return WORK;
  }
};

const isInside = (path: string, folder: string) => {
  const relativePath = relative(resolvePath(folder), resolvePath(path));
  return !!relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath);
};

/** R2: every derived file is at least as new as the original. */
const areFresh = async (repos: BaseRepos, originalPath: string, paths: string[]) => {
  const original = await repos.storageRepository.stat(originalPath);
  for (const path of paths) {
    const stats = await repos.storageRepository.stat(path);
    if (stats.mtimeMs < original.mtimeMs) {
      return false;
    }
  }
  return true;
};

/** R3: hard-links a twin's derived file to this asset's own path. Only ever inside Immich's own derived folders. */
const linkFile = async (repos: BaseRepos, source: string, target: string, folder: StorageFolder) => {
  const base = StorageCore.getBaseFolder(folder);
  if (!isInside(source, base) || !isInside(target, base)) {
    throw new Error(`Refusing to link ${source} to ${target}: outside ${base}`);
  }

  repos.storageRepository.mkdirSync(dirname(target));
  if (await repos.storageRepository.checkFileExists(target)) {
    await repos.storageRepository.unlink(target);
  }
  await repos.storageRepository.link(source, target);
};

/** R2 for ML results: this asset's preview is the twin's preview (same inode), so the input was identical. */
const isSamePreview = async (repos: BaseRepos, self: TwinRow, twin: TwinRow) => {
  const mine = getFile(self, AssetFileType.Preview);
  const theirs = getFile(twin, AssetFileType.Preview);
  if (!mine || !theirs) {
    return false;
  }

  const [a, b] = await Promise.all([
    repos.storageRepository.stat(mine.path),
    repos.storageRepository.stat(theirs.path),
  ]);
  return a.ino === b.ino && a.dev === b.dev;
};

export type TwinThumbnails = {
  files: {
    assetId: string;
    type: AssetFileType;
    path: string;
    isEdited: boolean;
    isProgressive: boolean;
    isTransparent: boolean;
  }[];
  thumbhash: Buffer;
};

/** H1: thumbnails, previews and full-size images, linked from a twin. */
export const reuseTwinThumbnails = (
  repos: BaseRepos,
  asset: ThumbnailPathEntity & { originalPath: string },
  image: SystemConfig['image'],
  job: TwinJob,
) =>
  resolveFromTwins<TwinThumbnails>(repos, asset.id, job, TWIN_WAIT.short, {
    selfHasData: (self) => self.files.some((file) => file.type !== AssetFileType.EncodedVideo),
    twinHasData: (twin) => !!getFile(twin, AssetFileType.Thumbnail) && !!getFile(twin, AssetFileType.Preview),
    reuse: async (_self, twin) => {
      const thumbnail = getFile(twin, AssetFileType.Thumbnail)!;
      const preview = getFile(twin, AssetFileType.Preview)!;
      if (
        !twin.thumbhash ||
        !thumbnail.path.endsWith(`.${image.thumbnail.format}`) ||
        !preview.path.endsWith(`.${image.preview.format}`)
      ) {
        return;
      }

      const sources = twin.files.filter((file) => file.type !== AssetFileType.EncodedVideo);
      if (
        !(await areFresh(
          repos,
          asset.originalPath,
          sources.map((file) => file.path),
        ))
      ) {
        return;
      }

      const files: TwinThumbnails['files'] = [];
      for (const file of sources) {
        const format = extname(file.path).slice(1) as ImagePathOptions['format'];
        const path = StorageCore.getImagePath(asset, { fileType: file.type, format, isEdited: false });
        await linkFile(repos, file.path, path, StorageFolder.Thumbnails);
        files.push({
          assetId: asset.id,
          type: file.type,
          path,
          isEdited: false,
          isProgressive: file.isProgressive,
          isTransparent: file.isTransparent,
        });
      }

      return { files, thumbhash: twin.thumbhash };
    },
  });

/** H2: a video transcode, linked from a twin. Returns this asset's path to the linked file. */
export const reuseTwinEncodedVideo = (
  repos: BaseRepos,
  asset: ThumbnailPathEntity & { originalPath: string },
  job: TwinJob,
) =>
  resolveFromTwins<string>(repos, asset.id, job, TWIN_WAIT.long, {
    selfHasData: (self) => !!getFile(self, AssetFileType.EncodedVideo),
    twinHasData: (twin) => !!getFile(twin, AssetFileType.EncodedVideo),
    reuse: async (_self, twin) => {
      const source = getFile(twin, AssetFileType.EncodedVideo)!;
      if (!(await areFresh(repos, asset.originalPath, [source.path]))) {
        return;
      }

      const path = StorageCore.getEncodedVideoPath(asset);
      await linkFile(repos, source.path, path, StorageFolder.EncodedVideo);
      return path;
    },
  });

/** H3: a twin's CLIP embedding. */
export const twinEmbedding = (repos: BaseRepos, id: string, job: TwinJob) =>
  resolveFromTwins<string>(repos, id, job, TWIN_WAIT.short, {
    selfHasData: (self) => !!self.hasEmbedding,
    twinHasData: (twin) => !!twin.hasEmbedding,
    reuse: async (self, twin) => {
      if (!(await isSamePreview(repos, self, twin))) {
        return;
      }
      const row = await repos.assetJobRepository.getTwinEmbedding(twin.id);
      return row?.embedding;
    },
  });

/** H4: a twin's OCR results, in the machine-learning response's shape. */
export const twinOcr = (repos: BaseRepos & { ocrRepository: OcrRepository }, id: string, job: TwinJob) =>
  resolveFromTwins<OCR>(repos, id, job, TWIN_WAIT.short, {
    selfHasData: (self) => !!self.ocrAt,
    twinHasData: (twin) => !!twin.ocrAt,
    reuse: async (self, twin) => {
      if (!(await isSamePreview(repos, self, twin))) {
        return;
      }
      const rows = await repos.ocrRepository.getByAssetId(twin.id, {});
      return {
        text: rows.map((row) => row.text),
        box: rows.flatMap((row) => [row.x1, row.y1, row.x2, row.y2, row.x3, row.y3, row.x4, row.y4]),
        boxScore: rows.map((row) => row.boxScore),
        textScore: rows.map((row) => row.textScore),
      };
    },
  });

export type TwinDetectedFaces = { imageWidth: number; imageHeight: number; faces: Face[] };

/** H5: a twin's detected faces, in the machine-learning response's shape. */
export const twinFaces = (repos: BaseRepos, id: string, job: TwinJob) =>
  resolveFromTwins<TwinDetectedFaces>(repos, id, job, TWIN_WAIT.short, {
    selfHasData: (self) => !!self.facesRecognizedAt,
    twinHasData: (twin) => !!twin.facesRecognizedAt,
    reuse: async (self, twin) => {
      if (!(await isSamePreview(repos, self, twin))) {
        return;
      }
      const faces = await repos.assetJobRepository.getTwinDetectedFaces(twin.id);
      return {
        imageWidth: faces[0]?.imageWidth ?? 1,
        imageHeight: faces[0]?.imageHeight ?? 1,
        faces: faces.map((face) => ({
          boundingBox: {
            x1: face.boundingBoxX1,
            y1: face.boundingBoxY1,
            x2: face.boundingBoxX2,
            y2: face.boundingBoxY2,
          },
          embedding: face.embedding,
          score: 1,
        })),
      };
    },
  });

type FaceBox = {
  imageWidth: number;
  imageHeight: number;
  boundingBoxX1: number;
  boundingBoxY1: number;
  boundingBoxX2: number;
  boundingBoxY2: number;
};

const normalize = (face: FaceBox) => ({
  x1: face.boundingBoxX1 / (face.imageWidth || 1),
  y1: face.boundingBoxY1 / (face.imageHeight || 1),
  x2: face.boundingBoxX2 / (face.imageWidth || 1),
  y2: face.boundingBoxY2 / (face.imageHeight || 1),
});

export const faceIou = (a: FaceBox, b: FaceBox) => {
  const boxA = normalize(a);
  const boxB = normalize(b);
  const intersection =
    Math.max(0, Math.min(boxA.x2, boxB.x2) - Math.max(boxA.x1, boxB.x1)) *
    Math.max(0, Math.min(boxA.y2, boxB.y2) - Math.max(boxA.y1, boxB.y1));
  const area = (box: typeof boxA) => (box.x2 - box.x1) * (box.y2 - box.y1);
  const union = area(boxA) + area(boxB) - intersection;
  return union > 0 ? intersection / union : 0;
};

const findMatch = <F extends FaceBox>(face: FaceBox, candidates: F[]): F | undefined => {
  let best: F | undefined;
  let bestIou = TWIN_FACE_MATCH_IOU;
  for (const candidate of candidates) {
    const iou = faceIou(face, candidate);
    if (iou < bestIou) {
      continue;
    }
    best = candidate;
    bestIou = iou;
  }
  return best;
};

interface FaceRepos {
  assetJobRepository: AssetJobRepository;
  personRepository: PersonRepository;
  jobRepository: JobRepository;
  logger: LoggingRepository;
}

/** The twin's owner needs its own person row for a group before one of its faces can show under it. */
const ensurePerson = async (repos: FaceRepos, ownerId: string, personGroupId: string, faceId: string) => {
  const person = await repos.personRepository.getByGroupId({ ownerId, personGroupId });
  if (person) {
    return;
  }

  await repos.personRepository.create({ ownerId, personGroupId, faceAssetId: faceId });
  await repos.jobRepository.queue({ name: JobName.PersonGenerateThumbnail, data: { ownerId, personGroupId } });
};

/**
H5 (pull) and H6 (push): makes the faces of `sourceId`'s twins follow its faces. Matched faces take the source's
person group, and the source's manual faces are added where a twin has no matching face. Only between owners in the
same cluster group, since person groups belong to one. Returns the twins' people whose feature face was moved away,
so the caller can pick new feature photos.
*/
export const mirrorFaces = async (repos: FaceRepos, sourceId: string, onlyTargetId?: string): Promise<PersonId[]> => {
  const moved: PersonId[] = [];
  if (!isDerivedDataSharingEnabled()) {
    return moved;
  }

  try {
    const { self, others } = await loadGroup(repos, sourceId);
    const targets = others.filter(
      (other) => other.clusterGroupId === self?.clusterGroupId && (!onlyTargetId || other.id === onlyTargetId),
    );
    if (!self || targets.length === 0) {
      return moved;
    }

    const sourceFaces = await repos.assetJobRepository.getTwinFaces(sourceId);
    for (const target of targets) {
      const targetFaces = await repos.assetJobRepository.getTwinFaces(target.id);
      for (const face of sourceFaces) {
        if (!face.personGroupId) {
          continue;
        }

        const match = findMatch(face, targetFaces);
        if (match) {
          if (match.personGroupId === face.personGroupId) {
            continue;
          }

          await ensurePerson(repos, target.ownerId, face.personGroupId, match.id);
          await repos.personRepository.reassignFace(match.id, face.personGroupId);
          if (match.personGroupId && match.faceAssetId === match.id) {
            moved.push({ ownerId: target.ownerId, personGroupId: match.personGroupId });
          }
          match.personGroupId = face.personGroupId;
        } else if (face.sourceType === SourceType.Manual) {
          const id = randomUUID();
          await repos.personRepository.createAssetFace({
            id,
            assetId: target.id,
            personGroupId: face.personGroupId,
            imageWidth: face.imageWidth,
            imageHeight: face.imageHeight,
            boundingBoxX1: face.boundingBoxX1,
            boundingBoxY1: face.boundingBoxY1,
            boundingBoxX2: face.boundingBoxX2,
            boundingBoxY2: face.boundingBoxY2,
            sourceType: SourceType.Manual,
          });
          await ensurePerson(repos, target.ownerId, face.personGroupId, id);
        }
      }
    }
  } catch (error: Error | any) {
    repos.logger.warn(`Could not mirror face edits from asset ${sourceId} to its twins: ${error?.message ?? error}`);
  }

  return moved;
};

/** H6: deletes the matching face on each twin, the same way (soft or hard) the source face was deleted. */
export const mirrorFaceDeletion = async (
  repos: FaceRepos,
  face: (FaceBox & { id: string; assetId: string }) | undefined,
  force: boolean,
) => {
  if (!isDerivedDataSharingEnabled() || !face) {
    return;
  }

  try {
    const { self, others } = await loadGroup(repos, face.assetId);
    const targets = others.filter((other) => other.clusterGroupId === self?.clusterGroupId);
    for (const target of targets) {
      const match = findMatch(face, await repos.assetJobRepository.getTwinFaces(target.id));
      if (!match) {
        continue;
      }

      await (force
        ? repos.personRepository.deleteAssetFace(match.id)
        : repos.personRepository.softDeleteAssetFaces(match.id));
    }
  } catch (error: Error | any) {
    repos.logger.warn(`Could not mirror the deletion of face ${face.id} to twins: ${error?.message ?? error}`);
  }
};
