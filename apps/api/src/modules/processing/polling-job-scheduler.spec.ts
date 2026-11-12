import { describe, expect, it, vi } from 'vitest';
import { JobStatus, JobType, ProcessingStatus } from '../../common/constants/enums';
import { PollingJobScheduler } from './polling-job-scheduler';

const STALE_TIMEOUT_MS = 60_000;
const MAX_EXECUTION_MS = 30 * 60_000;

function createScheduler(
  overrides: { processingEnabled?: boolean; concurrency?: number; maxExecutionMs?: number } = {},
) {
  const jobRepo = {
    findStaleProcessing: vi.fn().mockResolvedValue([]),
    findByResourceId: vi.fn().mockResolvedValue([]),
    findMany: vi.fn(),
    claimNext: vi.fn().mockResolvedValue(null),
    createIfNoActive: vi.fn().mockResolvedValue({ id: 'new-job' }),
    heartbeat: vi.fn().mockResolvedValue(true),
    retryIfProcessing: vi.fn().mockResolvedValue(true),
    releaseIfProcessing: vi.fn().mockResolvedValue(true),
    failIfProcessing: vi.fn().mockResolvedValue(true),
    completeIfProcessing: vi.fn().mockResolvedValue(true),
  };
  const resourceRepo = {
    updateProcessingStatus: vi.fn().mockResolvedValue(undefined),
  };
  const config = {
    get: vi.fn((key: string) => {
      switch (key) {
        case 'worker.pollIntervalMs':
          return 5_000;
        case 'worker.concurrency':
          return overrides.concurrency ?? 2;
        case 'worker.maxRetry':
          return 3;
        case 'worker.staleTimeoutMs':
          return STALE_TIMEOUT_MS;
        case 'worker.maxExecutionMs':
          return overrides.maxExecutionMs ?? MAX_EXECUTION_MS;
        case 'execution.processingEnabled':
          return overrides.processingEnabled ?? true;
        default:
          return undefined;
      }
    }),
  };
  const scheduler = new PollingJobScheduler(
    jobRepo as never,
    resourceRepo as never,
    config as never,
  );
  return { scheduler, jobRepo, resourceRepo };
}

