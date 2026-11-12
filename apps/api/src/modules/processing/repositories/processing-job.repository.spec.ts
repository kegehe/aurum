import { describe, expect, it, vi } from 'vitest';
import { JobStatus } from '../../../common/constants/enums';
import { ProcessingJobRepository } from './processing-job.repository';

function createRepository() {
  const prisma = {
    processingJob: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const repository = new ProcessingJobRepository(prisma as never);
  return { repository, prisma };
}

describe('ProcessingJobRepository recovery helpers', () => {
  it('findStaleProcessing covers both thresholds and pages by id cursor', async () => {
    const { repository, prisma } = createRepository();
    const noHeartbeatBefore = new Date('2026-01-01T00:00:00Z');
    const startedBefore = new Date('2025-12-01T00:00:00Z');

    await repository.findStaleProcessing(noHeartbeatBefore, startedBefore, {
      take: 200,
      afterId: 'job-1',
    });

    expect(prisma.processingJob.findMany).toHaveBeenCalledWith({
      where: {
        status: JobStatus.processing,
        id: { gt: 'job-1' },
        OR: [
          { updatedAt: { lte: noHeartbeatBefore } },
          { startedAt: { lte: startedBefore } },
        ],
      },
      orderBy: { id: 'asc' },
      take: 200,
    });
  });

  it('requeueTerminal only moves failed/canceled jobs back to pending', async () => {
    const { repository, prisma } = createRepository();

    await expect(repository.requeueTerminal('job-1')).resolves.toBe(true);

    expect(prisma.processingJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        status: { in: [JobStatus.failed, JobStatus.canceled] },
      },
      data: {
        status: JobStatus.pending,
        retryCount: 0,
        startedAt: null,
        finishedAt: null,
        errorMessage: null,
      },
    });
  });

  it('heartbeat refreshes updatedAt and is fenced by the claimed startedAt', async () => {
    const { repository, prisma } = createRepository();
    const startedAt = new Date('2026-01-01T00:00:00Z');

    await expect(repository.heartbeat('job-1', startedAt)).resolves.toBe(true);

    expect(prisma.processingJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: JobStatus.processing, startedAt },
      data: { updatedAt: expect.any(Date) },
    });
  });

  it('heartbeat with a null legacy lease matches startedAt IS NULL, never any processing row', async () => {
    const { repository, prisma } = createRepository();

    await repository.heartbeat('job-1', null);

    expect(prisma.processingJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: JobStatus.processing, startedAt: null },
      data: { updatedAt: expect.any(Date) },
    });
  });

  it('retryIfProcessing is fenced by the claimed startedAt', async () => {
    const { repository, prisma } = createRepository();
    const startedAt = new Date('2026-01-01T00:00:00Z');

    await expect(repository.retryIfProcessing('job-1', startedAt)).resolves.toBe(true);

    expect(prisma.processingJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: JobStatus.processing, startedAt },
      data: {
        retryCount: { increment: 1 },
        status: JobStatus.pending,
        startedAt: null,
        finishedAt: null,
        errorMessage: null,
      },
    });
  });

  it('releaseIfProcessing returns the job to pending without spending a retry', async () => {
    const { repository, prisma } = createRepository();
    const startedAt = new Date('2026-01-01T00:00:00Z');

    await expect(repository.releaseIfProcessing('job-1', startedAt)).resolves.toBe(true);

    expect(prisma.processingJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: JobStatus.processing, startedAt },
      data: {
        status: JobStatus.pending,
        startedAt: null,
        finishedAt: null,
        errorMessage: null,
      },
    });
  });

  it('createIfNoActive skips insertion when an active sibling already exists', async () => {
    const tx = {
      processingJob: {
        findFirst: vi.fn().mockResolvedValue({ id: 'job-1' }),
        create: vi.fn(),
      },
    };
    const prisma = { $transaction: (fn: (client: typeof tx) => unknown) => fn(tx) };
    const repository = new ProcessingJobRepository(prisma as never);

    await expect(repository.createIfNoActive('detect_metadata', 'resource-1')).resolves.toBeNull();
    expect(tx.processingJob.create).not.toHaveBeenCalled();
  });

  it('createIfNoActive inserts a pending job when nothing is active', async () => {
    const tx = {
      processingJob: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'job-2', status: JobStatus.pending }),
      },
    };
    const prisma = { $transaction: (fn: (client: typeof tx) => unknown) => fn(tx) };
    const repository = new ProcessingJobRepository(prisma as never);

    await expect(repository.createIfNoActive('detect_metadata', 'resource-1')).resolves.toEqual({
      id: 'job-2',
      status: JobStatus.pending,
    });
    expect(tx.processingJob.create).toHaveBeenCalledWith({
      data: {
        resource: { connect: { id: 'resource-1' } },
        jobType: 'detect_metadata',
        status: JobStatus.pending,
      },
    });
  });

  it('completeIfProcessing reports false when the attempt lost its lease', async () => {
    const { repository, prisma } = createRepository();
    prisma.processingJob.updateMany.mockResolvedValue({ count: 0 });
    const startedAt = new Date('2026-01-01T00:00:00Z');

    await expect(repository.completeIfProcessing('job-1', startedAt)).resolves.toBe(false);
    expect(prisma.processingJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: JobStatus.processing, startedAt },
      data: {
        status: JobStatus.completed,
        finishedAt: expect.any(Date),
        errorMessage: null,
      },
    });
  });

  it('failIfProcessing keeps the lease fence and records the error', async () => {
    const { repository, prisma } = createRepository();
    const startedAt = new Date('2026-01-01T00:00:00Z');

    await expect(
      repository.failIfProcessing('job-1', 'boom', startedAt),
    ).resolves.toBe(true);

    expect(prisma.processingJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: JobStatus.processing, startedAt },
      data: {
        status: JobStatus.failed,
        finishedAt: expect.any(Date),
        errorMessage: 'boom',
      },
    });
  });

  it('claimNext renews the heartbeat timestamp so a long-pending job never looks stale', async () => {
    // 任务可能排队很久才被认领。认领时必须把 updatedAt 一起刷新，否则
    // 另一个进程启动扫描会把刚落地的任务误判成卡死并重新排队，导致重复执行。
    const tx = {
      processingJob: {
        findFirst: vi.fn().mockResolvedValue({ id: 'job-1' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ id: 'job-1', status: JobStatus.processing }),
      },
    };
    const prisma = { $transaction: (fn: (client: typeof tx) => unknown) => fn(tx) };
    const repository = new ProcessingJobRepository(prisma as never);

    await expect(repository.claimNext()).resolves.toEqual({
      id: 'job-1',
      status: JobStatus.processing,
    });

    expect(tx.processingJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: JobStatus.pending },
      data: {
        status: JobStatus.processing,
        startedAt: expect.any(Date),
        updatedAt: expect.any(Date),
        finishedAt: null,
      },
    });
  });

  it('cancelActive only touches pending/processing jobs', async () => {
    const { repository, prisma } = createRepository();

    await expect(repository.cancelActive('job-1', 'Canceled by user')).resolves.toBe(true);

    expect(prisma.processingJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        status: { in: [JobStatus.pending, JobStatus.processing] },
      },
      data: {
        status: JobStatus.canceled,
        finishedAt: expect.any(Date),
        errorMessage: 'Canceled by user',
      },
    });
  });
});
