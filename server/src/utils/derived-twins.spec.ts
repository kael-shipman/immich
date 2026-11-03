// fork: derived-twins. Unit tests for the rules and hooks' helpers (fork/IMPLEMENTATION.md, sections 3 and 5).
import { linkSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { vitest } from 'vitest';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetFileType, ImageFormat, JobName, SourceType, StorageFolder } from 'src/enum.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import {
  TWIN_WAIT,
  faceIou,
  mirrorFaceDeletion,
  mirrorFaces,
  reuseTwinEncodedVideo,
  reuseTwinThumbnails,
  twinEmbedding,
  twinFaces,
  twinOcr,
} from 'src/utils/derived-twins.js';

const OWNER_A = 'owner-a';
const OWNER_B = 'owner-b';
// R6's leader is the lowest ID: 'asset-1' leads 'asset-2'.
const LEADER = 'asset-1';
const FOLLOWER = 'asset-2';

const image = {
  thumbnail: { format: ImageFormat.Webp },
  preview: { format: ImageFormat.Jpeg },
} as any;

type Row = {
  id: string;
  ownerId: string;
  originalPath: string;
  isEdited: boolean;
  thumbhash: Buffer | null;
  clusterGroupId: string;
  ocrAt: Date | null;
  facesRecognizedAt: Date | null;
  files: { type: AssetFileType; path: string; isProgressive: boolean; isTransparent: boolean }[];
  hasEmbedding: boolean;
};

let root: string;
let originalPath: string;

const row = (dto: Partial<Row> & { id: string; ownerId: string }): Row => ({
  originalPath,
  isEdited: false,
  thumbhash: null,
  clusterGroupId: 'cluster',
  ocrAt: null,
  facesRecognizedAt: null,
  files: [],
  hasEmbedding: false,
  ...dto,
});

const writeFile = (path: string, content = 'x') => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
};

const thumbPath = (owner: string, id: string, type: AssetFileType, format: string) =>
  StorageCore.getImagePath({ id, ownerId: owner }, { fileType: type, format: format as ImageFormat, isEdited: false });

/** The leader's (A's) derived files, made on disk after the original. */
const leaderWithThumbnails = (dto: Partial<Row> = {}) => {
  const preview = writeFile(thumbPath(OWNER_A, LEADER, AssetFileType.Preview, 'jpeg'), 'preview');
  const thumbnail = writeFile(thumbPath(OWNER_A, LEADER, AssetFileType.Thumbnail, 'webp'), 'thumbnail');
  return row({
    id: LEADER,
    ownerId: OWNER_A,
    thumbhash: Buffer.from('hash'),
    files: [
      { type: AssetFileType.Preview, path: preview, isProgressive: false, isTransparent: false },
      { type: AssetFileType.Thumbnail, path: thumbnail, isProgressive: false, isTransparent: true },
    ],
    ...dto,
  });
};

const setup = (rows: Row[]) => {
  const logger = { debug: vitest.fn(), warn: vitest.fn(), setContext: vitest.fn() };
  const repos = {
    assetJobRepository: {
      getTwinGroup: vitest.fn().mockResolvedValue(rows),
      getTwinEmbedding: vitest.fn(),
      getTwinDetectedFaces: vitest.fn(),
      getTwinFaces: vitest.fn(),
    },
    jobRepository: { queue: vitest.fn() },
    storageRepository: new StorageRepository(logger as any),
    ocrRepository: { getByAssetId: vitest.fn() },
    personRepository: {
      getByGroupId: vitest.fn(),
      create: vitest.fn(),
      reassignFace: vitest.fn(),
      createAssetFace: vitest.fn(),
      deleteAssetFace: vitest.fn(),
      softDeleteAssetFaces: vitest.fn(),
    },
    logger,
  };
  return repos as any;
};

