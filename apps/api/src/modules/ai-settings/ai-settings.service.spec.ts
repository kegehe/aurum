/**
 * AiSettingsService 单元测试
 *
 * mock 仓储与 Anthropic SDK，覆盖：
 * - 生效配置解析：数据库优先、环境变量回退、未配置不可用
 * - 首个配置自动生效
 * - 掩码/空密钥不覆盖已有密钥
 * - 激活/删除切换
 * - 连通性测试成功/失败（不抛异常）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AiSettingsService } from './ai-settings.service';
import type { AiProviderRepository } from './repositories/ai-provider.repository';

const { createMock, AnthropicMock } = vi.hoisted(() => {
  const createMock = vi.fn();
  class APIError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.status = status;
    }
  }
  class AnthropicMock {
    static APIError = APIError;
    messages = { create: createMock };
    constructor(_opts: unknown) {}
  }
  return { createMock, AnthropicMock };
});

vi.mock('@anthropic-ai/sdk', () => ({ default: AnthropicMock }));

/** 最小行记录 */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '1',
    name: '官方',
    provider: 'anthropic',
    baseUrl: null,
    apiKey: 'sk-test-1234',
    model: 'claude-sonnet-5',
    isActive: false,
    enabled: true,
    lastTestedAt: null,
    lastTestStatus: null,
    lastTestError: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function createRepoMock(overrides: Partial<Record<keyof AiProviderRepository, unknown>> = {}) {
  const base: Record<string, unknown> = {
    findAll: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(null),
    findActive: vi.fn().mockResolvedValue(null),
    findFirstEnabled: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    update: vi.fn(),
    setActive: vi.fn(),
    delete: vi.fn(),
    setTestResult: vi.fn(),
  };
  return { ...base, ...overrides } as unknown as AiProviderRepository;
}

function createConfigMock(env: { apiKey?: string; baseUrl?: string; model?: string } = {}) {
  return {
    get: vi.fn((key: string) => {
      if (key === 'ai.anthropicApiKey') return env.apiKey ?? '';
      if (key === 'ai.baseUrl') return env.baseUrl ?? '';
      if (key === 'ai.styleModel') return env.model ?? 'claude-sonnet-5';
      return undefined;
    }),
  } as unknown as ConfigService;
}

