// fork: new-sidecars. With real files, a real database and exiftool: a sidecar that appeared after the file was
// indexed is found and read when the metadata is extracted again (IMMICH_FIND_NEW_SIDECARS; fork/IMPLEMENTATION.md,
// section 10).
import { Kysely } from 'kysely';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetFileType } from 'src/enum.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { DB } from 'src/schema/index.js';
import { MetadataService } from 'src/services/metadata.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB, newRandomImage } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;
let dir: string;

const setup = () => {
  const { sut, ctx } = newMediumService(MetadataService, {
    database: defaultDatabase,
    real: [
      AssetRepository,
      AssetJobRepository,
      ConfigRepository,
      MetadataRepository,
      StorageRepository,
      SystemMetadataRepository,
      TagRepository,
    ],
    mock: [EventRepository, LoggingRepository],
  });
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  return { sut, ctx };
};

/** A photo already indexed, with no sidecar yet; then a sidecar rating it 4 appears beside it. */
const indexedPhoto = async () => {
  const { sut, ctx } = setup();
  const photo = join(dir, `${Math.random().toString(36).slice(2)}.png`);
  await writeFile(photo, newRandomImage());
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ originalPath: photo, ownerId: user.id });
  await ctx.newExif({ assetId: asset.id, description: '' });
  await sut.handleMetadataExtraction({ id: asset.id });
  await ctx.get(MetadataRepository).writeTags(`${photo}.xmp`, { Rating: 4 });
  const read = async () => ({
    rating: await ctx.database
      .selectFrom('asset_exif')
      .select('rating')
      .where('assetId', '=', asset.id)
      .executeTakeFirstOrThrow()
      .then((exif) => exif.rating),
    sidecars: await ctx.database
      .selectFrom('asset_file')
      .select('path')
      .where('assetId', '=', asset.id)
      .where('type', '=', AssetFileType.Sidecar)
      .execute(),
  });
  return { sut, asset, photo, read };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
  dir = await mkdtemp(join(tmpdir(), 'immich-new-sidecars-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('metadata extraction with IMMICH_FIND_NEW_SIDECARS', () => {
  it('finds and reads a sidecar that appeared after the file was indexed', async () => {
    vi.stubEnv('IMMICH_FIND_NEW_SIDECARS', 'true');
    const { sut, asset, photo, read } = await indexedPhoto();

    await sut.handleMetadataExtraction({ id: asset.id });

    await expect(read()).resolves.toEqual({ rating: 4, sidecars: [{ path: `${photo}.xmp` }] });
  });

  it('as upstream without the switch: the new sidecar is left unread', async () => {
    const { sut, asset, read } = await indexedPhoto();

    await sut.handleMetadataExtraction({ id: asset.id });

    await expect(read()).resolves.toEqual({ rating: null, sidecars: [] });
  });
});