/** A leader with ML results, and a follower whose preview is (or isn't) a link to the leader's. */
const withPreviews = (linked: boolean, leaderDto: Partial<Row> = {}) => {
  const leader = leaderWithThumbnails(leaderDto);
  const followerPreview = thumbPath(OWNER_B, FOLLOWER, AssetFileType.Preview, 'jpeg');
  mkdirSync(dirname(followerPreview), { recursive: true });
  if (linked) {
    linkSync(leader.files[0].path, followerPreview);
  } else {
    writeFileSync(followerPreview, 'preview');
  }
  const follower = row({
    id: FOLLOWER,
    ownerId: OWNER_B,
    files: [{ type: AssetFileType.Preview, path: followerPreview, isProgressive: false, isTransparent: false }],
  });
  return setup([leader, follower]);
};

const job = (name: any, data: Record<string, unknown> = {}) => ({ name, data: { id: FOLLOWER, ...data } });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'derived-twins-'));
  StorageCore.setMediaLocation(join(root, 'data'));
  originalPath = writeFile(join(root, 'library', 'photo.jpg'), 'original');
  const past = new Date(Date.now() - 60_000);
  utimesSync(originalPath, past, past);
  process.env.IMMICH_SHARE_DERIVED_DATA = 'true';
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.IMMICH_SHARE_DERIVED_DATA;
});

