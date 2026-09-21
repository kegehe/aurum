import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SafeUrlService } from '../../common/security/safe-url.service';
import { IngestionJobStatus, IngestionJobType } from '../../common/constants/enums';
import { IngestionService } from './ingestion.service';

// 保留 undici 的 Agent/ProxyAgent 等真实导出（SafeUrlService 依赖），仅 mock fetch，避免下载路径真实联网
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn() };
});
// file-type 默认导出 fromFile 用于魔数识别，替换为可控 mock
vi.mock('file-type', async (importOriginal) => {
  const actual = await importOriginal<typeof import('file-type')>();
  return { ...actual, default: { fromFile: vi.fn() } };
});

import { fetch } from 'undici';
import fileType from 'file-type';

const mockFetch = vi.mocked(fetch);
const mockFileTypeFromFile = vi.mocked(fileType.fromFile);

/** 构造 IngestionService，可用 overrides 覆盖任意依赖 */
function createService(
  options: {
    prisma?: object;
    jobRepo?: object;
    sourceRepo?: object;
    resourceRepo?: object;
    linkMetadataConnector?: object;
    locatorHealthChecker?: object;
    civitaiConnector?: object;
    githubConnector?: object;
    feedConnector?: object;
    storage?: object;
    fileRepo?: object;
    scheduler?: object;
    config?: object;
  } = {},
) {
  const service = new IngestionService(
    (options.prisma ?? {}) as never,
    (options.jobRepo ?? {}) as never,
    (options.sourceRepo ?? {}) as never,
    (options.resourceRepo ?? {}) as never,
    new SafeUrlService(),
    (options.linkMetadataConnector ?? {}) as never,
    (options.locatorHealthChecker ?? {}) as never,
    (options.civitaiConnector ?? {}) as never,
    (options.githubConnector ?? {}) as never,
    (options.feedConnector ?? {}) as never,
    (options.storage ?? {}) as never,
    (options.fileRepo ?? {}) as never,
    (options.scheduler ?? { enqueue: vi.fn().mockResolvedValue(undefined) }) as never,
    (options.config ?? { get: vi.fn().mockReturnValue(100) }) as never,
  );
  return service;
}

/**
 * sync_source 测试共用的 prisma mock。
 * 默认：所有资源都是新建（无 existing locator），下载路径因网络错误失败。
 */
function makeSyncPrisma() {
  return {
    resourceLocator: {
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    resource: {
      findFirst: vi.fn().mockResolvedValue(null), // 查重
      create: vi.fn().mockImplementation(async () => ({
        id: 'new-resource-id',
        locators: [{ id: 'download-loc-1', locatorType: 'download' }],
      })),
    },
    resourceFile: {
      findUnique: vi.fn().mockResolvedValue(null), // 无原文件
    },
    ingestionJob: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }), // touchJob 心跳
    },
    $transaction: vi.fn().mockImplementation(async (callback) => callback({})),
  };
}