describe('AiSettingsService', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  describe('生效配置解析', () => {
    it('无任何配置时不可用', async () => {
      const service = new AiSettingsService(createRepoMock(), createConfigMock());
      await service.refresh();
      expect(service.available).toBe(false);
      expect(service.summary.source).toBe(null);
    });

    it('数据库无生效配置时回退到环境变量', async () => {
      const service = new AiSettingsService(
        createRepoMock(),
        createConfigMock({ apiKey: 'env-key', model: 'claude-3-5-haiku' }),
      );
      await service.refresh();
      expect(service.available).toBe(true);
      expect(service.activeProvider?.apiKey).toBe('env-key');
      expect(service.activeProvider?.model).toBe('claude-3-5-haiku');
      expect(service.summary.source).toBe('env');
    });

    it('数据库生效配置优先于环境变量', async () => {
      const repo = createRepoMock({
        findActive: vi.fn().mockResolvedValue(row({ apiKey: 'db-key', model: 'claude-sonnet-5' })),
      });
      const service = new AiSettingsService(repo, createConfigMock({ apiKey: 'env-key' }));
      await service.refresh();
      expect(service.activeProvider?.apiKey).toBe('db-key');
      expect(service.summary.source).toBe('db');
    });

    it('生效配置被停用时回退到环境变量', async () => {
      const repo = createRepoMock({
        findActive: vi.fn().mockResolvedValue(row({ enabled: false, apiKey: 'db-key' })),
      });
      const service = new AiSettingsService(repo, createConfigMock({ apiKey: 'env-key' }));
      await service.refresh();
      expect(service.activeProvider?.apiKey).toBe('env-key');
      expect(service.summary.source).toBe('env');
    });
  });

  describe('跨进程配置同步', () => {
    it('定时轮询后加载其它进程刚保存的配置', async () => {
      const findActive = vi
        .fn()
        .mockResolvedValueOnce(row({ id: '1', model: 'old-model', isActive: true, enabled: true }))
        .mockResolvedValueOnce(row({ id: '1', model: 'new-model', isActive: true, enabled: true }));
      const service = new AiSettingsService(createRepoMock({ findActive }), createConfigMock());
      await service.refresh();
      expect(service.activeProvider?.model).toBe('old-model');

      await service.pollActiveProvider();
      expect(service.activeProvider?.model).toBe('new-model');
    });

    it('较旧的刷新结果晚到时不会覆盖较新的配置', async () => {
      let resolveOld!: (value: ReturnType<typeof row>) => void;
      const findActive = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<ReturnType<typeof row>>((resolve) => {
              resolveOld = resolve;
            }),
        )
        .mockResolvedValueOnce(
          row({ id: '1', model: 'new-model', isActive: true, enabled: true }),
        );
      const service = new AiSettingsService(createRepoMock({ findActive }), createConfigMock());

      const oldRefresh = service.refresh();
      await service.refresh();
      expect(service.activeProvider?.model).toBe('new-model');

      resolveOld(row({ id: '1', model: 'old-model', isActive: true, enabled: true }));
      await oldRefresh;
      expect(service.activeProvider?.model).toBe('new-model');
    });

    it('轮询失败时保留当前配置且不抛异常', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        const findActive = vi
          .fn()
          .mockResolvedValueOnce(
            row({ id: '1', model: 'keep-model', isActive: true, enabled: true }),
          )
          .mockRejectedValueOnce(new Error('db unavailable'));
        const service = new AiSettingsService(createRepoMock({ findActive }), createConfigMock());
        await service.refresh();

        await expect(service.pollActiveProvider()).resolves.toBeUndefined();
        expect(service.activeProvider?.model).toBe('keep-model');
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('配置管理', () => {
    it('创建首个配置自动生效', async () => {
      const repo = createRepoMock({
        count: vi.fn().mockResolvedValue(0),
        create: vi
          .fn()
          .mockImplementation((data: unknown) =>
            Promise.resolve(row({ ...(data as Record<string, unknown>), id: '1' })),
          ),
      });
      const service = new AiSettingsService(repo, createConfigMock());
      await service.createProvider({
        name: '官方',
        apiKey: 'sk-new',
        model: 'claude-sonnet-5',
      } as never);
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-new' }), true);
    });

    it('创建时空白名称/API Key 被拒绝', async () => {
      const service = new AiSettingsService(createRepoMock(), createConfigMock());
      await expect(
        service.createProvider({ name: '   ', apiKey: 'sk-x' } as never),
      ).rejects.toThrow();
      await expect(
        service.createProvider({ name: '官方', apiKey: '   ' } as never),
      ).rejects.toThrow();
      expect(createMock).not.toHaveBeenCalled();
    });

    it('更新时 isActive=true 与 enabled=false 冲突被拒绝', async () => {
      const repo = createRepoMock({
        findById: vi.fn().mockResolvedValue(row({ enabled: true })),
      });
      const service = new AiSettingsService(repo, createConfigMock());
      await expect(
        service.updateProvider('1', { isActive: true, enabled: false } as never),
      ).rejects.toThrow();
      expect(repo.setActive).not.toHaveBeenCalled();
    });

    it('更新时 isActive=true 且原配置停用则需同时启用', async () => {
      const repo = createRepoMock({
        findById: vi.fn().mockResolvedValue(row({ enabled: false })),
        setActive: vi
          .fn()
          .mockImplementation((id: string) =>
            Promise.resolve(row({ id, isActive: true, enabled: false })),
          ),
        update: vi
          .fn()
          .mockImplementation((id: string, data: Record<string, unknown>) =>
            Promise.resolve(row({ id, isActive: true, enabled: true, ...data })),
          ),
      });
      const service = new AiSettingsService(repo, createConfigMock());
      const result = await service.updateProvider('1', { isActive: true, enabled: true } as never);
      expect(repo.setActive).toHaveBeenCalledWith('1');
      expect(repo.update).toHaveBeenCalledWith('1', { enabled: true });
      expect(result.isActive).toBe(true);
      expect(result.enabled).toBe(true);
    });

    it('已有生效配置时新建不自动生效', async () => {
      const repo = createRepoMock({
        count: vi.fn().mockResolvedValue(2),
        findActive: vi.fn().mockResolvedValue(row({ id: '1', isActive: true, enabled: true })),
        create: vi
          .fn()
          .mockImplementation((data: unknown) =>
            Promise.resolve(row({ ...(data as Record<string, unknown>), id: '2' })),
          ),
      });
      const service = new AiSettingsService(repo, createConfigMock());
      await service.createProvider({ name: '备用', apiKey: 'sk-new' } as never);
      expect(repo.create).toHaveBeenCalledWith(expect.anything(), false);
    });

    it('生效项被停用/无生效项时新建自动生效', async () => {
      const repo = createRepoMock({
        count: vi.fn().mockResolvedValue(1),
        findActive: vi.fn().mockResolvedValue(row({ id: '1', isActive: true, enabled: false })),
        create: vi
          .fn()
          .mockImplementation((data: unknown) =>
            Promise.resolve(row({ ...(data as Record<string, unknown>), id: '2' })),
          ),
      });
      const service = new AiSettingsService(repo, createConfigMock());
      await service.createProvider({ name: '新配置', apiKey: 'sk-new' } as never);
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ name: '新配置' }), true);
    });

    it('更新时掩码密钥不覆盖已有密钥', async () => {
      const repo = createRepoMock({
        findById: vi.fn().mockResolvedValue(row()),
        update: vi
          .fn()
          .mockImplementation((id: string, data: Record<string, unknown>) =>
            Promise.resolve(row({ ...data, id })),
          ),
      });
      const service = new AiSettingsService(repo, createConfigMock());
      await service.updateProvider('1', { apiKey: 'sk-te••••••••1234' } as never);
      expect(repo.update).not.toHaveBeenCalled();

      await service.updateProvider('1', { apiKey: 'sk-real-key' } as never);
      expect(repo.update).toHaveBeenCalledWith('1', { apiKey: 'sk-real-key' });
    });

    it('激活已保存配置并切换生效标记', async () => {
      const repo = createRepoMock({
        findById: vi.fn().mockResolvedValue(row({ isActive: false })),
        setActive: vi
          .fn()
          .mockImplementation((id: string) => Promise.resolve(row({ id, isActive: true }))),
      });
      const service = new AiSettingsService(repo, createConfigMock());
      const result = await service.activateProvider('1');
      expect(repo.setActive).toHaveBeenCalledWith('1');
      expect(result.isActive).toBe(true);
    });

    it('停用的配置不能设为生效', async () => {
      const repo = createRepoMock({
        findById: vi.fn().mockResolvedValue(row({ enabled: false })),
      });
      const service = new AiSettingsService(repo, createConfigMock());
      await expect(service.activateProvider('1')).rejects.toThrow();
    });

    it('删除生效配置后自动提升最早的启用配置', async () => {
      const repo = createRepoMock({
        findById: vi.fn().mockResolvedValue(row({ isActive: true })),
        findFirstEnabled: vi.fn().mockResolvedValue(row({ id: '2', isActive: false })),
        setActive: vi.fn().mockResolvedValue(row({ id: '2', isActive: true })),
      });
      const service = new AiSettingsService(repo, createConfigMock());
      await service.deleteProvider('1');
      expect(repo.delete).toHaveBeenCalledWith('1');
      expect(repo.setActive).toHaveBeenCalledWith('2');
    });
  });

  describe('连通性测试', () => {
    it('测试成功返回延迟并记录 ok', async () => {
      createMock.mockResolvedValue({ model: 'claude-sonnet-5', content: [] });
      const repo = createRepoMock({
        findById: vi.fn().mockResolvedValue(row()),
        setTestResult: vi.fn(),
      });
      const service = new AiSettingsService(repo, createConfigMock());
      const result = await service.testSavedProvider('1');
      expect(result.success).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(repo.setTestResult).toHaveBeenCalledWith('1', 'ok', null);
    });

    it('测试失败转为可读结果并记录 error，不抛异常', async () => {
      createMock.mockRejectedValue(new AnthropicMock.APIError('Invalid API key', 401));
      const repo = createRepoMock({
        findById: vi.fn().mockResolvedValue(row()),
        setTestResult: vi.fn(),
      });
      const service = new AiSettingsService(repo, createConfigMock());
      const result = await service.testSavedProvider('1');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid API key');
      expect(repo.setTestResult).toHaveBeenCalledWith('1', 'error', expect.any(String));
    });

    it('临时配置测试不落库', async () => {
      createMock.mockResolvedValue({ model: 'claude-sonnet-5', content: [] });
      const repo = createRepoMock();
      const service = new AiSettingsService(repo, createConfigMock());
      const result = await service.testAdHoc({
        provider: 'anthropic',
        apiKey: 'sk-temp',
        model: 'claude-sonnet-5',
      } as never);
      expect(result.success).toBe(true);
      expect(repo.setTestResult).not.toHaveBeenCalled();
    });
  });
});
