// fork: derived-twins: R6's re-queued jobs must reach BullMQ with their delay
import { describe, expect, it, vi } from 'vitest';
import { JobName, QueueName } from 'src/enum.js';
import { JobRepository } from 'src/repositories/job.repository.js';

const setup = () => {
  const queue = { add: vi.fn().mockResolvedValue({}), addBulk: vi.fn().mockResolvedValue([]) };
  const moduleRef = { get: vi.fn().mockReturnValue(queue) };
  const logger = { setContext: vi.fn() };
  const sut = new JobRepository(moduleRef as any, {} as any, {} as any, logger as any);
  vi.spyOn(sut as any, 'getQueueName').mockReturnValue(QueueName.ThumbnailGeneration);
  return { sut, queue };
};

describe(JobRepository.name, () => {
  describe('queueAll', () => {
    it('adds a job re-queued to wait for a twin with its delay', async () => {
      const { sut, queue } = setup();
      const data = { id: 'asset-1', source: 'upload' as const, twinWaits: 1, delay: 30_000 };

      await sut.queue({ name: JobName.AssetGenerateThumbnails, data });

      expect(queue.add).toHaveBeenCalledWith(JobName.AssetGenerateThumbnails, data, { delay: 30_000 });
      expect(queue.addBulk).not.toHaveBeenCalled();
    });

    it('adds jobs without a delay in bulk, as upstream does', async () => {
      const { sut, queue } = setup();

      await sut.queueAll([
        { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1' } },
        { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-2' } },
      ]);

      expect(queue.add).not.toHaveBeenCalled();
      expect(queue.addBulk).toHaveBeenCalledWith([
        expect.objectContaining({ name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1' } }),
        expect.objectContaining({ name: JobName.AssetGenerateThumbnails, data: { id: 'asset-2' } }),
      ]);
    });
  });
});