/** 构造带 sourceRepo.updateSyncResult 的常用 sourceRepo */
function makeSourceRepo(overrides: Record<string, unknown> = {}) {
  return {
    findById: vi.fn().mockResolvedValue({
      id: 'source-1',
      name: 'Test',
      enabled: true,
      sourceType: 'civitai',
      config: JSON.stringify({ sort: 'Newest', period: 'Day', nsfw: false }),
    }),
    update: vi.fn().mockResolvedValue({}),
    updateSyncResult: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

/**
 * 后台同步（fire-and-forget）会让 runNextJob 先返回，实际的 upsert/下载/完成
 * 在事件循环的后续轮次执行。此函数等待后台链路收敛：
 * - 纯 mock 链路（fetch 直接 reject）只需数个事件循环轮次
 * - 下载成功路径涉及真实文件流（createWriteStream + fs flush），需要真实计时让出 I/O
 * 用 setTimeout 让出宏任务，比 setImmediate 更能覆盖文件 I/O 完成回调。
 */
async function settleAsync(rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

describe('IngestionService source URL policy', () => {
  it('accepts a URL under the configured source base URL', async () => {
    const prisma = { source: { findUnique: vi.fn() } };
    const sourceRepo = {
      findById: vi.fn().mockResolvedValue({
        id: 'source-1',
        enabled: true,
        allowedModes: 'link_only,metadata_only',
        baseUrl: 'https://example.com/assets',
      }),
    };
    const service = createService({ prisma, sourceRepo });

    await expect(
      (
        service as unknown as {
          assertLinkImportAllowed: (sourceId: string, url: string) => Promise<void>;
        }
      ).assertLinkImportAllowed('source-1', 'https://example.com/assets/icons/logo.svg'),
    ).resolves.toBeUndefined();
  });

  it('treats a trailing slash on the source base URL as equivalent', async () => {
    const sourceRepo = {
      findById: vi.fn().mockResolvedValue({
        id: 'source-1',
        enabled: true,
        allowedModes: 'link_only,metadata_only',
        baseUrl: 'https://example.com/assets/',
      }),
    };
    const service = createService({ sourceRepo });

    await expect(
      (
        service as unknown as {
          assertLinkImportAllowed: (sourceId: string, url: string) => Promise<void>;
        }
      ).assertLinkImportAllowed('source-1', 'https://example.com/assets'),
    ).resolves.toBeUndefined();
  });

  it('rejects a URL from a different origin or path', async () => {
    const sourceRepo = {
      findById: vi.fn().mockResolvedValue({
        id: 'source-1',
        enabled: true,
        allowedModes: 'link_only,metadata_only',
        baseUrl: 'https://example.com/assets',
      }),
    };
    const service = createService({ sourceRepo });
    const internalService = service as unknown as {
      assertLinkImportAllowed: (sourceId: string, url: string) => Promise<void>;
    };

    await expect(
      internalService.assertLinkImportAllowed('source-1', 'https://other.example/assets/logo.svg'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      internalService.assertLinkImportAllowed('source-1', 'https://example.com/articles/post'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechecks the final redirect URL before creating a resource', async () => {
    const jobRepo = {
      claimNext: vi.fn().mockResolvedValue({
        id: 'job-1',
        leaseToken: 'lease-1',
        jobType: IngestionJobType.import_url,
        request: JSON.stringify({
          url: 'https://example.com/assets/redirect',
          sourceId: 'source-1',
        }),
      }),
      fail: vi.fn().mockResolvedValue(true),
    };
    const sourceRepo = {
      findById: vi.fn().mockResolvedValue({
        id: 'source-1',
        enabled: true,
        allowedModes: 'link_only',
        baseUrl: 'https://example.com/assets',
      }),
    };
    const resourceRepo = { findByIdentityUrl: vi.fn() };
    const connector = {
      type: 'link_metadata',
      inspect: vi.fn().mockResolvedValue({
        requestedUrl: 'https://example.com/assets/redirect',
        finalUrl: 'https://outside.example/resource',
        canonicalUrl: 'https://outside.example/resource',
      }),
    };
    const service = createService({
      jobRepo,
      sourceRepo,
      resourceRepo,
      linkMetadataConnector: connector,
    });

    await service.runNextJob();

    expect(resourceRepo.findByIdentityUrl).not.toHaveBeenCalled();
    expect(jobRepo.fail).toHaveBeenCalledWith(
      'job-1',
      'lease-1',
      'invalid_remote_resource',
      'URL is outside the configured source base URL',
    );
  });
});

describe('IngestionService retryJob', () => {
  it('returns the existing active job instead of violating active idempotency', async () => {
    const activeJob = { id: 'active-job', status: IngestionJobStatus.pending };
    const jobRepo = {
      findById: vi.fn().mockResolvedValue({
        id: 'failed-job',
        status: IngestionJobStatus.failed,
        idempotencyKey: 'same-request',
      }),
      findActiveByIdempotencyKey: vi.fn().mockResolvedValue(activeJob),
      retryIfRetryable: vi.fn(),
    };
    const service = createService({ jobRepo });

    await expect(service.retryJob('failed-job')).resolves.toEqual(activeJob);
    expect(jobRepo.retryIfRetryable).not.toHaveBeenCalled();
  });

  it('returns the concurrent active job when its conditional retry loses the race', async () => {
    const activeJob = { id: 'failed-job', status: IngestionJobStatus.pending };
    const jobRepo = {
      findById: vi.fn().mockResolvedValue({
        id: 'failed-job',
        status: IngestionJobStatus.failed,
        idempotencyKey: 'same-request',
      }),
      findActiveByIdempotencyKey: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(activeJob),
      retryIfRetryable: vi.fn().mockResolvedValue(null),
    };
    const service = createService({ jobRepo });

    await expect(service.retryJob('failed-job')).resolves.toEqual(activeJob);
    expect(jobRepo.retryIfRetryable).toHaveBeenCalledWith('failed-job');
  });
});

describe('IngestionService deleteJob', () => {
  it('deletes a terminal job record', async () => {
    const jobRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'job-1', status: IngestionJobStatus.completed }),
      deleteTerminal: vi.fn().mockResolvedValue(true),
    };
    const service = createService({ jobRepo });

    await expect(service.deleteJob('job-1')).resolves.toEqual({ id: 'job-1', deleted: true });
    expect(jobRepo.deleteTerminal).toHaveBeenCalledWith('job-1');
  });

  it('rejects deleting a missing job', async () => {
    const jobRepo = { findById: vi.fn().mockResolvedValue(null), deleteTerminal: vi.fn() };
    const service = createService({ jobRepo });

    await expect(service.deleteJob('missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(jobRepo.deleteTerminal).not.toHaveBeenCalled();
  });

  it('rejects deleting an active (pending/processing) job', async () => {
    const jobRepo = { findById: vi.fn(), deleteTerminal: vi.fn() };
    const service = createService({ jobRepo });

    jobRepo.findById.mockResolvedValueOnce({ id: 'pending', status: IngestionJobStatus.pending });
    await expect(service.deleteJob('pending')).rejects.toBeInstanceOf(BadRequestException);

    jobRepo.findById.mockResolvedValueOnce({
      id: 'running',
      status: IngestionJobStatus.processing,
    });
    await expect(service.deleteJob('running')).rejects.toBeInstanceOf(BadRequestException);
    expect(jobRepo.deleteTerminal).not.toHaveBeenCalled();
  });
});

describe('IngestionService clearJobs', () => {
  it('deletes all terminal job records and returns the count', async () => {
    const jobRepo = { clearTerminal: vi.fn().mockResolvedValue(7) };
    const service = createService({ jobRepo });

    await expect(service.clearJobs()).resolves.toEqual({ deleted: 7 });
    expect(jobRepo.clearTerminal).toHaveBeenCalledTimes(1);
  });
});

describe('IngestionService getStats', () => {
  it('delegates status counts to the repository', async () => {
    const stats = {
      pending: 3,
      processing: 1,
      completed: 10,
      failed: 2,
      canceled: 0,
    };
    const jobRepo = { stats: vi.fn().mockResolvedValue(stats) };
    const service = createService({ jobRepo });

    await expect(service.getStats()).resolves.toEqual(stats);
    expect(jobRepo.stats).toHaveBeenCalledTimes(1);
  });
});

describe('IngestionService createLinkImport', () => {
  it('rejects an unknown category before creating an ingestion task', async () => {
    const jobRepo = {
      findActiveByIdempotencyKey: vi.fn(),
      create: vi.fn(),
    };
    const prisma = {
      category: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const service = createService({ prisma, jobRepo });

    await expect(
      service.createLinkImport({
        url: 'https://example.com/resource',
        categoryId: '0d21f2f2-1fa0-4db0-a8b7-f31d23f220b0',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(jobRepo.create).not.toHaveBeenCalled();
  });
});

describe('IngestionService existing link reuse', () => {
  it('merges explicit title and category into an existing link resource', async () => {
    const jobRepo = {
      claimNext: vi.fn().mockResolvedValue({
        id: 'job-1',
        leaseToken: 'lease-1',
        jobType: IngestionJobType.import_url,
        request: JSON.stringify({
          url: 'https://example.com/resource',
          title: 'Updated title',
          categoryId: 'category-1',
        }),
      }),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn(),
    };
    const resourceRepo = {
      findByIdentityUrl: vi.fn().mockResolvedValue({
        resourceId: 'resource-1',
        resource: { deletedAt: new Date('2026-07-01T00:00:00.000Z') },
      }),
    };
    const prisma = {
      resource: { update: vi.fn().mockResolvedValue({ id: 'resource-1' }) },
    };
    const connector = {
      type: 'link_metadata',
      inspect: vi.fn().mockResolvedValue({
        finalUrl: 'https://example.com/resource',
        canonicalUrl: 'https://example.com/resource',
      }),
    };
    const service = createService({
      prisma,
      jobRepo,
      resourceRepo,
      linkMetadataConnector: connector,
    });

    await service.runNextJob();

    expect(prisma.resource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'resource-1' },
        data: expect.objectContaining({
          deletedAt: null,
          title: 'Updated title',
          category: { connect: { id: 'category-1' } },
        }),
      }),
    );
    expect(jobRepo.complete).toHaveBeenCalledWith(
      'job-1',
      'lease-1',
      'resource-1',
      JSON.stringify({ canonicalUrl: 'https://example.com/resource' }),
    );
  });
});

describe('IngestionService uses SourceRepository', () => {
  it('delegates source lookup to SourceRepository instead of Prisma directly', async () => {
    const sourceRepo = {
      findById: vi.fn().mockResolvedValue({
        id: 'source-1',
        enabled: true,
        allowedModes: 'link_only',
        baseUrl: 'https://example.com',
      }),
    };
    const service = createService({ sourceRepo });

    await expect(
      (
        service as unknown as {
          assertLinkImportAllowed: (sourceId: string, url: string) => Promise<void>;
        }
      ).assertLinkImportAllowed('source-1', 'https://example.com/page'),
    ).resolves.toBeUndefined();

    expect(sourceRepo.findById).toHaveBeenCalledWith('source-1');
  });
});

describe('IngestionService sync_source', () => {
  beforeEach(() => {
    // 默认让下载路径网络失败 → 单项标记 failed，但整页同步仍完成
    mockFetch.mockRejectedValue(new Error('network error'));
    mockFileTypeFromFile.mockReset();
    // 下载路径的逐跳 SSRF 校验依赖真实 DNS（SafeUrlService.resolvePublicHost），
    // mock 掉保证测试在离线环境也确定性通过
    vi.spyOn(SafeUrlService.prototype, 'resolvePublicHost').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ]);
  });

  it('does not start a remote file download after its job was canceled', async () => {
    const jobRepo = { isProcessing: vi.fn().mockResolvedValue(false) };
    const prisma = { resourceLocator: { update: vi.fn() } };
    const service = createService({ prisma, jobRepo });
    const internalService = service as unknown as {
      downloadRemoteFile: (
        resourceId: string,
        locatorId: string,
        remote: object,
        jobControl: { id: string; leaseToken: string },
      ) => Promise<'downloaded' | 'failed'>;
    };

    await expect(
      internalService.downloadRemoteFile(
        'resource-1',
        'locator-1',
        {
          externalId: 'remote-1',
          url: 'https://example.com/file.jpg',
          resourceType: 'image',
          mimeType: 'image/jpeg',
        },
        { id: 'job-1', leaseToken: 'lease-1' },
      ),
    ).rejects.toThrow();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects media content that only pretends to be an image through its response header', async () => {
    const prisma = { resourceLocator: { update: vi.fn().mockResolvedValue({}) } };
    const storage = { generateKey: vi.fn(), put: vi.fn() };
    const service = createService({ prisma, storage });
    const internalService = service as unknown as {
      downloadRemoteFile: (
        resourceId: string,
        locatorId: string,
        remote: object,
      ) => Promise<'downloaded' | 'failed'>;
    };
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: Buffer.from('<html>not an image</html>') })
        .mockResolvedValueOnce({ done: true }),
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'image/jpeg']]),
      body: { getReader: () => reader },
    } as unknown as Response);
    mockFileTypeFromFile.mockResolvedValue(null);

    await expect(
      internalService.downloadRemoteFile('resource-1', 'locator-1', {
        externalId: 'remote-1',
        url: 'https://example.com/file.jpg',
        resourceType: 'image',
        mimeType: 'image/jpeg',
      }),
    ).resolves.toBe('failed');

    expect(storage.put).not.toHaveBeenCalled();
    expect(prisma.resourceLocator.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastError: expect.stringContaining('not a recognizable image file'),
        }),
      }),
    );
  });

  it('runs a complete sync_source job – fetches page, upserts resources, persists cursor', async () => {
    const remoteItems = [
      {
        externalId: '12345',
        url: 'https://image.civitai.com/abc.jpeg',
        canonicalUrl: 'https://civitai.com/posts/67890',
        resourceType: 'image',
        mimeType: 'image/jpeg',
        title: 'SDXL - #12345',
        description: 'a beautiful landscape',
        authorName: 'testartist',
        authorUrl: 'https://civitai.com/user/testartist',
        publisher: 'Civitai',
        width: 1024,
        height: 768,
        externalCreatedAt: new Date('2024-01-15T10:30:00Z'),
        rawMetadata: { id: 12345, nsfwLevel: 0 },
        additionalLocators: [
          { locatorType: 'page', url: 'https://civitai.com/posts/67890' },
          { locatorType: 'api', url: 'https://civitai.com/api/v1/images/12345' },
        ],
      },
      {
        externalId: '67890',
        url: 'https://image.civitai.com/def.png',
        canonicalUrl: 'https://civitai.com/posts/11111',
        resourceType: 'image',
        mimeType: 'image/png',
        title: 'Civitai Image #67890',
        description: null,
        authorName: null,
        authorUrl: null,
        publisher: 'Civitai',
        width: null,
        height: null,
        externalCreatedAt: null,
        rawMetadata: { id: 67890 },
        additionalLocators: [],
      },
    ];

    const prisma = makeSyncPrisma();
    // item 1 (12345): 新建；item 2 (67890): 已存在
    (prisma.resourceLocator.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ resourceId: 'existing-resource-id', id: 'existing-loc-id' })
      .mockResolvedValue(null); // 已存在资源的 download locator 查找

    const jobRepo = {
      claimNext: vi.fn().mockResolvedValue({
        id: 'sync-job-1',
        leaseToken: 'lease-sync-1',
        jobType: IngestionJobType.sync_source,
        request: JSON.stringify({ sourceId: 'source-civitai', cursor: null }),
      }),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue(true),
    };

    const sourceRepo = makeSourceRepo({
      findById: vi.fn().mockResolvedValue({
        id: 'source-civitai',
        name: 'Civitai Source',
        enabled: true,
        sourceType: 'civitai',
        config: JSON.stringify({ sort: 'Newest', period: 'Day', nsfw: false }),
      }),
    });

    const civitaiConnector = {
      type: 'civitai' as const,
      inspect: vi.fn(),
      sync: vi.fn().mockResolvedValue({
        items: remoteItems,
        nextCursor: 'cursor-page-2',
        totalItems: 2000,
      }),
    };

    const service = createService({ prisma, jobRepo, sourceRepo, civitaiConnector });

    const result = await service.runNextJob();
    await settleAsync();

    expect(result).toBe(true);
    expect(civitaiConnector.sync).toHaveBeenCalledWith({
      cursor: null,
      limit: undefined,
      filters: { sort: 'Newest', period: 'Day', nsfw: false },
    });

    // 只应为新条目创建资源
    expect(prisma.resource.create).toHaveBeenCalledTimes(1);
    const createCall = (prisma.resource.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.data.title).toBe('SDXL - #12345');
    expect(createCall.data.acquisitionMode).toBe('metadata_only');
    expect(createCall.data.mimeType).toBe('image/jpeg');
    expect(createCall.data.extension).toBe('jpeg');
    expect(createCall.data.width).toBe(1024);
    expect(createCall.data.height).toBe(768);
    expect(createCall.data.author).toBe('testartist');
    expect(createCall.data.locators.create).toHaveLength(3); // download + page + api
    expect(createCall.data.locators.create[0].externalId).toBe('12345');
    expect(createCall.data.locators.create[0].identityUrl).toBe('civitai://image/12345');
    expect(createCall.data.locators.create[0].isPrimary).toBe(true);
    expect(createCall.data.locators.create[1].locatorType).toBe('page');
    expect(createCall.data.locators.create[2].locatorType).toBe('api');
    expect(createCall.data.provenance.create.connectorType).toBe('civitai');
    expect(createCall.data.provenance.create.authorName).toBe('testartist');
    expect(createCall.data.provenance.create.authorUrl).toBe('https://civitai.com/user/testartist');

    // cursor 写回 config，同步结果标记为 completed
    expect(sourceRepo.update).toHaveBeenCalledWith('source-civitai', {
      config: JSON.stringify({
        sort: 'Newest',
        period: 'Day',
        nsfw: false,
        cursor: 'cursor-page-2',
      }),
    });
    expect(sourceRepo.updateSyncResult).toHaveBeenCalledWith('source-civitai', {
      lastSyncedAt: expect.any(Date),
      lastSyncStatus: 'completed',
      lastSyncError: null,
    });

    // 任务完成，且下载失败被记录到 locator
    expect(jobRepo.complete).toHaveBeenCalledWith(
      'sync-job-1',
      'lease-sync-1',
      null,
      expect.stringContaining('"failedCount":2'),
    );
    expect(prisma.resourceLocator.update).toHaveBeenCalled();
  });

  it('handles config with sort/period/nsfw at top level (frontend format)', async () => {
    const prisma = makeSyncPrisma();
    (prisma.resourceLocator.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      resourceId: 'existing',
      id: 'loc-existing',
    });

    const jobRepo = {
      claimNext: vi.fn().mockResolvedValue({
        id: 'sync-job-2',
        leaseToken: 'lease-2',
        jobType: IngestionJobType.sync_source,
        request: JSON.stringify({ sourceId: 'source-1', cursor: 'cursor-5' }),
      }),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn(),
    };

    const sourceRepo = makeSourceRepo({
      findById: vi.fn().mockResolvedValue({
        id: 'source-1',
        name: 'Test',
        enabled: true,
        sourceType: 'civitai',
        config: JSON.stringify({ sort: 'Most Reactions', period: 'Month', nsfw: true }),
      }),
    });

    const civitaiConnector = {
      type: 'civitai' as const,
      inspect: vi.fn(),
      sync: vi.fn().mockResolvedValue({ items: [], nextCursor: null, totalItems: 0 }),
    };

    const service = createService({ prisma, jobRepo, sourceRepo, civitaiConnector });

    await service.runNextJob();
    await settleAsync();

    expect(civitaiConnector.sync).toHaveBeenCalledWith({
      cursor: 'cursor-5',
      limit: undefined,
      filters: { sort: 'Most Reactions', period: 'Month', nsfw: true },
    });
  });

  it('falls back to config.filters when nested format is used', async () => {
    const prisma = makeSyncPrisma();
    (prisma.resourceLocator.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      resourceId: 'existing',
      id: 'loc-existing',
    });

    const jobRepo = {
      claimNext: vi.fn().mockResolvedValue({
        id: 'sync-job-3',
        leaseToken: 'lease-3',
        jobType: IngestionJobType.sync_source,
        request: JSON.stringify({ sourceId: 'source-1', cursor: null }),
      }),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn(),
    };

    const sourceRepo = makeSourceRepo({
      findById: vi.fn().mockResolvedValue({
        id: 'source-1',
        name: 'Test',
        enabled: true,
        sourceType: 'civitai',
        config: JSON.stringify({
          filters: { sort: 'Newest', period: 'AllTime', nsfw: false },
          limit: 50,
        }),
      }),
    });

    const civitaiConnector = {
      type: 'civitai' as const,
      inspect: vi.fn(),
      sync: vi.fn().mockResolvedValue({ items: [], nextCursor: null, totalItems: 0 }),
    };

    const service = createService({ prisma, jobRepo, sourceRepo, civitaiConnector });

    await service.runNextJob();
    await settleAsync();

    expect(civitaiConnector.sync).toHaveBeenCalledWith({
      cursor: null,
      limit: 50,
      filters: { sort: 'Newest', period: 'AllTime', nsfw: false },
    });
  });

  it('ignores a non-numeric config.limit instead of passing NaN to the connector', async () => {
    const prisma = makeSyncPrisma();
    (prisma.resourceLocator.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      resourceId: 'existing',
      id: 'loc-existing',
    });

    const jobRepo = {
      claimNext: vi.fn().mockResolvedValue({
        id: 'sync-job-limitstring',
        leaseToken: 'lease-limitstring',
        jobType: IngestionJobType.sync_source,
        request: JSON.stringify({ sourceId: 'source-1', cursor: null }),
      }),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn(),
    };

    const sourceRepo = makeSourceRepo({
      findById: vi.fn().mockResolvedValue({
        id: 'source-1',
        name: 'Test',
        enabled: true,
        sourceType: 'civitai',
        // 历史/手工编辑的 config 可能是字符串值
        config: JSON.stringify({ sort: 'Newest', period: 'Day', nsfw: false, limit: '50' }),
      }),
    });

    const civitaiConnector = {
      type: 'civitai' as const,
      inspect: vi.fn(),
      sync: vi.fn().mockResolvedValue({ items: [], nextCursor: null, totalItems: 0 }),
    };

    const service = createService({ prisma, jobRepo, sourceRepo, civitaiConnector });

    await service.runNextJob();
    await settleAsync();

    expect(civitaiConnector.sync).toHaveBeenCalledWith({
      cursor: null,
      limit: undefined,
      filters: { sort: 'Newest', period: 'Day', nsfw: false },
    });
  });

  it('rejects sync for non-sync source type', async () => {
    const sourceRepo = makeSourceRepo({
      findById: vi.fn().mockResolvedValue({
        id: 'source-1',
        enabled: true,
        sourceType: 'link_metadata',
        config: null,
      }),
    });
    const service = createService({ sourceRepo });

    await expect(service.createSourceSync('source-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('continues syncing remaining items when one upsert fails', async () => {
    const prisma = makeSyncPrisma();
    (prisma.resourceLocator.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null) // item 1: new（create 将 P2002）
      .mockResolvedValueOnce(null); // item 2: new（create 成功）
    (prisma.resource.create as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint', {
          code: 'P2002',
          clientVersion: '5.0',
        }),
      )
      .mockResolvedValueOnce({
        id: 'resource-2',
        locators: [{ id: 'loc-2', locatorType: 'download' }],
      });

    const jobRepo = {
      claimNext: vi.fn().mockResolvedValue({
        id: 'sync-job-4',
        leaseToken: 'lease-4',
        jobType: IngestionJobType.sync_source,
        request: JSON.stringify({ sourceId: 'source-1', cursor: null }),
      }),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue(true),
    };

    const sourceRepo = makeSourceRepo();

    const civitaiConnector = {
      type: 'civitai' as const,
      inspect: vi.fn(),
      sync: vi.fn().mockResolvedValue({
        items: [
          {
            externalId: '1',
            url: 'https://example.com/1.jpg',
            canonicalUrl: 'https://example.com/posts/1',
            resourceType: 'image',
            mimeType: 'image/jpeg',
            title: 'Item 1',
            description: null,
            authorName: null,
            authorUrl: null,
            publisher: 'Test',
            width: null,
            height: null,
            externalCreatedAt: null,
            rawMetadata: {},
            additionalLocators: [],
          },
          {
            externalId: '2',
            url: 'https://example.com/2.jpg',
            canonicalUrl: 'https://example.com/posts/2',
            resourceType: 'image',
            mimeType: 'image/jpeg',
            title: 'Item 2',
            description: null,
            authorName: null,
            authorUrl: null,
            publisher: 'Test',
            width: null,
            height: null,
            externalCreatedAt: null,
            rawMetadata: {},
            additionalLocators: [],
          },
        ],
        nextCursor: 'cursor-next',
        totalItems: 2,
      }),
    };

    const service = createService({ prisma, jobRepo, sourceRepo, civitaiConnector });

    await service.runNextJob();
    await settleAsync();

    // 两条都尝试过（P2002 后重查 locator 也算一次 findFirst）
    expect(prisma.resource.create).toHaveBeenCalledTimes(2);
    // 任务仍应完成，cursor 照常持久化（保留原有 filters）
    expect(jobRepo.complete).toHaveBeenCalled();
    expect(jobRepo.fail).not.toHaveBeenCalled();
    expect(sourceRepo.update).toHaveBeenCalledWith('source-1', {
      config: JSON.stringify({ sort: 'Newest', period: 'Day', nsfw: false, cursor: 'cursor-next' }),
    });
  });

  it('does not download files for sources that require review', async () => {
    const prisma = makeSyncPrisma();
    (prisma.resourceLocator.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.resource.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'new-resource-id',
      locators: [{ id: 'loc-download', locatorType: 'download' }],
    });

    const jobRepo = {
      claimNext: vi.fn().mockResolvedValue({
        id: 'sync-job-review',
        leaseToken: 'lease-review',
        jobType: IngestionJobType.sync_source,
        request: JSON.stringify({ sourceId: 'source-1', cursor: null }),
      }),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue(true),
    };

    const sourceRepo = makeSourceRepo({
      findById: vi.fn().mockResolvedValue({
        id: 'source-1',
        name: 'Review Source',
        enabled: true,
        sourceType: 'civitai',
        requiresReview: true,
        config: JSON.stringify({}),
      }),
    });

    const civitaiConnector = {
      type: 'civitai' as const,
      inspect: vi.fn(),
      sync: vi.fn().mockResolvedValue({
        items: [
          {
            externalId: '1',
            url: 'https://example.com/1.jpg',
            canonicalUrl: 'https://example.com/posts/1',
            resourceType: 'image',
            mimeType: 'image/jpeg',
            title: 'Item',
            description: null,
            authorName: null,
            authorUrl: null,
            publisher: 'Test',
            width: null,
            height: null,
            externalCreatedAt: null,
            rawMetadata: {},
            additionalLocators: [],
          },
        ],
        nextCursor: 'next',
        totalItems: 1,
      }),
    };

    const storage = { generateKey: vi.fn(), put: vi.fn() };
    const scheduler = { enqueue: vi.fn() };

    const service = createService({
      prisma,
      jobRepo,
      sourceRepo,
      civitaiConnector,
      storage,
      scheduler,
    });

    await service.runNextJob();
    await settleAsync();

    // 需要人工审核的来源：只建元数据，不触发下载/入队处理
    expect(storage.put).not.toHaveBeenCalled();
    expect(scheduler.enqueue).not.toHaveBeenCalled();
    expect(jobRepo.complete).toHaveBeenCalledWith(
      'sync-job-review',
      'lease-review',
      null,
      expect.stringContaining('"skippedCount":1'),
    );
  });

  it('reuses a resource when the same content was synced by another source (identityUrl)', async () => {
    const prisma = makeSyncPrisma();
    // 第一次 findFirst: 本来源无该 externalId → null；第二次 findFirst: identityUrl 已存在（其它来源）
    (prisma.resourceLocator.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ resourceId: 'existing-global-resource', id: 'global-loc-id' });
    // 已有原文件 → 跳过，不重复下载
    (prisma.resourceFile.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'file-1',
    });

    const jobRepo = {
      claimNext: vi.fn().mockResolvedValue({
        id: 'sync-job-global',
        leaseToken: 'lease-global',
        jobType: IngestionJobType.sync_source,
        request: JSON.stringify({ sourceId: 'source-b', cursor: null }),
      }),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue(true),
    };

    const sourceRepo = makeSourceRepo({
      findById: vi.fn().mockResolvedValue({
        id: 'source-b',
        name: 'Source B',
        enabled: true,
        sourceType: 'civitai',
        config: JSON.stringify({ sort: 'Newest', period: 'Day', nsfw: false }),
      }),
    });

    const civitaiConnector = {
      type: 'civitai' as const,
      inspect: vi.fn(),
      sync: vi.fn().mockResolvedValue({
        items: [
          {
            externalId: '77777',
            url: 'https://example.com/7.jpg',
            canonicalUrl: 'https://example.com/posts/7',
            resourceType: 'image',
            mimeType: 'image/jpeg',
            title: 'Shared Image',
            description: null,
            authorName: null,
            authorUrl: null,
            publisher: 'Civitai',
            width: null,
            height: null,
            externalCreatedAt: null,
            rawMetadata: {},
            additionalLocators: [],
          },
        ],
        nextCursor: 'next',
        totalItems: 1,
      }),
    };

    const storage = { generateKey: vi.fn(), put: vi.fn() };
    const scheduler = { enqueue: vi.fn() };

    const service = createService({
      prisma,
      jobRepo,
      sourceRepo,
      civitaiConnector,
      storage,
      scheduler,
    });

    await service.runNextJob();
    await settleAsync();

    // 不应创建新资源，也不应下载
    expect(prisma.resource.create).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    // 复用现有资源 → skipped
    expect(jobRepo.complete).toHaveBeenCalledWith(
      'sync-job-global',
      'lease-global',
      null,
      expect.stringContaining('"skippedCount":1'),
    );
  });

  it('downloads files successfully when the remote is reachable', async () => {
    const remote = {
      externalId: '88888',
      url: 'https://image.civitai.com/real.jpeg',
      canonicalUrl: 'https://civitai.com/posts/1',
      resourceType: 'image',
      mimeType: 'image/jpeg',
      title: 'Real Image',
      description: null,
      authorName: 'artist',
      authorUrl: null,
      publisher: 'Civitai',
      width: 512,
      height: 512,
      externalCreatedAt: null,
      rawMetadata: { id: 88888 },
      additionalLocators: [],
    };

    const prisma = makeSyncPrisma();
    (prisma.resourceLocator.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    // 事务内 mock：查重、更新资源、建原文件、更新 locator
    const tx = {
      resource: {
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({}),
      },
      resourceFile: { create: vi.fn().mockResolvedValue({}) },
      resourceLocator: { update: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction = vi
      .fn()
      .mockImplementation(async (callback: (t: object) => Promise<unknown>) => callback(tx));

    // 流式响应：4 字节后结束
    const bodyReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) })
        .mockResolvedValueOnce({ done: true }),
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-length', '4']]),
      body: { getReader: () => bodyReader },
    } as unknown as Response);
    mockFileTypeFromFile.mockResolvedValue({ mime: 'image/jpeg', ext: 'jpg' });

    const storage = {
      generateKey: vi.fn().mockReturnValue('originals/ab/cd/hash.original.jpg'),
      put: vi.fn().mockImplementation(async (_key: string, stream: NodeJS.ReadableStream) => {
        // 生产环境 LocalStorageDriver.put 会 pipe 消费流；这里 mock 不消费，
        // 需挂 error 监听，避免临时文件被 finally 的 unlink 抢先删除时读流报 ENOENT 未处理
        const readable = stream as import('node:stream').Readable;
        readable.on('error', () => undefined);
        readable.resume();
        return 'originals/ab/cd/hash.original.jpg';
      }),
    };
    const scheduler = { enqueue: vi.fn().mockResolvedValue(undefined) };

    const jobRepo = {
      claimNext: vi.fn().mockResolvedValue({
        id: 'sync-job-5',
        leaseToken: 'lease-5',
        jobType: IngestionJobType.sync_source,
        request: JSON.stringify({ sourceId: 'source-1', cursor: null }),
      }),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue(true),
    };

    const sourceRepo = makeSourceRepo();

    const civitaiConnector = {
      type: 'civitai' as const,
      inspect: vi.fn(),
      sync: vi.fn().mockResolvedValue({ items: [remote], nextCursor: 'next', totalItems: 1 }),
    };

    const service = createService({
      prisma,
      jobRepo,
      sourceRepo,
      civitaiConnector,
      storage,
      scheduler,
    });

    await service.runNextJob();
    await settleAsync();

    // 文件写入存储
    expect(storage.put).toHaveBeenCalledTimes(1);
    // 资源更新为 mirror_file + 原文件记录 + locator 状态
    expect(tx.resource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          acquisitionMode: 'mirror_file',
          sha256: expect.any(String),
          originalFilename: expect.stringMatching(/\.jpg$/),
        }),
      }),
    );
    expect(tx.resourceFile.create).toHaveBeenCalledTimes(1);
    expect(tx.resourceLocator.update).toHaveBeenCalledTimes(1);
    // 入队元数据检测（链式生成缩略图）
    expect(scheduler.enqueue).toHaveBeenCalledWith('detect_metadata', 'new-resource-id');
    // 同步完成，下载数 = 1、失败数 = 0
    expect(jobRepo.complete).toHaveBeenCalledWith(
      'sync-job-5',
      'lease-5',
      null,
      expect.stringContaining('"downloadedCount":1'),
    );
    expect(jobRepo.complete).toHaveBeenCalledWith(
      'sync-job-5',
      'lease-5',
      null,
      expect.stringContaining('"failedCount":0'),
    );
  });

  it('syncs multiple pages when config.maxPages is set, advancing cursor and aggregating counts', async () => {
    const prisma = makeSyncPrisma();
    (prisma.resourceLocator.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const jobRepo = {
      claimNext: vi.fn().mockResolvedValue({
        id: 'sync-job-multipage',
        leaseToken: 'lease-multipage',
        jobType: IngestionJobType.sync_source,
        request: JSON.stringify({ sourceId: 'source-1', cursor: null }),
      }),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue(true),
    };

    const sourceRepo = makeSourceRepo({
      findById: vi.fn().mockResolvedValue({
        id: 'source-1',
        name: 'Test',
        enabled: true,
        sourceType: 'civitai',
        maxConcurrency: 2,
        config: JSON.stringify({
          sort: 'Newest',
          period: 'Day',
          nsfw: false,
          limit: 50,
          maxPages: 2,
        }),
      }),
    });

    const pageItem = (externalId: string) => ({
      externalId,
      url: `https://example.com/${externalId}.jpg`,
      canonicalUrl: `https://example.com/posts/${externalId}`,
      resourceType: 'image',
      mimeType: 'image/jpeg',
      title: `Item ${externalId}`,
      description: null,
      authorName: null,
      authorUrl: null,
      publisher: 'Test',
      width: null,
      height: null,
      externalCreatedAt: null,
      rawMetadata: {},
      additionalLocators: [],
    });

    const civitaiConnector = {
      type: 'civitai' as const,
      inspect: vi.fn(),
      sync: vi
        .fn()
        .mockResolvedValueOnce({
          items: [pageItem('p1')],
          nextCursor: 'cursor-page-2',
          totalItems: 2,
        })
        .mockResolvedValueOnce({ items: [pageItem('p2')], nextCursor: null, totalItems: 2 }),
    };

    const service = createService({ prisma, jobRepo, sourceRepo, civitaiConnector });
    // 捕获每页传入 mapWithConcurrency 的并发数
    const concurrencySpy = vi.spyOn(
      service as unknown as { mapWithConcurrency: (...args: unknown[]) => Promise<unknown> },
      'mapWithConcurrency',
    );

    await service.runNextJob();
    await settleAsync();

    // 连续抓取两页，第 2 页的 cursor 取第 1 页的 nextCursor
    expect(civitaiConnector.sync).toHaveBeenCalledTimes(2);
    expect(civitaiConnector.sync).toHaveBeenNthCalledWith(1, {
      cursor: null,
      limit: 50,
      filters: { sort: 'Newest', period: 'Day', nsfw: false },
    });
    expect(civitaiConnector.sync).toHaveBeenNthCalledWith(2, {
      cursor: 'cursor-page-2',
      limit: 50,
      filters: { sort: 'Newest', period: 'Day', nsfw: false },
    });

    // 两页各新建一条资源，共 2 条
    expect(prisma.resource.create).toHaveBeenCalledTimes(2);

    // 下载并发来自来源 maxConcurrency（2），而不是默认 4
    const concurrencyArgs = concurrencySpy.mock.calls.map((call) => call[1]);
    expect(concurrencyArgs).toEqual([2, 2]);

    // cursor 写回最终值（最后一页 nextCursor = null → 已到结尾）
    expect(sourceRepo.update).toHaveBeenCalledWith('source-1', {
      config: JSON.stringify({
        sort: 'Newest',
        period: 'Day',
        nsfw: false,
        limit: 50,
        maxPages: 2,
        cursor: null,
      }),
    });
    expect(jobRepo.complete).toHaveBeenCalledWith(
      'sync-job-multipage',
      'lease-multipage',
      null,
      expect.stringContaining('"pagesProcessed":2'),
    );
    expect(jobRepo.complete).toHaveBeenCalledWith(
      'sync-job-multipage',
      'lease-multipage',
      null,
      expect.stringContaining('"itemsProcessed":2'),
    );
  });

  it('does not overwrite source config when it changed during the sync', async () => {
    const prisma = makeSyncPrisma();
    (prisma.resourceLocator.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const jobRepo = {
      claimNext: vi.fn().mockResolvedValue({
        id: 'sync-job-configrace',
        leaseToken: 'lease-configrace',
        jobType: IngestionJobType.sync_source,
        request: JSON.stringify({ sourceId: 'source-1', cursor: null }),
      }),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue(true),
    };

    const initialConfig = { sort: 'Newest', period: 'Day', nsfw: false };
    const changedConfig = {
      sort: 'Most Reactions',
      period: 'Day',
      nsfw: false,
      limit: 200,
      maxPages: 5,
    };
    // 第一次 findById（同步启动）返回旧配置；第二次（写回前）返回用户编辑后的配置
    const sourceRepo = makeSourceRepo({
      findById: vi
        .fn()
        .mockResolvedValueOnce({
          id: 'source-1',
          name: 'Test',
          enabled: true,
          sourceType: 'civitai',
          config: JSON.stringify(initialConfig),
        })
        .mockResolvedValueOnce({
          id: 'source-1',
          name: 'Test',
          enabled: true,
          sourceType: 'civitai',
          config: JSON.stringify(changedConfig),
        }),
    });

    const civitaiConnector = {
      type: 'civitai' as const,
      inspect: vi.fn(),
      sync: vi.fn().mockResolvedValue({ items: [], nextCursor: 'cursor-next', totalItems: 0 }),
    };

    const service = createService({ prisma, jobRepo, sourceRepo, civitaiConnector });

    await service.runNextJob();
    await settleAsync();

    // 保留用户编辑后的配置（含新筛选/limit/maxPages），不合并旧 cursor
    expect(sourceRepo.update).toHaveBeenCalledWith('source-1', {
      config: JSON.stringify(changedConfig),
    });
    expect(jobRepo.complete).toHaveBeenCalled();
  });

  it('dispatches rss sources to the feed connector with baseUrl as feedUrl', async () => {
    const prisma = makeSyncPrisma();
    (prisma.resourceLocator.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      resourceId: 'existing',
      id: 'loc-existing',
    });

    const jobRepo = {
      claimNext: vi.fn().mockResolvedValue({
        id: 'sync-rss-1',
        leaseToken: 'lease-rss-1',
        jobType: IngestionJobType.sync_source,
        request: JSON.stringify({ sourceId: 'source-rss', cursor: 'offset:50' }),
      }),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn(),
    };

    const sourceRepo = makeSourceRepo({
      findById: vi.fn().mockResolvedValue({
        id: 'source-rss',
        name: 'RSS Source',
        enabled: true,
        sourceType: 'rss',
        baseUrl: 'https://example.com/feed.xml',
        config: JSON.stringify({ cursor: 'offset:50' }),
      }),
    });

    const feedConnector = {
      type: 'rss' as const,
      inspect: vi.fn(),
      sync: vi.fn().mockResolvedValue({ items: [], nextCursor: null, totalItems: 0 }),
    };

    const service = createService({ prisma, jobRepo, sourceRepo, feedConnector });
    await service.runNextJob();
    await settleAsync();

    expect(feedConnector.sync).toHaveBeenCalledWith({
      cursor: 'offset:50',
      limit: undefined,
      filters: { feedUrl: 'https://example.com/feed.xml' },
    });
    expect(jobRepo.complete).toHaveBeenCalled();
  });

  it('keeps an explicit feedUrl from config.filters over the source baseUrl', async () => {
    const prisma = makeSyncPrisma();
    (prisma.resourceLocator.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      resourceId: 'existing',
      id: 'loc-existing',
    });

    const jobRepo = {
      claimNext: vi.fn().mockResolvedValue({
        id: 'sync-rss-2',
        leaseToken: 'lease-rss-2',
        jobType: IngestionJobType.sync_source,
        request: JSON.stringify({ sourceId: 'source-rss', cursor: null }),
      }),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn(),
    };

    const sourceRepo = makeSourceRepo({
      findById: vi.fn().mockResolvedValue({
        id: 'source-rss',
        name: 'RSS Source',
        enabled: true,
        sourceType: 'rss',
        baseUrl: 'https://example.com/feed.xml',
        config: JSON.stringify({ filters: { feedUrl: 'https://cdn.example.com/atom.xml' } }),
      }),
    });

    const feedConnector = {
      type: 'rss' as const,
      inspect: vi.fn(),
      sync: vi.fn().mockResolvedValue({ items: [], nextCursor: null, totalItems: 0 }),
    };

    const service = createService({ prisma, jobRepo, sourceRepo, feedConnector });
    await service.runNextJob();
    await settleAsync();

    expect(feedConnector.sync).toHaveBeenCalledWith({
      cursor: null,
      limit: undefined,
      filters: { feedUrl: 'https://cdn.example.com/atom.xml' },
    });
  });

  it('clamps sync maxPages to a safe ceiling', () => {
    const service = createService();
    const svc = service as unknown as { clampSyncMaxPages: (v: unknown) => number };
    expect(svc.clampSyncMaxPages(undefined)).toBe(1);
    expect(svc.clampSyncMaxPages('5')).toBe(5);
    expect(svc.clampSyncMaxPages(0)).toBe(1);
    expect(svc.clampSyncMaxPages(200)).toBe(50);
  });

  it('falls back download concurrency when source value is missing and caps it', () => {
    const service = createService();
    const svc = service as unknown as {
      resolveDownloadConcurrency: (v: number | null | undefined) => number;
    };
    expect(svc.resolveDownloadConcurrency(undefined)).toBe(4);
    expect(svc.resolveDownloadConcurrency(0)).toBe(4);
    // 历史 DB 默认值 1 视为"未配置"→ 内置默认 4（避免存量来源并发从 4 掉到 1）
    expect(svc.resolveDownloadConcurrency(1)).toBe(4);
    expect(svc.resolveDownloadConcurrency(3)).toBe(3);
    expect(svc.resolveDownloadConcurrency(999)).toBe(20);
  });
});

