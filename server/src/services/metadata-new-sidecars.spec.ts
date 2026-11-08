// fork: new-sidecars. Metadata extraction finds a sidecar that appeared after the file was indexed
// (IMMICH_FIND_NEW_SIDECARS; fork/IMPLEMENTATION.md, section 10).
import { Stats } from 'node:fs';
import { AssetFileType, ImmichWorker } from 'src/enum.js';
import { MetadataService } from 'src/services/metadata.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { getForMetadataExtraction } from 'test/mappers.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const photo = () => AssetFactory.from({ originalPath: '/library/IMG_123.jpg' }).build();
const withSidecar = (asset: ReturnType<typeof photo>, path = `${asset.originalPath}.xmp`) =>
  AssetFactory.from(asset).file({ type: AssetFileType.Sidecar, path }).build();

describe('metadata extraction with IMMICH_FIND_NEW_SIDECARS', () => {
  let sut: MetadataService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(MetadataService));
    mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);
    const time = new Date('2022-01-01T00:00:00.000Z');
    mocks.storage.stat.mockResolvedValue({
      size: 1,
      mtime: time,
      mtimeMs: time.valueOf(),
      birthtimeMs: time.valueOf(),
    } as Stats);
    // The image holds no metadata; a sidecar rates the photo 4.
    mocks.metadata.readTags.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith('.xmp') ? { Rating: 4 } : {}),
    );
    process.env.IMMICH_FIND_NEW_SIDECARS = 'true';
  });

  afterEach(async () => {
    delete process.env.IMMICH_FIND_NEW_SIDECARS;
    await sut.onShutdown();
  });

  it('finds and reads a sidecar that appeared after the file was indexed', async () => {
    const asset = photo();
    mocks.assetJob.getForMetadataExtraction
      .mockResolvedValueOnce(getForMetadataExtraction(asset))
      .mockResolvedValueOnce(getForMetadataExtraction(withSidecar(asset)));
    mocks.assetJob.getForSidecarCheckJob.mockResolvedValue({
      id: asset.id,
      originalPath: asset.originalPath,
      files: [],
    });
    mocks.storage.checkFileExists.mockResolvedValueOnce(true);

    await sut.handleMetadataExtraction({ id: asset.id });

    expect(mocks.asset.upsertFile).toHaveBeenCalledWith({
      assetId: asset.id,
      type: AssetFileType.Sidecar,
      path: '/library/IMG_123.jpg.xmp',
    });
    expect(mocks.metadata.readTags).toHaveBeenCalledWith('/library/IMG_123.jpg.xmp');
    expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
      expect.objectContaining({ exif: expect.objectContaining({ rating: 4 }) }),
    );
  });

  it('finds a sidecar named without the extension, as the sidecar check does', async () => {
    const asset = photo();
    mocks.assetJob.getForMetadataExtraction
      .mockResolvedValueOnce(getForMetadataExtraction(asset))
      .mockResolvedValueOnce(getForMetadataExtraction(withSidecar(asset, '/library/IMG_123.xmp')));
    mocks.assetJob.getForSidecarCheckJob.mockResolvedValue({
      id: asset.id,
      originalPath: asset.originalPath,
      files: [],
    });
    mocks.storage.checkFileExists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await sut.handleMetadataExtraction({ id: asset.id });

    expect(mocks.asset.upsertFile).toHaveBeenCalledWith({
      assetId: asset.id,
      type: AssetFileType.Sidecar,
      path: '/library/IMG_123.xmp',
    });
    expect(mocks.metadata.readTags).toHaveBeenCalledWith('/library/IMG_123.xmp');
  });

  it('reads the file as before when there is no sidecar on disk', async () => {
    const asset = photo();
    mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
    mocks.assetJob.getForSidecarCheckJob.mockResolvedValue({
      id: asset.id,
      originalPath: asset.originalPath,
      files: [],
    });
    mocks.storage.checkFileExists.mockResolvedValue(false);

    await sut.handleMetadataExtraction({ id: asset.id });

    expect(mocks.asset.upsertFile).not.toHaveBeenCalled();
    expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledTimes(1);
    expect(mocks.metadata.readTags).toHaveBeenCalledTimes(1);
    expect(mocks.asset.upsertExif).toHaveBeenCalled();
  });

  it("doesn't look again for a sidecar the asset already has", async () => {
    const asset = withSidecar(photo());
    mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));

    await sut.handleMetadataExtraction({ id: asset.id });

    expect(mocks.assetJob.getForSidecarCheckJob).not.toHaveBeenCalled();
    expect(mocks.storage.checkFileExists).not.toHaveBeenCalled();
    expect(mocks.metadata.readTags).toHaveBeenCalledWith('/library/IMG_123.jpg.xmp');
  });

  it('behaves as upstream with the switch off: no sidecar is looked for', async () => {
    delete process.env.IMMICH_FIND_NEW_SIDECARS;
    const asset = photo();
    mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
    mocks.storage.checkFileExists.mockResolvedValue(true);

    await sut.handleMetadataExtraction({ id: asset.id });

    expect(mocks.assetJob.getForSidecarCheckJob).not.toHaveBeenCalled();
    expect(mocks.storage.checkFileExists).not.toHaveBeenCalled();
    expect(mocks.asset.upsertFile).not.toHaveBeenCalled();
    expect(mocks.metadata.readTags).toHaveBeenCalledTimes(1);
  });
});
