import { describe, expect, it, vi } from 'vitest';
import { IngestionScheduler } from './ingestion.scheduler';

describe('IngestionScheduler', () => {
  it('periodically recovers expired ingestion jobs while polling', async () => {
    vi.useFakeTimers();
    const ingestionService = {
      resetStaleJobs: vi.fn().mockResolvedValue(undefined),
      runNextJob: vi.fn().mockResolvedValue(false),
    };
    const config = {
      get: vi.fn((key: string) => (key === 'ingestion.staleJobTimeoutMs' ? 60_000 : 3_000)),
    };
    const scheduler = new IngestionScheduler(ingestionService as never, config as never);

    try {
      await scheduler.onModuleInit();
      expect(ingestionService.resetStaleJobs).toHaveBeenCalledWith(60_000);

      await vi.advanceTimersByTimeAsync(30_000);

      expect(ingestionService.resetStaleJobs).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.onModuleDestroy();
      vi.useRealTimers();
    }
  });
});