describe('derived-twins', () => {
  describe('switch', () => {
    it('does nothing when IMMICH_SHARE_DERIVED_DATA is off', async () => {
      delete process.env.IMMICH_SHARE_DERIVED_DATA;
      const repos = setup([]);
      const asset = { id: FOLLOWER, ownerId: OWNER_B, originalPath };

      await expect(reuseTwinThumbnails(repos, asset, image, job(JobName.AssetGenerateThumbnails))).resolves.toEqual({
        action: 'work',
      });
      await expect(mirrorFaces(repos, FOLLOWER)).resolves.toEqual([]);
      expect(repos.assetJobRepository.getTwinGroup).not.toHaveBeenCalled();
    });
  });

  describe('thumbnails (H1)', () => {
    it('links a twin’s files to this asset’s own paths (R3)', async () => {
      const leader = leaderWithThumbnails();
      const repos = setup([leader, row({ id: FOLLOWER, ownerId: OWNER_B })]);
      const asset = { id: FOLLOWER, ownerId: OWNER_B, originalPath };

      const result = await reuseTwinThumbnails(repos, asset, image, job(JobName.AssetGenerateThumbnails));

      expect(result).toMatchObject({ action: 'reuse', twinId: LEADER });
      const value = (result as any).value;
      expect(value.thumbhash).toEqual(Buffer.from('hash'));
      expect(value.files).toEqual([
        expect.objectContaining({
          assetId: FOLLOWER,
          type: AssetFileType.Preview,
          path: thumbPath(OWNER_B, FOLLOWER, AssetFileType.Preview, 'jpeg'),
        }),
        expect.objectContaining({
          assetId: FOLLOWER,
          type: AssetFileType.Thumbnail,
          path: thumbPath(OWNER_B, FOLLOWER, AssetFileType.Thumbnail, 'webp'),
          isTransparent: true,
        }),
      ]);
      for (const [index, file] of value.files.entries()) {
        const linked = statSync(file.path);
        expect(linked.ino).toBe(statSync(leader.files[index].path).ino);
        expect(linked.nlink).toBe(2);
      }
    });

    it('does the work itself when it already has thumbnails (R1)', async () => {
      const repos = setup([
        leaderWithThumbnails(),
        row({
          id: FOLLOWER,
          ownerId: OWNER_B,
          files: [{ type: AssetFileType.Preview, path: 'p', isProgressive: false, isTransparent: false }],
        }),
      ]);
      const asset = { id: FOLLOWER, ownerId: OWNER_B, originalPath };

      await expect(reuseTwinThumbnails(repos, asset, image, job(JobName.AssetGenerateThumbnails))).resolves.toEqual({
        action: 'work',
      });
    });

    it('does the work itself when it is edited (R1)', async () => {
      const repos = setup([leaderWithThumbnails(), row({ id: FOLLOWER, ownerId: OWNER_B, isEdited: true })]);
      const asset = { id: FOLLOWER, ownerId: OWNER_B, originalPath };

      await expect(reuseTwinThumbnails(repos, asset, image, job(JobName.AssetGenerateThumbnails))).resolves.toEqual({
        action: 'work',
      });
    });

    it('does not reuse files older than the original (R2)', async () => {
      const leader = leaderWithThumbnails();
      const older = new Date(Date.now() - 120_000);
      utimesSync(leader.files[0].path, older, older);
      const repos = setup([leader, row({ id: FOLLOWER, ownerId: OWNER_B })]);
      const asset = { id: FOLLOWER, ownerId: OWNER_B, originalPath };

      await expect(reuseTwinThumbnails(repos, asset, image, job(JobName.AssetGenerateThumbnails))).resolves.toEqual({
        action: 'work',
      });
      expect(repos.jobRepository.queue).not.toHaveBeenCalled();
    });

    it('does not reuse files in another format than configured (R3)', async () => {
      const repos = setup([leaderWithThumbnails(), row({ id: FOLLOWER, ownerId: OWNER_B })]);
      const asset = { id: FOLLOWER, ownerId: OWNER_B, originalPath };
      const webpPreview = { ...image, preview: { format: ImageFormat.Webp } };

      await expect(
        reuseTwinThumbnails(repos, asset, webpPreview, job(JobName.AssetGenerateThumbnails)),
      ).resolves.toEqual({ action: 'work' });
    });

    it('refuses to link anything outside the thumbnails folder, and falls back (R5)', async () => {
      const outside = writeFile(join(root, 'library', 'not-a-thumbnail.jpeg'));
      const leader = leaderWithThumbnails();
      leader.files[0].path = outside;
      const repos = setup([leader, row({ id: FOLLOWER, ownerId: OWNER_B })]);
      const asset = { id: FOLLOWER, ownerId: OWNER_B, originalPath };

      await expect(reuseTwinThumbnails(repos, asset, image, job(JobName.AssetGenerateThumbnails))).resolves.toEqual({
        action: 'work',
      });
      expect(statSync(outside).nlink).toBe(1);
      expect(statSync(originalPath).nlink).toBe(1);
    });
  });

  describe('waiting for the leader (R6)', () => {
    it('re-queues itself with a delay when the leader has no thumbnails yet', async () => {
      const repos = setup([row({ id: LEADER, ownerId: OWNER_A }), row({ id: FOLLOWER, ownerId: OWNER_B })]);
      const asset = { id: FOLLOWER, ownerId: OWNER_B, originalPath };

      await expect(
        reuseTwinThumbnails(repos, asset, image, job(JobName.AssetGenerateThumbnails, { source: 'upload' })),
      ).resolves.toEqual({ action: 'wait' });
      expect(repos.jobRepository.queue).toHaveBeenCalledWith({
        name: JobName.AssetGenerateThumbnails,
        data: { id: FOLLOWER, source: 'upload', twinWaits: 1, delay: TWIN_WAIT.short.delay },
      });
    });

    it('does the work itself when it is the leader', async () => {
      const repos = setup([row({ id: LEADER, ownerId: OWNER_A }), row({ id: FOLLOWER, ownerId: OWNER_B })]);
      const asset = { id: LEADER, ownerId: OWNER_A, originalPath };

      await expect(
        reuseTwinThumbnails(repos, asset, image, { name: JobName.AssetGenerateThumbnails, data: { id: LEADER } }),
      ).resolves.toEqual({ action: 'work' });
      expect(repos.jobRepository.queue).not.toHaveBeenCalled();
    });

    it('clears its wait fields when it proceeds, so follow-up jobs start fresh', async () => {
      const repos = setup([row({ id: LEADER, ownerId: OWNER_A }), row({ id: FOLLOWER, ownerId: OWNER_B })]);
      const asset = { id: FOLLOWER, ownerId: OWNER_B, originalPath };
      const waits = TWIN_WAIT.short.budget / TWIN_WAIT.short.delay;
      const data = { id: FOLLOWER, source: 'upload', twinWaits: waits, delay: TWIN_WAIT.short.delay };

      await reuseTwinThumbnails(repos, asset, image, { name: JobName.AssetGenerateThumbnails, data } as any);

      expect(data).toEqual({ id: FOLLOWER, source: 'upload' });
    });

    it('does the work itself once the wait budget is spent', async () => {
      const repos = setup([row({ id: LEADER, ownerId: OWNER_A }), row({ id: FOLLOWER, ownerId: OWNER_B })]);
      const asset = { id: FOLLOWER, ownerId: OWNER_B, originalPath };
      const waits = TWIN_WAIT.short.budget / TWIN_WAIT.short.delay;

      await expect(
        reuseTwinThumbnails(repos, asset, image, job(JobName.AssetGenerateThumbnails, { twinWaits: waits })),
      ).resolves.toEqual({ action: 'work' });
      expect(repos.jobRepository.queue).not.toHaveBeenCalled();
    });

    it('does the work itself when it has no twins', async () => {
      const repos = setup([row({ id: FOLLOWER, ownerId: OWNER_B })]);
      const asset = { id: FOLLOWER, ownerId: OWNER_B, originalPath };

      await expect(reuseTwinThumbnails(repos, asset, image, job(JobName.AssetGenerateThumbnails))).resolves.toEqual({
        action: 'work',
      });
    });

    it('falls back to the work when finding twins fails (R5)', async () => {
      const repos = setup([]);
      repos.assetJobRepository.getTwinGroup.mockRejectedValue(new Error('database down'));
      const asset = { id: FOLLOWER, ownerId: OWNER_B, originalPath };

      await expect(reuseTwinThumbnails(repos, asset, image, job(JobName.AssetGenerateThumbnails))).resolves.toEqual({
        action: 'work',
      });
    });
  });

  describe('transcode (H2)', () => {
    it('links the twin’s encoded video', async () => {
      const video = writeFile(StorageCore.getEncodedVideoPath({ id: LEADER, ownerId: OWNER_A }), 'video');
      const repos = setup([
        row({
          id: LEADER,
          ownerId: OWNER_A,
          files: [{ type: AssetFileType.EncodedVideo, path: video, isProgressive: false, isTransparent: false }],
        }),
        row({ id: FOLLOWER, ownerId: OWNER_B }),
      ]);
      const asset = { id: FOLLOWER, ownerId: OWNER_B, originalPath };

      const result = await reuseTwinEncodedVideo(repos, asset, job(JobName.AssetEncodeVideo));

      const path = StorageCore.getEncodedVideoPath(asset);
      expect(result).toEqual({ action: 'reuse', value: path, twinId: LEADER });
      expect(path.startsWith(StorageCore.getBaseFolder(StorageFolder.EncodedVideo))).toBe(true);
      expect(statSync(path).ino).toBe(statSync(video).ino);
    });

    it('waits longer for a transcode', async () => {
      const repos = setup([row({ id: LEADER, ownerId: OWNER_A }), row({ id: FOLLOWER, ownerId: OWNER_B })]);
      const asset = { id: FOLLOWER, ownerId: OWNER_B, originalPath };

      await expect(reuseTwinEncodedVideo(repos, asset, job(JobName.AssetEncodeVideo))).resolves.toEqual({
        action: 'wait',
      });
      expect(repos.jobRepository.queue).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ delay: TWIN_WAIT.long.delay }) }),
      );
    });
  });

  describe('machine learning (H3–H5)', () => {
    it('copies the embedding when the previews are the same file', async () => {
      const repos = withPreviews(true, { hasEmbedding: true });
      repos.assetJobRepository.getTwinEmbedding.mockResolvedValue({ embedding: '[1,2,3]' });

      await expect(twinEmbedding(repos, FOLLOWER, job(JobName.SmartSearch))).resolves.toEqual({
        action: 'reuse',
        value: '[1,2,3]',
        twinId: LEADER,
      });
    });

    it('computes its own embedding when the previews are different files (R2), without waiting', async () => {
      const repos = withPreviews(false, { hasEmbedding: true });

      await expect(twinEmbedding(repos, FOLLOWER, job(JobName.SmartSearch))).resolves.toEqual({ action: 'work' });
      expect(repos.jobRepository.queue).not.toHaveBeenCalled();
    });

    it('rebuilds OCR results in the machine-learning shape', async () => {
      const repos = withPreviews(true, { ocrAt: new Date() });
      repos.ocrRepository.getByAssetId.mockResolvedValue([
        { text: 'Hello', x1: 1, y1: 2, x2: 3, y2: 4, x3: 5, y3: 6, x4: 7, y4: 8, boxScore: 0.9, textScore: 0.8 },
      ]);

      await expect(twinOcr(repos, FOLLOWER, job(JobName.Ocr))).resolves.toEqual({
        action: 'reuse',
        twinId: LEADER,
        value: { text: ['Hello'], box: [1, 2, 3, 4, 5, 6, 7, 8], boxScore: [0.9], textScore: [0.8] },
      });
      expect(repos.ocrRepository.getByAssetId).toHaveBeenCalledWith(LEADER, {});
    });

    it('copies detected faces in the machine-learning shape', async () => {
      const repos = withPreviews(true, { facesRecognizedAt: new Date() });
      repos.assetJobRepository.getTwinDetectedFaces.mockResolvedValue([
        {
          imageWidth: 100,
          imageHeight: 50,
          boundingBoxX1: 10,
          boundingBoxY1: 5,
          boundingBoxX2: 30,
          boundingBoxY2: 25,
          embedding: '[0.1]',
        },
      ]);

      await expect(twinFaces(repos, FOLLOWER, job(JobName.AssetDetectFaces))).resolves.toEqual({
        action: 'reuse',
        twinId: LEADER,
        value: {
          imageWidth: 100,
          imageHeight: 50,
          faces: [{ boundingBox: { x1: 10, y1: 5, x2: 30, y2: 25 }, embedding: '[0.1]', score: 1 }],
        },
      });
    });

    it('does its own face detection once it has run before (R1)', async () => {
      const repos = setup([
        leaderWithThumbnails({ facesRecognizedAt: new Date() }),
        row({ id: FOLLOWER, ownerId: OWNER_B, facesRecognizedAt: new Date() }),
      ]);

      await expect(twinFaces(repos, FOLLOWER, job(JobName.AssetDetectFaces))).resolves.toEqual({ action: 'work' });
    });
  });

  describe('face edits (H6)', () => {
    const box = {
      imageWidth: 100,
      imageHeight: 100,
      boundingBoxX1: 10,
      boundingBoxY1: 10,
      boundingBoxX2: 50,
      boundingBoxY2: 50,
    };

    it('measures overlap on normalized boxes', () => {
      expect(faceIou(box, box)).toBe(1);
      // The same face on a preview twice the size
      expect(
        faceIou(box, {
          imageWidth: 200,
          imageHeight: 200,
          boundingBoxX1: 20,
          boundingBoxY1: 20,
          boundingBoxX2: 100,
          boundingBoxY2: 100,
        }),
      ).toBe(1);
      // Shifted by a quarter of its width: 30x40 of 40x40 overlap, so 1200 / (1600 + 1600 - 1200)
      expect(faceIou(box, { ...box, boundingBoxX1: 20, boundingBoxX2: 60 })).toBeCloseTo(0.6);
      expect(faceIou(box, { ...box, boundingBoxX1: 60, boundingBoxX2: 90 })).toBe(0);
    });

    it('moves the matching face on a twin to the same person, and reports its old feature face', async () => {
      const repos = setup([row({ id: LEADER, ownerId: OWNER_A }), row({ id: FOLLOWER, ownerId: OWNER_B })]);
      repos.assetJobRepository.getTwinFaces.mockImplementation((id: string) =>
        Promise.resolve(
          id === LEADER
            ? [{ ...box, id: 'face-a', personGroupId: 'group-right', sourceType: SourceType.MachineLearning }]
            : [
                {
                  ...box,
                  id: 'face-b',
                  personGroupId: 'group-wrong',
                  sourceType: SourceType.MachineLearning,
                  faceAssetId: 'face-b',
                },
              ],
        ),
      );
      repos.personRepository.getByGroupId.mockResolvedValue(undefined);

      await expect(mirrorFaces(repos, LEADER)).resolves.toEqual([{ ownerId: OWNER_B, personGroupId: 'group-wrong' }]);
      expect(repos.personRepository.create).toHaveBeenCalledWith({
        ownerId: OWNER_B,
        personGroupId: 'group-right',
        faceAssetId: 'face-b',
      });
      expect(repos.jobRepository.queue).toHaveBeenCalledWith({
        name: JobName.PersonGenerateThumbnail,
        data: { ownerId: OWNER_B, personGroupId: 'group-right' },
      });
      expect(repos.personRepository.reassignFace).toHaveBeenCalledWith('face-b', 'group-right');
    });

    it('adds a manual face to a twin that has no matching face', async () => {
      const repos = setup([row({ id: LEADER, ownerId: OWNER_A }), row({ id: FOLLOWER, ownerId: OWNER_B })]);
      repos.assetJobRepository.getTwinFaces.mockImplementation((id: string) =>
        Promise.resolve(
          id === LEADER ? [{ ...box, id: 'face-a', personGroupId: 'group', sourceType: SourceType.Manual }] : [],
        ),
      );
      repos.personRepository.getByGroupId.mockResolvedValue({ personGroupId: 'group' });

      await mirrorFaces(repos, LEADER);

      expect(repos.personRepository.createAssetFace).toHaveBeenCalledWith(
        expect.objectContaining({ assetId: FOLLOWER, personGroupId: 'group', sourceType: SourceType.Manual, ...box }),
      );
      expect(repos.personRepository.create).not.toHaveBeenCalled();
    });

    it('does not mirror between owners in different cluster groups', async () => {
      const repos = setup([
        row({ id: LEADER, ownerId: OWNER_A, clusterGroupId: 'one' }),
        row({ id: FOLLOWER, ownerId: OWNER_B, clusterGroupId: 'two' }),
      ]);

      await expect(mirrorFaces(repos, LEADER)).resolves.toEqual([]);
      expect(repos.assetJobRepository.getTwinFaces).not.toHaveBeenCalled();
    });

    it('deletes the matching face on a twin the same way', async () => {
      const repos = setup([row({ id: LEADER, ownerId: OWNER_A }), row({ id: FOLLOWER, ownerId: OWNER_B })]);
      repos.assetJobRepository.getTwinFaces.mockResolvedValue([{ ...box, id: 'face-b' }]);

      await mirrorFaceDeletion(repos, { ...box, id: 'face-a', assetId: LEADER }, false);
      expect(repos.personRepository.softDeleteAssetFaces).toHaveBeenCalledWith('face-b');

      await mirrorFaceDeletion(repos, { ...box, id: 'face-a', assetId: LEADER }, true);
      expect(repos.personRepository.deleteAssetFace).toHaveBeenCalledWith('face-b');
    });
  });
});
