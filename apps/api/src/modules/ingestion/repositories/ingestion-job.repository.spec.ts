import { describe, expect, it, vi } from 'vitest';
import { IngestionJobStatus } from '../../../common/constants/enums';
import { IngestionJobRepository } from './ingestion-job.repository';

function createRepository(updateCount = 1) {
  const ingestionJob = {
    updateMany: vi.fn().mockResolvedValue({ count: updateCount }),
    findUnique: vi.fn().mockResolvedValue({ id: 'job-1', status: IngestionJobStatus.pending }),
  };
  return {
    repository: new IngestionJobRepository({ ingestionJob } as never),
    ingestionJob,
  };
}

describe('IngestionJobRepository state transitions', () => {
  it('only completes the processing attempt that owns the lease', async () => {
    const { repository, ingestionJob } = createRepository();

    await expect(repository.complete('job-1', 'lease-1', 'resource-1', '{}')).resolves.toBe(true);
    expect(ingestionJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-1', status: IngestionJobStatus.processing, leaseToken: 'lease-1' },
        data: expect.objectContaining({ status: IngestionJobStatus.completed, leaseToken: null }),
      }),
    );
  });

  it('does not retry a job that another request has already transitioned', async () => {
    const { repository, ingestionJob } = createRepository(0);

    await expect(repository.retryIfRetryable('job-1')).resolves.toBeNull();
    expect(ingestionJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'job-1',
          status: { in: [IngestionJobStatus.failed, IngestionJobStatus.canceled] },
        },
      }),
    );
    expect(ingestionJob.findUnique).not.toHaveBeenCalled();
  });

  it('only recovers jobs with a missing or expired lease', async () => {
    const { repository, ingestionJob } = createRepository();
    const staleBefore = new Date('2026-07-15T00:00:00.000Z');

    await repository.resetStaleProcessing(staleBefore);

    expect(ingestionJob.updateMany).toHaveBeenCalledWith({
      where: {
        status: IngestionJobStatus.processing,
        OR: [{ startedAt: null }, { startedAt: { lte: staleBefore } }],
      },
      data: { status: IngestionJobStatus.pending, startedAt: null, leaseToken: null },
    });
  });
});
