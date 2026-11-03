// fork: derived-twins. Medium tests: the twin queries and the hooks against a real database and file system
// (fork/IMPLEMENTATION.md, section 5).
import { Kysely } from 'kysely';
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetFileType, JobName, JobStatus, SourceType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { OcrRepository } from 'src/repositories/ocr.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { OcrService } from 'src/services/ocr.service.js';
import { PersonService } from 'src/services/person.service.js';
import { SmartInfoService } from 'src/services/smart-info.service.js';
import { mediumFactory, newMediumService } from 'test/medium.factory.js';
import { factory, newEmbedding } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;
let root: string;

const realRepositories = [
  AccessRepository,
  AssetRepository,
  AssetJobRepository,
  ConfigRepository,
  CryptoRepository,
  OcrRepository,
  PersonRepository,
  SearchRepository,
  StorageRepository,
  SystemMetadataRepository,
];

const setup = <S>(Service: S) => {
  const result = newMediumService(Service as any, {
    database: defaultDatabase,
    real: realRepositories,
    mock: [DatabaseRepository, JobRepository, LoggingRepository, MachineLearningRepository],
  }) as any;
  const job = result.ctx.getMock(JobRepository);
  job.queue.mockResolvedValue();
  job.queueAll.mockResolvedValue();
  result.ctx.getMock(DatabaseRepository).isBusy.mockReturnValue(false);
  return result;
};

const newLibrary = (ctx: any, ownerId: string) =>
  ctx.database
    .insertInto('library')
    .values({ name: 'library', ownerId, importPaths: ['/library'], exclusionPatterns: [] })
    .returningAll()
    .executeTakeFirstOrThrow();

/**
 * Two users in one cluster group, each with a library asset for the same file. The first ("leader", lower ID) has a
 * preview on disk; the second's preview is a hard link to it, as the thumbnail hook (H1) leaves it.
 */
const newTwins = async (ctx: any) => {
  const { user: userA } = await ctx.newUser();
  const { user: userB } = await ctx.newUser({ clusterGroupId: userA.clusterGroupId });
  const [libraryA, libraryB] = [await newLibrary(ctx, userA.id), await newLibrary(ctx, userB.id)];
  const originalPath = `/library/${crypto.randomUUID()}/photo.jpg`;
  const fileModifiedAt = new Date('2026-01-01T00:00:00Z');
  const ids = [crypto.randomUUID(), crypto.randomUUID()].sort();
  const { asset: leader } = await ctx.newAsset({
    id: ids[0],
    ownerId: userA.id,
    libraryId: libraryA.id,
    originalPath,
    fileModifiedAt,
  });
  const { asset: follower } = await ctx.newAsset({
    id: ids[1],
    ownerId: userB.id,
    libraryId: libraryB.id,
    originalPath,
    fileModifiedAt,
  });

  const leaderPreview = join(root, `${leader.id}_preview.jpeg`);
  const followerPreview = join(root, `${follower.id}_preview.jpeg`);
  writeFileSync(leaderPreview, 'preview');
  linkSync(leaderPreview, followerPreview);
  await ctx.newAssetFile({ assetId: leader.id, type: AssetFileType.Preview, path: leaderPreview });
  await ctx.newAssetFile({ assetId: follower.id, type: AssetFileType.Preview, path: followerPreview });

  return { userA, userB, leader, follower, originalPath, fileModifiedAt };
};

/** The OCR fields that must match between twins. */
const strip = (rows: any[]) =>
  rows.map(({ text, x1, y4, boxScore, textScore }) => ({ text, x1, y4, boxScore, textScore }));

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'derived-twins-medium-'));
  mkdirSync(root, { recursive: true });
  process.env.IMMICH_SHARE_DERIVED_DATA = 'true';
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.IMMICH_SHARE_DERIVED_DATA;
});

