import { describe, expect, it, vi } from 'vitest';
import { IngestionJobStatus } from '../../../common/constants/enums';
import { IngestionJobRepository } from './ingestion-job.repository';

function createRepository(updateCount = 1) {
  const ingestionJob = {
    updateMany: vi.fn().mockResolvedValue({ count: updateCount }),
    findUnique: vi.fn().mockResolvedValue({ id: 'job-1', status: IngestionJobStatus.failed, retryCount: 0 }),
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
    // findUnique was called to check status/retryCount, but updateMany returns 0 (already transitioned)
    expect(ingestionJob.findUnique).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      select: { retryCount: true, status: true },
    });
    expect(ingestionJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'job-1',
          status: { in: [IngestionJobStatus.failed, IngestionJobStatus.canceled] },
          retryCount: { lt: 3 },
        },
      }),
    );
  });

  it('does not retry a job that has exceeded maxRetry', async () => {
    const { repository, ingestionJob } = createRepository();
    ingestionJob.findUnique.mockResolvedValue({ id: 'job-1', status: IngestionJobStatus.failed, retryCount: 3 });

    await expect(repository.retryIfRetryable('job-1', 3)).resolves.toBeNull();
    expect(ingestionJob.updateMany).not.toHaveBeenCalled();
  });

  it('does not retry a job that is not in a terminal state', async () => {
    const { repository, ingestionJob } = createRepository();
    ingestionJob.findUnique.mockResolvedValue({ id: 'job-1', status: IngestionJobStatus.pending, retryCount: 0 });

    await expect(repository.retryIfRetryable('job-1')).resolves.toBeNull();
    expect(ingestionJob.updateMany).not.toHaveBeenCalled();
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
