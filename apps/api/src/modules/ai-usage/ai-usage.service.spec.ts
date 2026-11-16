import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { AiUsageService } from './ai-usage.service';

function createPrismaMock() {
  return {
    aiUsageLog: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaService;
}

const provider = {
  id: 'provider-1',
  provider: 'anthropic',
  apiKey: 'sk-test',
  model: 'claude-sonnet-5',
  name: '官方',
};

describe('AiUsageService', () => {
  let prisma: PrismaService;
  let service: AiUsageService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new AiUsageService(prisma);
  });

  describe('record', () => {
    it('成功请求写入 token、耗时与来源快照', () => {
      service.record({
        feature: 'style.analyze',
        provider,
        model: 'claude-sonnet-5',
        usage: {
          input_tokens: 1200,
          output_tokens: 300,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 100,
        },
        latencyMs: 1234.6,
      });

      expect(prisma.aiUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          provider: 'anthropic',
          providerId: 'provider-1',
          providerName: '官方',
          model: 'claude-sonnet-5',
          feature: 'style.analyze',
          status: 'success',
          inputTokens: 1200,
          outputTokens: 300,
          cacheReadTokens: 800,
          cacheCreationTokens: 100,
          latencyMs: 1235,
          errorKind: null,
          errorMessage: null,
        }),
      });
    });

    it('错误摘要中的密钥会被脱敏', () => {
      service.record({
        feature: 'style.analyze',
        provider,
        model: 'claude-sonnet-5',
        latencyMs: 10,
        error: new Error('upstream rejected key sk-abcdef123456'),
      });

      expect(prisma.aiUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          errorMessage: 'upstream rejected key sk-***',
        }),
      });
    });

    it('失败请求记录错误分类，token 归零', () => {
      const error = Object.assign(new Error('rate limited'), { status: 429 });
      service.record({
        feature: 'design.generate',
        provider: null,
        model: 'unknown',
        latencyMs: 50,
        error,
      });

      expect(prisma.aiUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          provider: 'unknown',
          providerId: null,
          status: 'error',
          errorKind: 'rate_limit',
          errorMessage: 'rate limited',
          inputTokens: 0,
          outputTokens: 0,
        }),
      });
    });

    it('客户端断开导致的 abort 归为已取消', () => {
      const error = Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
      service.record({
        feature: 'design.generate',
        provider: null,
        model: 'unknown',
        latencyMs: 30,
        error,
      });

      expect(prisma.aiUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ errorKind: 'canceled' }),
      });
    });
  });

  describe('getOverview', () => {
    it('按天补齐序列并聚合功能/模型', async () => {
      const today = new Date();
      today.setHours(10, 0, 0, 0);
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      const rows = [
        {
          createdAt: yesterday,
          feature: 'style.analyze',
          model: 'claude-sonnet-5',
          status: 'success',
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 20,
          cacheCreationTokens: 0,
          latencyMs: 1000,
        },
        {
          createdAt: today,
          feature: 'style.analyze',
          model: 'claude-sonnet-5',
          status: 'error',
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          latencyMs: 500,
        },
        {
          createdAt: today,
          feature: 'design.generate',
          model: 'claude-sonnet-5',
          status: 'success',
          inputTokens: 200,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheCreationTokens: 10,
          latencyMs: 3000,
        },
      ];

      vi.mocked(prisma.aiUsageLog.findMany)
        .mockResolvedValueOnce(rows as never)
        .mockResolvedValueOnce([] as never);

      const result = await service.getOverview(7);

      expect(result.range.days).toBe(7);
      expect(result.series).toHaveLength(7);
      expect(result.totals).toMatchObject({
        requests: 3,
        success: 2,
        failed: 1,
        successRate: 66.7,
        inputTokens: 300,
        outputTokens: 150,
        cacheReadTokens: 20,
        cacheCreationTokens: 10,
        totalTokens: 450,
        avgLatencyMs: 1500,
      });
      expect(result.features.map((item) => item.feature)).toEqual([
        'design.generate',
        'style.analyze',
      ]);
      expect(result.features.find((item) => item.feature === 'style.analyze')).toMatchObject({
        requests: 2,
        failed: 1,
        totalTokens: 150,
        avgLatencyMs: 750,
      });
      expect(result.models).toEqual([
        expect.objectContaining({ model: 'claude-sonnet-5', requests: 3, totalTokens: 450 }),
      ]);
      expect(result.series.at(-1)).toMatchObject({
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        requests: 2,
        failed: 1,
        inputTokens: 200,
        outputTokens: 100,
      });
    });

    it('客户端断开的取消调用不计入失败与成功率', async () => {
      const today = new Date();
      today.setHours(10, 0, 0, 0);

      const rows = [
        {
          createdAt: today,
          feature: 'design.generate',
          model: 'claude-sonnet-5',
          status: 'success',
          errorKind: null,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          latencyMs: 100,
        },
        {
          createdAt: today,
          feature: 'design.generate',
          model: 'claude-sonnet-5',
          status: 'success',
          errorKind: null,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          latencyMs: 100,
        },
        {
          createdAt: today,
          feature: 'design.generate',
          model: 'claude-sonnet-5',
          status: 'error',
          errorKind: 'rate_limit',
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          latencyMs: 100,
        },
        {
          createdAt: today,
          feature: 'design.generate',
          model: 'claude-sonnet-5',
          status: 'error',
          errorKind: 'canceled',
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          latencyMs: 100,
        },
      ];

      vi.mocked(prisma.aiUsageLog.findMany)
        .mockResolvedValueOnce(rows as never)
        .mockResolvedValueOnce([] as never);

      const result = await service.getOverview(7);

      // 取消是客户端主动断开，不是上游故障：不进 failed，也不拉低成功率
      expect(result.totals).toMatchObject({
        requests: 4,
        success: 2,
        failed: 1,
        canceled: 1,
        successRate: 66.7,
      });
      expect(result.series.at(-1)).toMatchObject({ requests: 4, failed: 1, canceled: 1 });
      expect(result.features[0]).toMatchObject({ requests: 4, failed: 1, canceled: 1 });
      expect(result.models[0]).toMatchObject({ requests: 4, failed: 1, canceled: 1 });
    });
  });
});