describe('PollingJobScheduler stale recovery', () => {
  it('recovers every stale processing job, not just the first page', async () => {
    vi.useFakeTimers();
    const { scheduler, jobRepo } = createScheduler();
    const staleBefore = new Date(Date.now() - STALE_TIMEOUT_MS);
    const jobs = Array.from({ length: 25 }, (_, index) => ({
      id: `job-${index}`,
      resourceId: `resource-${index}`,
      retryCount: 0,
      startedAt: staleBefore,
      updatedAt: staleBefore,
    }));
    jobRepo.findStaleProcessing.mockResolvedValue(jobs);

    try {
      await scheduler.onApplicationBootstrap();
      // 启动回收在 start() 之后异步执行，等微任务跑完
      await vi.advanceTimersByTimeAsync(0);

      // 回收查询同时带上心跳/执行时长两个阈值，并按页取（不再一次读全表）
      expect(jobRepo.findStaleProcessing).toHaveBeenCalledWith(expect.any(Date), expect.any(Date), {
        take: 200,
        afterId: undefined,
      });
      const [noHeartbeatBefore, startedBefore] = jobRepo.findStaleProcessing.mock.calls[0] as [
        Date,
        Date,
      ];
      expect(startedBefore.getTime()).toBeLessThan(noHeartbeatBefore.getTime());
      expect(jobRepo.findMany).not.toHaveBeenCalled();
      expect(jobRepo.retryIfProcessing).toHaveBeenCalledTimes(25);
    } finally {
      scheduler.onModuleDestroy();
      vi.useRealTimers();
    }
  });

  it('marks stale jobs that exhausted retries as failed', async () => {
    vi.useFakeTimers();
    const { scheduler, jobRepo } = createScheduler();
    const startedAt = new Date(Date.now() - STALE_TIMEOUT_MS);
    jobRepo.findStaleProcessing.mockResolvedValue([
      { id: 'job-1', resourceId: 'resource-1', retryCount: 3, startedAt, updatedAt: startedAt },
    ]);
    jobRepo.findByResourceId.mockResolvedValue([{ id: 'job-1', status: JobStatus.failed }]);

    try {
      await scheduler.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);

      expect(jobRepo.failIfProcessing).toHaveBeenCalledWith(
        'job-1',
        expect.stringContaining('Max retries exceeded'),
        startedAt,
      );
      expect(jobRepo.retryIfProcessing).not.toHaveBeenCalled();
    } finally {
      scheduler.onModuleDestroy();
      vi.useRealTimers();
    }
  });

  it('periodically sweeps jobs whose heartbeat expired', async () => {
    vi.useFakeTimers();
    const { scheduler, jobRepo } = createScheduler();

    try {
      await scheduler.onApplicationBootstrap();
      // 启动时先扫一次（异步，等微任务跑完）
      await vi.advanceTimersByTimeAsync(0);
      expect(jobRepo.findStaleProcessing).toHaveBeenCalledTimes(1);

      // staleTimeout=60s → 回收间隔 = min(30s, 60s) = 30s
      await vi.advanceTimersByTimeAsync(30_000);

      expect(jobRepo.findStaleProcessing).toHaveBeenCalledTimes(2);
      const [noHeartbeatBefore] = jobRepo.findStaleProcessing.mock.calls[1] as [Date, Date];
      expect(noHeartbeatBefore).toBeInstanceOf(Date);
      expect(Date.now() - noHeartbeatBefore.getTime()).toBeGreaterThanOrEqual(STALE_TIMEOUT_MS);
    } finally {
      scheduler.onModuleDestroy();
      vi.useRealTimers();
    }
  });

  it('does not sweep when this process only enqueues jobs', async () => {
    const { scheduler, jobRepo } = createScheduler({ processingEnabled: false });

    await scheduler.onApplicationBootstrap();

    expect(jobRepo.findStaleProcessing).not.toHaveBeenCalled();
    scheduler.onModuleDestroy();
  });

  it('sweeps stale jobs page by page so a backlog never loads at once', async () => {
    vi.useFakeTimers();
    const { scheduler, jobRepo } = createScheduler();
    const staleBefore = new Date(Date.now() - STALE_TIMEOUT_MS);
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      id: `job-${index}`,
      resourceId: `resource-${index}`,
      retryCount: 0,
      startedAt: staleBefore,
      updatedAt: staleBefore,
    }));
    jobRepo.findStaleProcessing.mockResolvedValueOnce(firstPage).mockResolvedValueOnce([]);

    try {
      await scheduler.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);

      expect(jobRepo.findStaleProcessing).toHaveBeenCalledTimes(2);
      expect(jobRepo.findStaleProcessing.mock.calls[1][2]).toEqual({
        take: 200,
        afterId: 'job-199',
      });
      expect(jobRepo.retryIfProcessing).toHaveBeenCalledTimes(200);
    } finally {
      scheduler.onModuleDestroy();
      vi.useRealTimers();
    }
  });

  it('requeues jobs still running on shutdown without spending a retry', async () => {
    vi.useFakeTimers();
    const { scheduler, jobRepo, resourceRepo } = createScheduler({ concurrency: 1 });
    const startedAt = new Date(Date.now());
    jobRepo.claimNext
      .mockResolvedValueOnce({
        id: 'job-1',
        resourceId: 'resource-1',
        jobType: JobType.detect_metadata,
        retryCount: 0,
        startedAt,
      })
      .mockResolvedValue(null);
    scheduler.onJobType(JobType.detect_metadata, () => new Promise<void>(() => undefined));

    try {
      await scheduler.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      expect(jobRepo.claimNext).toHaveBeenCalledTimes(1);

      const shutdown = scheduler.onApplicationShutdown();
      // 宽限窗口到期后仍未完成的任务会被放回队列
      await vi.advanceTimersByTimeAsync(5_000);
      await shutdown;

      expect(jobRepo.releaseIfProcessing).toHaveBeenCalledWith('job-1', startedAt);
      // 正常退出不是失败，不能消耗重试次数
      expect(jobRepo.retryIfProcessing).not.toHaveBeenCalled();
      expect(resourceRepo.updateProcessingStatus).toHaveBeenCalledWith(
        'resource-1',
        ProcessingStatus.failed,
      );
    } finally {
      scheduler.onModuleDestroy();
      vi.useRealTimers();
    }
  });

  it('serializes resource status refreshes for the same resource', async () => {
    vi.useFakeTimers();
    const { scheduler, jobRepo } = createScheduler({ concurrency: 2 });
    const startedAt = new Date(Date.now());
    jobRepo.claimNext
      .mockResolvedValueOnce({
        id: 'job-1',
        resourceId: 'resource-1',
        jobType: JobType.detect_metadata,
        retryCount: 0,
        startedAt,
      })
      .mockResolvedValueOnce({
        id: 'job-2',
        resourceId: 'resource-1',
        jobType: JobType.generate_thumbnail,
        retryCount: 0,
        startedAt,
      })
      .mockResolvedValue(null);

    let inFlight = 0;
    let maxInFlight = 0;
    jobRepo.findByResourceId.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // 留出重叠窗口：没有排队时两次重算会同时读到旧快照
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return [];
    });
    scheduler.onJobType(JobType.detect_metadata, async () => undefined);
    scheduler.onJobType(JobType.generate_thumbnail, async () => undefined);

    try {
      await scheduler.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(50);

      expect(maxInFlight).toBe(1);
    } finally {
      scheduler.onModuleDestroy();
      vi.useRealTimers();
    }
  });

  it('heartbeats active attempts so other consumers do not recover them', async () => {
    vi.useFakeTimers();
    const { scheduler, jobRepo } = createScheduler();
    const startedAt = new Date(Date.now());
    jobRepo.claimNext
      .mockResolvedValueOnce({
        id: 'job-1',
        resourceId: 'resource-1',
        jobType: JobType.detect_metadata,
        retryCount: 0,
        startedAt,
      })
      .mockResolvedValue(null);
    let release: () => void = () => undefined;
    scheduler.onJobType(
      JobType.detect_metadata,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    try {
      await scheduler.onApplicationBootstrap();
      // 心跳间隔 = min(staleTimeout/4, 30s) = 15s
      await vi.advanceTimersByTimeAsync(15_000);

      expect(jobRepo.heartbeat).toHaveBeenCalledWith('job-1', startedAt);
    } finally {
      release();
      scheduler.onModuleDestroy();
      vi.useRealTimers();
    }
  });

  it('requeues a stale processing job when the resource is reprocessed', async () => {
    const { scheduler, jobRepo, resourceRepo } = createScheduler();
    const lastProgressAt = new Date(Date.now() - 120_000);
    const staleJob = {
      id: 'job-1',
      jobType: JobType.detect_metadata,
      status: JobStatus.processing,
      retryCount: 0,
      startedAt: lastProgressAt,
      updatedAt: lastProgressAt,
    };
    // 第一次是 enqueue 的冲突查询；第二次是回收后的状态重算
    jobRepo.findByResourceId
      .mockResolvedValueOnce([staleJob])
      .mockResolvedValueOnce([{ ...staleJob, status: JobStatus.pending, startedAt: null }]);

    await scheduler.enqueue(JobType.detect_metadata, 'resource-1');

    expect(jobRepo.retryIfProcessing).toHaveBeenCalledWith('job-1', lastProgressAt);
    expect(jobRepo.createIfNoActive).not.toHaveBeenCalled();
    expect(resourceRepo.updateProcessingStatus).toHaveBeenCalledWith(
      'resource-1',
      ProcessingStatus.pending,
    );
  });

  it('skips duplicate jobs that are genuinely active', async () => {
    const { scheduler, jobRepo } = createScheduler();
    jobRepo.findByResourceId.mockResolvedValue([
      {
        id: 'job-1',
        jobType: JobType.detect_metadata,
        status: JobStatus.processing,
        retryCount: 0,
        startedAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    await scheduler.enqueue(JobType.detect_metadata, 'resource-1');

    expect(jobRepo.retryIfProcessing).not.toHaveBeenCalled();
    expect(jobRepo.createIfNoActive).not.toHaveBeenCalled();
  });

  it('skips when another consumer wins the enqueue race', async () => {
    const { scheduler, jobRepo, resourceRepo } = createScheduler();
    // 冲突检查时还没有活跃任务，插入时另一个进程已经抢先建好
    jobRepo.createIfNoActive.mockResolvedValueOnce(null);

    await scheduler.enqueue(JobType.detect_metadata, 'resource-1');

    // 不应该再重算资源状态（任务归抢先的一方）
    expect(resourceRepo.updateProcessingStatus).not.toHaveBeenCalled();
  });

  it('replaces a stale job that exhausted retries on re-enqueue', async () => {
    const { scheduler, jobRepo } = createScheduler();
    const lastProgressAt = new Date(Date.now() - 120_000);
    const staleJob = {
      id: 'job-1',
      jobType: JobType.detect_metadata,
      status: JobStatus.processing,
      retryCount: 3,
      startedAt: lastProgressAt,
      updatedAt: lastProgressAt,
    };
    // 冲突查询 → 标记失败后的复查（该任务已是 failed）
    jobRepo.findByResourceId
      .mockResolvedValueOnce([staleJob])
      .mockResolvedValueOnce([{ ...staleJob, status: JobStatus.failed }]);

    await scheduler.enqueue(JobType.detect_metadata, 'resource-1');

    expect(jobRepo.failIfProcessing).toHaveBeenCalledWith(
      'job-1',
      expect.stringContaining('Max retries exceeded'),
      lastProgressAt,
    );
    expect(jobRepo.createIfNoActive).toHaveBeenCalledWith(JobType.detect_metadata, 'resource-1');
  });

  it('releases the old slot when the same job is re-claimed', async () => {
    vi.useFakeTimers();
    const { scheduler, jobRepo } = createScheduler({ concurrency: 2 });
    const firstStart = new Date(Date.now());
    const secondStart = new Date(Date.now() + 1);
    const claimed = (startedAt: Date) => ({
      id: 'job-1',
      resourceId: 'resource-1',
      jobType: JobType.detect_metadata,
      retryCount: 0,
      startedAt,
    });
    jobRepo.claimNext
      .mockResolvedValueOnce(claimed(firstStart))
      .mockResolvedValueOnce(claimed(secondStart))
      .mockResolvedValue(null);
    scheduler.onJobType(JobType.detect_metadata, () => new Promise<void>(() => undefined));

    try {
      await scheduler.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);

      // 第二次认领同一任务时必须释放旧槽位，轮询才会继续请求下一个任务
      expect(jobRepo.claimNext).toHaveBeenCalledTimes(3);
    } finally {
      scheduler.onModuleDestroy();
      vi.useRealTimers();
    }
  });

  it('recovers a hung handler at the max execution limit and frees its slot', async () => {
    vi.useFakeTimers();
    const { scheduler, jobRepo } = createScheduler({ concurrency: 1, maxExecutionMs: 60_000 });
    const startedAt = new Date(Date.now());
    const job = {
      id: 'job-1',
      resourceId: 'resource-1',
      jobType: JobType.detect_metadata,
      retryCount: 0,
      startedAt,
      updatedAt: startedAt,
    };
    jobRepo.claimNext.mockResolvedValueOnce(job).mockResolvedValue(null);
    // 心跳一直成功（处理器挂起但进程健康），只能靠执行时长上限识别
    let requeued = false;
    jobRepo.findStaleProcessing.mockImplementation(async () =>
      Date.now() - startedAt.getTime() >= 60_000 ? [job] : [],
    );
    jobRepo.retryIfProcessing.mockImplementation(async () => {
      requeued = true;
      return true;
    });
    jobRepo.heartbeat.mockImplementation(async () => !requeued);
    scheduler.onJobType(JobType.detect_metadata, () => new Promise<void>(() => undefined));

    try {
      await scheduler.onApplicationBootstrap();
      expect(jobRepo.claimNext).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(80_000);

      expect(jobRepo.retryIfProcessing).toHaveBeenCalledWith('job-1', startedAt);
      // 租约丢失后槽位被释放，80s 的轮询会再次尝试认领
      expect(jobRepo.claimNext).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.onModuleDestroy();
      vi.useRealTimers();
    }
  });

  it('does not create a duplicate when the stale requeue loses a race', async () => {
    const { scheduler, jobRepo } = createScheduler();
    const staleAt = new Date(Date.now() - 120_000);
    const staleJob = {
      id: 'job-1',
      jobType: JobType.detect_metadata,
      status: JobStatus.processing,
      retryCount: 0,
      startedAt: staleAt,
      updatedAt: staleAt,
    };
    jobRepo.findByResourceId
      .mockResolvedValueOnce([staleJob])
      // 回收失败后复查：另一进程已经把它重新认领为 processing
      .mockResolvedValueOnce([
        { ...staleJob, status: JobStatus.processing, startedAt: new Date() },
      ]);
    jobRepo.retryIfProcessing.mockResolvedValue(false);

    await scheduler.enqueue(JobType.detect_metadata, 'resource-1');

    expect(jobRepo.createIfNoActive).not.toHaveBeenCalled();
  });

  it('immediately claims the next job when a slot frees', async () => {
    vi.useFakeTimers();
    const { scheduler, jobRepo } = createScheduler({ concurrency: 1 });
    const startedAt = new Date(Date.now());
    jobRepo.claimNext.mockResolvedValueOnce({
      id: 'job-1',
      resourceId: 'resource-1',
      jobType: JobType.detect_metadata,
      retryCount: 0,
      startedAt,
    });
    let release: () => void = () => undefined;
    scheduler.onJobType(
      JobType.detect_metadata,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    try {
      await scheduler.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      expect(jobRepo.claimNext).toHaveBeenCalledTimes(1);

      release();
      // 不推进 5s 轮询定时器：任务结束释放槽位就应立刻补位
      await vi.advanceTimersByTimeAsync(0);

      expect(jobRepo.claimNext).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.onModuleDestroy();
      vi.useRealTimers();
    }
  });

  it('releases the concurrency slot when the lease is lost', async () => {
    vi.useFakeTimers();
    const { scheduler, jobRepo } = createScheduler({ concurrency: 1 });
    const startedA = new Date(Date.now());
    const startedB = new Date(Date.now());
    jobRepo.claimNext
      .mockResolvedValueOnce({
        id: 'job-a',
        resourceId: 'resource-a',
        jobType: JobType.detect_metadata,
        retryCount: 0,
        startedAt: startedA,
      })
      .mockResolvedValueOnce({
        id: 'job-b',
        resourceId: 'resource-b',
        jobType: JobType.detect_metadata,
        retryCount: 0,
        startedAt: startedB,
      });
    // 两个处理器都永远不返回，模拟挂起的 Promise
    scheduler.onJobType(JobType.detect_metadata, () => new Promise<void>(() => undefined));
    // 第一次心跳即发现租约已失效（例如任务被取消）
    jobRepo.heartbeat.mockResolvedValue(false);

    try {
      await scheduler.onApplicationBootstrap();
      expect(jobRepo.claimNext).toHaveBeenCalledTimes(1);

      // 15s 心跳释放槽位，20s 的轮询应能认领下一个任务
      await vi.advanceTimersByTimeAsync(20_000);

      expect(jobRepo.heartbeat).toHaveBeenCalledWith('job-a', startedA);
      expect(jobRepo.claimNext).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.onModuleDestroy();
      vi.useRealTimers();
    }
  });
});
