import { describe, expect, it, vi } from 'vitest';
import { PreviewSnapshotJobService } from './preview-snapshot-job.service';

function createService() {
  const prisma = {
    previewSnapshotJob: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
    },
  };
  return { service: new PreviewSnapshotJobService(prisma as never), prisma };
}

describe('PreviewSnapshotJobService lease fencing', () => {
  it('complete only writes when the job is still owned by this worker', async () => {
    const { service, prisma } = createService();

    await expect(
      service.complete('job-1', 'worker-a', { storagePath: 'p', artifactHash: 'h' }),
    ).resolves.toBe(true);

    expect(prisma.previewSnapshotJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'running', workerId: 'worker-a' },
      data: {
        status: 'succeeded',
        storagePath: 'p',
        artifactHash: 'h',
        error: null,
        finishedAt: expect.any(Date),
        leaseUntil: null,
        workerId: null,
      },
    });
  });

  it('complete reports a lost lease instead of overwriting a newer attempt', async () => {
    const { service, prisma } = createService();
    prisma.previewSnapshotJob.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.complete('job-1', 'worker-a', { storagePath: 'p', artifactHash: 'h' }),
    ).resolves.toBe(false);
  });

  it('fail ignores jobs that were re-claimed by another worker', async () => {
    const { service, prisma } = createService();
    prisma.previewSnapshotJob.findFirst.mockResolvedValue(null);

    await expect(service.fail('job-1', 'worker-a', 'boom')).resolves.toBe(false);
    expect(prisma.previewSnapshotJob.updateMany).not.toHaveBeenCalled();
  });

  it('fail requeues with backoff while retries remain', async () => {
    const { service, prisma } = createService();
    prisma.previewSnapshotJob.findFirst.mockResolvedValue({ attempts: 1, maxAttempts: 3 });

    await expect(service.fail('job-1', 'worker-a', 'boom')).resolves.toBe(true);

    expect(prisma.previewSnapshotJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'running', workerId: 'worker-a' },
      data: {
        status: 'pending',
        error: 'boom',
        availableAt: expect.any(Date),
        leaseUntil: null,
        workerId: null,
      },
    });
  });

  it('reclaimExpired re-checks the running lease before writing back', async () => {
    const { service, prisma } = createService();
    prisma.previewSnapshotJob.findMany.mockResolvedValue([
      { id: 'job-1', attempts: 1, maxAttempts: 3 },
    ]);

    await expect(service.reclaimExpired()).resolves.toBe(1);

    expect(prisma.previewSnapshotJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'running', leaseUntil: { lt: expect.any(Date) } },
      data: {
        status: 'pending',
        availableAt: expect.any(Date),
        leaseUntil: null,
        workerId: null,
      },
    });
  });

  it('enqueue does not reset a job that is still rendering', async () => {
    const { service } = createService();
    const tx = {
      previewSnapshotJob: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        upsert: vi.fn().mockResolvedValue({ id: 'job-1', status: 'running' }),
      },
    };

    await service.enqueue(tx as never, 'version-1');

    expect(tx.previewSnapshotJob.updateMany).toHaveBeenCalledWith({
      where: {
        versionId: 'version-1',
        viewport: 'desktop',
        state: 'default',
        kind: 'full',
        status: { not: 'running' },
      },
      data: {
        status: 'pending',
        attempts: 0,
        availableAt: expect.any(Date),
        leaseUntil: null,
        workerId: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      },
    });
    // upsert 的 update 分支不能改 status，否则并发入队可能把刚创建的 pending 卡成 running
    expect(tx.previewSnapshotJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { error: null } }),
    );
  });
});