describe('derived-twins', () => {
  describe(AssetJobRepository.prototype.getTwinGroup.name, () => {
    it('finds live library assets of the same file, and nothing else', async () => {
      const { ctx } = setup(OcrService);
      const { userA, userB, leader, follower, originalPath, fileModifiedAt } = await newTwins(ctx);
      const library = await newLibrary(ctx, userB.id);
      // Not twins: another version of the file, deleted, offline, and an upload (no library)
      await ctx.newAsset({ ownerId: userB.id, libraryId: library.id, originalPath, fileModifiedAt: new Date() });
      await ctx.newAsset({
        ownerId: userB.id,
        libraryId: library.id,
        originalPath,
        fileModifiedAt,
        deletedAt: new Date(),
      });
      await ctx.newAsset({ ownerId: userB.id, libraryId: library.id, originalPath, fileModifiedAt, isOffline: true });
      await ctx.newAsset({ ownerId: userA.id, originalPath, fileModifiedAt });

      const group = await ctx.get(AssetJobRepository).getTwinGroup(follower.id);

      expect(group.map((row: any) => row.id)).toEqual([leader.id, follower.id]);
      expect(group[0]).toMatchObject({
        ownerId: userA.id,
        clusterGroupId: userA.clusterGroupId,
        isEdited: false,
        hasEmbedding: false,
        files: [expect.objectContaining({ type: AssetFileType.Preview })],
      });
    });
  });

  describe('smart search (H3)', () => {
    it('copies the leader’s embedding instead of calling machine learning', async () => {
      const { sut, ctx } = setup(SmartInfoService);
      const { leader, follower } = await newTwins(ctx);
      const embedding = newEmbedding();
      await ctx.get(SearchRepository).upsert(leader.id, embedding);
      const machineLearning = ctx.getMock(MachineLearningRepository);

      await expect(sut.handleEncodeClip({ id: follower.id })).resolves.toBe(JobStatus.Success);

      expect(machineLearning.encodeImage).not.toHaveBeenCalled();
      const copied = await ctx.get(AssetJobRepository).getTwinEmbedding(follower.id);
      const original = await ctx.get(AssetJobRepository).getTwinEmbedding(leader.id);
      expect(copied?.embedding).toEqual(original?.embedding);
    });

    it('waits for the leader, without queuing follow-up work, when it has no embedding yet (R6)', async () => {
      const { sut, ctx } = setup(SmartInfoService);
      const { follower } = await newTwins(ctx);
      const machineLearning = ctx.getMock(MachineLearningRepository);
      const job = ctx.getMock(JobRepository);

      await expect(sut.handleEncodeClip({ id: follower.id })).resolves.toBe(JobStatus.Failed);

      expect(machineLearning.encodeImage).not.toHaveBeenCalled();
      expect(job.queue).toHaveBeenCalledWith({
        name: JobName.SmartSearch,
        data: { id: follower.id, twinWaits: 1, delay: 30_000 },
      });
    });

    it('behaves as upstream when the switch is off', async () => {
      delete process.env.IMMICH_SHARE_DERIVED_DATA;
      const { sut, ctx } = setup(SmartInfoService);
      const { follower } = await newTwins(ctx);
      const machineLearning = ctx.getMock(MachineLearningRepository);
      machineLearning.encodeImage.mockResolvedValue(newEmbedding());

      await expect(sut.handleEncodeClip({ id: follower.id })).resolves.toBe(JobStatus.Success);
      expect(machineLearning.encodeImage).toHaveBeenCalled();
    });
  });

  describe('OCR (H4)', () => {
    it('copies the leader’s OCR results instead of calling machine learning', async () => {
      const { sut, ctx } = setup(OcrService);
      const { leader, follower } = await newTwins(ctx);
      const machineLearning = ctx.getMock(MachineLearningRepository);
      machineLearning.ocr.mockResolvedValue({
        box: [10, 10, 50, 10, 50, 50, 10, 50],
        boxScore: [0.99],
        text: ['Test OCR'],
        textScore: [0.95],
      });
      await expect(sut.handleOcr({ id: leader.id })).resolves.toBe(JobStatus.Success);
      machineLearning.ocr.mockClear();

      await expect(sut.handleOcr({ id: follower.id })).resolves.toBe(JobStatus.Success);

      expect(machineLearning.ocr).not.toHaveBeenCalled();
      expect(strip(await ctx.get(OcrRepository).getByAssetId(follower.id))).toEqual(
        strip(await ctx.get(OcrRepository).getByAssetId(leader.id)),
      );
      await expect(
        ctx.database.selectFrom('ocr_search').select('text').where('assetId', '=', follower.id).executeTakeFirst(),
      ).resolves.toEqual({ text: 'Test OCR' });
    });
  });

  describe('faces (H5, H6)', () => {
    const box = {
      imageWidth: 100,
      imageHeight: 100,
      boundingBoxX1: 10,
      boundingBoxY1: 10,
      boundingBoxX2: 50,
      boundingBoxY2: 50,
    };

    it('copies the leader’s faces and their person, instead of calling machine learning', async () => {
      const { sut, ctx } = setup(PersonService);
      const { userA, userB, leader, follower } = await newTwins(ctx);
      const { person } = await ctx.newPerson({ ownerId: userA.id });
      const { assetFace } = await ctx.newAssetFace({ assetId: leader.id, personGroupId: person.personGroupId, ...box });
      await ctx.database
        .insertInto('face_search')
        .values(mediumFactory.faceInsert({ faceId: assetFace.id }))
        .execute();
      await ctx.newJobStatus({ assetId: leader.id, facesRecognizedAt: new Date() });
      await ctx.newExif({ assetId: follower.id, make: 'Canon' });
      const machineLearning = ctx.getMock(MachineLearningRepository);

      await expect(sut.handleDetectFaces({ id: follower.id })).resolves.toBe(JobStatus.Success);

      expect(machineLearning.detectFaces).not.toHaveBeenCalled();
      const faces = await ctx.get(AssetJobRepository).getTwinFaces(follower.id);
      expect(faces).toEqual([expect.objectContaining({ ...box, personGroupId: person.personGroupId })]);
      await expect(
        ctx.get(PersonRepository).getByGroupId({ ownerId: userB.id, personGroupId: person.personGroupId }),
      ).resolves.toBeDefined();
    });

    it('mirrors a face deletion to the twin', async () => {
      const { sut, ctx } = setup(PersonService);
      const { userA, leader, follower } = await newTwins(ctx);
      const { person } = await ctx.newPerson({ ownerId: userA.id });
      const { assetFace } = await ctx.newAssetFace({
        assetId: leader.id,
        personGroupId: person.personGroupId,
        sourceType: SourceType.Manual,
        ...box,
      });
      await ctx.newAssetFace({ assetId: follower.id, personGroupId: person.personGroupId, ...box });
      await sut.deleteFace(factory.auth({ user: userA }), assetFace.id, { force: false });

      await expect(ctx.get(AssetJobRepository).getTwinFaces(follower.id)).resolves.toEqual([]);
    });
  });
});