describe('IngestionService scheduleAutoSyncs', () => {
  const HOUR = 3_600_000;

  /** 构造一组可被 findById 按 id 命中的来源（默认启用且为 civitai，可覆盖） */
  function makeSourceSet(
    sources: Array<{
      id: string;
      enabled?: boolean;
      sourceType?: string;
      autoSyncIntervalHours?: number | null;
      lastSyncedAt?: Date | null;
      config?: string | null;
    }>,
  ) {
    const normalized = sources.map((s) => ({
      enabled: true,
      sourceType: 'civitai',
      config: null,
      ...s,
    }));
    return makeSourceRepo({
      findAutoSyncEnabled: vi.fn().mockResolvedValue(normalized),
      findById: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(normalized.find((s) => s.id === id) ?? null),
        ),
    });
  }

  it('creates sync jobs only for due and enabled sources', async () => {
    const now = Date.now();
    const sourceRepo = makeSourceSet([
      // 从未同步 → 立即到期
      { id: 's-never', autoSyncIntervalHours: 6, lastSyncedAt: null },
      // 7 小时前同步过，间隔 6 小时 → 到期
      { id: 's-due', autoSyncIntervalHours: 6, lastSyncedAt: new Date(now - 7 * HOUR) },
      // 1 小时前同步过，间隔 6 小时 → 未到期
      { id: 's-fresh', autoSyncIntervalHours: 6, lastSyncedAt: new Date(now - 1 * HOUR) },
      // 禁用 → 跳过
      { id: 's-disabled', enabled: false, autoSyncIntervalHours: 6, lastSyncedAt: null },
      // 未配置间隔 → 跳过
      { id: 's-no-interval', autoSyncIntervalHours: null, lastSyncedAt: null },
    ]);
    const jobRepo = {
      findActiveByIdempotencyKey: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'job-1' }),
    };
    const service = createService({ sourceRepo, jobRepo });

    const created = await service.scheduleAutoSyncs();

    expect(created).toBe(2);
    expect(jobRepo.create).toHaveBeenCalledTimes(2);
    const createdSourceIds = jobRepo.create.mock.calls
      .map((c) => (c[0] as { sourceId: string }).sourceId)
      .sort();
    expect(createdSourceIds).toEqual(['s-due', 's-never']);
  });

  it('respects batchSize', async () => {
    const sourceRepo = makeSourceSet([
      { id: 's-1', autoSyncIntervalHours: 1, lastSyncedAt: null },
      { id: 's-2', autoSyncIntervalHours: 1, lastSyncedAt: null },
      { id: 's-3', autoSyncIntervalHours: 1, lastSyncedAt: null },
    ]);
    const jobRepo = {
      findActiveByIdempotencyKey: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'job' }),
    };
    const service = createService({ sourceRepo, jobRepo });

    const created = await service.scheduleAutoSyncs(2);
    expect(created).toBe(2);
    expect(jobRepo.create).toHaveBeenCalledTimes(2);
  });

  it('keeps sweeping when one source fails to schedule', async () => {
    const sourceRepo = makeSourceSet([
      { id: 's-bad', autoSyncIntervalHours: 1, lastSyncedAt: null },
      { id: 's-good', autoSyncIntervalHours: 1, lastSyncedAt: null },
    ]);
    // 覆盖 findById：s-bad 在创建任务时已被禁用 → createSourceSync 抛 BadRequest
    sourceRepo.findById.mockImplementation((id: string) =>
      Promise.resolve(
        id === 's-bad'
          ? {
              id: 's-bad',
              enabled: false,
              sourceType: 'civitai',
              autoSyncIntervalHours: 1,
              lastSyncedAt: null,
              config: null,
            }
          : id === 's-good'
            ? {
                id: 's-good',
                enabled: true,
                sourceType: 'civitai',
                autoSyncIntervalHours: 1,
                lastSyncedAt: null,
                config: null,
              }
            : null,
      ),
    );
    const jobRepo = {
      findActiveByIdempotencyKey: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'job' }),
    };
    const service = createService({ sourceRepo, jobRepo });

    const created = await service.scheduleAutoSyncs();
    expect(created).toBe(1);
    expect(jobRepo.create).toHaveBeenCalledTimes(1);
    expect((jobRepo.create.mock.calls[0][0] as { sourceId: string }).sourceId).toBe('s-good');
  });
});
