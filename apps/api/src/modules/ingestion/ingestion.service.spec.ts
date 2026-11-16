import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SafeUrlService } from '../../common/security/safe-url.service';
import { DirectDownloadConnector } from './connectors/direct-download.connector';
import { IngestionJobStatus, IngestionJobType, SourceType } from '../../common/constants/enums';
import { IngestionService, MAX_BATCH_MIRROR_RESOURCES } from './ingestion.service';

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

/**
 * storage.put 替身，按真实驱动（LocalStorageDriver.put）的契约消费入参。
 *
 * 若收下 Readable 却不读：连接器 download() 的 finally 会紧接着 unlink 临时文件，
 * 而 ReadStream 的 open 排在下一 tick，落地时文件已没了 —— 错误无人接收，
 * 冒成 unhandled 'error'（ENOENT/EPERM），vitest 会把全绿的一次运行判成退出码 1。
 */
function storagePutSpy() {
  return vi.fn(async (key: string, data: Buffer | NodeJS.ReadableStream) => {
    if (!Buffer.isBuffer(data)) {
      for await (const _chunk of data as NodeJS.ReadableStream) {
        // drain
      }
    }
    return key;
  });
}

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
    directDownload?: object;
    safeUrl?: object;
    storage?: object;
    fileRepo?: object;
    scheduler?: object;
    config?: object;
    resourceService?: object;
  } = {},
) {
  const safeUrl = (options.safeUrl ?? new SafeUrlService()) as never;
  const storage = (options.storage ?? {}) as never;
  const config = (options.config ?? { get: vi.fn().mockReturnValue(100) }) as never;
  const service = new IngestionService(
    (options.prisma ?? {}) as never,
    (options.jobRepo ?? {}) as never,
    (options.sourceRepo ?? {}) as never,
    (options.resourceRepo ?? {}) as never,
    safeUrl,
    (options.linkMetadataConnector ?? {}) as never,
    (options.locatorHealthChecker ?? {}) as never,
    (options.civitaiConnector ?? {}) as never,
    (options.githubConnector ?? {}) as never,
    (options.feedConnector ?? {}) as never,
    // 下载路径用真实连接器：既有测试通过 mock undici/file-type 覆盖端到端行为
    (options.directDownload ?? new DirectDownloadConnector(safeUrl, storage, config)) as never,
    storage,
    (options.fileRepo ?? {}) as never,
    (options.scheduler ?? { enqueue: vi.fn().mockResolvedValue(undefined) }) as never,
    config,
    (options.resourceService ?? { invalidateTrashStats: vi.fn() }) as never,
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
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue({ downloadAttempts: 0 }),
      create: vi.fn().mockResolvedValue({}),
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
    // 远端条目台账：默认未命中（该条目没下载过）→ 走正常下载流程
    sourceItemLedger: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
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

  it('does not treat an RSS feed URL as a path scope', async () => {
    const sourceRepo = {
      findById: vi.fn().mockResolvedValue({
        id: 'source-rss',
        enabled: true,
        sourceType: SourceType.rss,
        allowedModes: 'link_only,metadata_only',
        baseUrl: 'https://example.com/feed.xml',
      }),
    };
    const service = createService({ sourceRepo });
    const internalService = service as unknown as {
      assertLinkImportAllowed: (sourceId: string, url: string) => Promise<void>;
    };

    // 站内文章页不在 /feed.xml 之下，但对 RSS 来源是合法的导入目标
    await expect(
      internalService.assertLinkImportAllowed('source-rss', 'https://example.com/post/1'),
    ).resolves.toBeUndefined();
    // Feed 由第三方托管时，条目链接也可能在别的域名
    await expect(
      internalService.assertLinkImportAllowed('source-rss', 'https://mirror.example/post/1'),
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

describe('IngestionService clearSyncHistory', () => {
  function makePrisma(count: number) {
    return {
      sourceItemLedger: { deleteMany: vi.fn().mockResolvedValue({ count }) },
    };
  }

  it('clears the whole ledger when no source is given', async () => {
    const prisma = makePrisma(12);
    const sourceRepo = { findById: vi.fn(), update: vi.fn() };
    const service = createService({ prisma, sourceRepo });

    await expect(service.clearSyncHistory()).resolves.toEqual({
      deleted: 12,
      cursorReset: false,
    });
    expect(prisma.sourceItemLedger.deleteMany).toHaveBeenCalledWith({ where: {} });
    // 全量清理不碰任何来源配置
    expect(sourceRepo.findById).not.toHaveBeenCalled();
  });

  it('scopes deletion to a single source and resets its cursor', async () => {
    const prisma = makePrisma(3);
    const sourceRepo = {
      findById: vi.fn().mockResolvedValue({
        id: 'source-9',
        config: JSON.stringify({ sort: 'Newest', period: 'Day', cursor: 'page-42' }),
      }),
      update: vi.fn().mockResolvedValue({}),
    };
    const service = createService({ prisma, sourceRepo });

    await expect(service.clearSyncHistory('source-9')).resolves.toEqual({
      deleted: 3,
      cursorReset: true,
    });
    expect(prisma.sourceItemLedger.deleteMany).toHaveBeenCalledWith({
      where: { sourceId: 'source-9' },
    });
    // 游标被移除、其余筛选条件原样保留：否则清完台账也翻不回已抓过的页
    expect(sourceRepo.update).toHaveBeenCalledWith('source-9', {
      config: JSON.stringify({ sort: 'Newest', period: 'Day' }),
    });
  });

  it('leaves the config untouched when the source has no cursor', async () => {
    const prisma = makePrisma(0);
    const sourceRepo = {
      findById: vi.fn().mockResolvedValue({
        id: 'source-9',
        config: JSON.stringify({ sort: 'Newest' }),
      }),
      update: vi.fn(),
    };
    const service = createService({ prisma, sourceRepo });

    await expect(service.clearSyncHistory('source-9')).resolves.toEqual({
      deleted: 0,
      cursorReset: false,
    });
    expect(sourceRepo.update).not.toHaveBeenCalled();
  });

  it('keeps an unparsable config instead of overwriting it', async () => {
    const prisma = makePrisma(1);
    const sourceRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'source-9', config: '{not json' }),
      update: vi.fn(),
    };
    const service = createService({ prisma, sourceRepo });

    await expect(service.clearSyncHistory('source-9')).resolves.toEqual({
      deleted: 1,
      cursorReset: false,
    });
    expect(sourceRepo.update).not.toHaveBeenCalled();
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
    const resourceServiceStub = { invalidateTrashStats: vi.fn() };
    const service = createService({
      prisma,
      jobRepo,
      resourceRepo,
      linkMetadataConnector: connector,
      resourceService: resourceServiceStub,
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
    // 这条路径直接复活了回收站资源，统计缓存必须同步失效
    expect(resourceServiceStub.invalidateTrashStats).toHaveBeenCalledOnce();
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
    const prisma = {
      resourceLocator: {
        findUnique: vi.fn().mockResolvedValue({ downloadAttempts: 0 }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const storage = { generateKey: vi.fn(), put: storagePutSpy() };
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

    const storage = { generateKey: vi.fn(), put: storagePutSpy() };
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
    // 未配置下载文件夹时不写 category
    const createCall = (prisma.resource.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.data.category).toBeUndefined();
    expect(jobRepo.complete).toHaveBeenCalledWith(
      'sync-job-review',
      'lease-review',
      null,
      expect.stringContaining('"skippedCount":1'),
    );
  });

  it('puts synced resources into the configured resource-library folder', async () => {
    const prisma = makeSyncPrisma();
    (prisma.resourceLocator.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.resource.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'new-resource-id',
      locators: [{ id: 'loc-download', locatorType: 'download' }],
    });

    const jobRepo = {
      claimNext: vi.fn().mockResolvedValue({
        id: 'sync-job-folder',
        leaseToken: 'lease-folder',
        jobType: IngestionJobType.sync_source,
        request: JSON.stringify({ sourceId: 'source-1', cursor: null }),
      }),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue(true),
    };

    const sourceRepo = makeSourceRepo({
      findById: vi.fn().mockResolvedValue({
        id: 'source-1',
        name: 'Folder Source',
        enabled: true,
        sourceType: 'civitai',
        requiresReview: true,
        downloadCategoryId: 'folder-1',
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
        nextCursor: null,
        totalItems: 1,
      }),
    };

    const storage = { generateKey: vi.fn(), put: storagePutSpy() };
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

    const createCall = (prisma.resource.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.data.category).toEqual({ connect: { id: 'folder-1' } });
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

    const storage = { generateKey: vi.fn(), put: storagePutSpy() };
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
      sourceItemLedger: { upsert: vi.fn().mockResolvedValue({}) },
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
      put: storagePutSpy(),
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
    // 台账与文件记录同事务落库：之后即使资源被彻底删除，同步也不会重复下载
    expect(tx.sourceItemLedger.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          connectorType_externalId: { connectorType: 'civitai', externalId: '88888' },
        },
        create: expect.objectContaining({
          state: 'downloaded',
          sha256: expect.any(String),
          resourceId: 'new-resource-id',
          sourceId: 'source-1',
        }),
      }),
    );
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

  /** 构造一条可同步的远端条目（Civitai 图片） */
  function ledgerRemote(externalId: string, previewUrl: string | null = null) {
    return {
      externalId,
      url: `https://image.civitai.com/${externalId}.jpeg`,
      canonicalUrl: `https://civitai.com/images/${externalId}`,
      resourceType: 'image',
      mimeType: 'image/jpeg',
      title: `Civitai Image #${externalId}`,
      description: null,
      authorName: null,
      authorUrl: null,
      publisher: 'Civitai',
      previewUrl,
      width: null,
      height: null,
      externalCreatedAt: null,
      rawMetadata: { id: Number(externalId) },
      additionalLocators: [],
    };
  }

  /** 构造跑完一次 sync_source 所需的最小 jobRepo + connector */
  function makeLedgerSync(remoteItems: ReturnType<typeof ledgerRemote>[], suffix: string) {
    const jobRepo = {
      claimNext: vi.fn().mockResolvedValue({
        id: `sync-job-${suffix}`,
        leaseToken: `lease-${suffix}`,
        jobType: IngestionJobType.sync_source,
        request: JSON.stringify({ sourceId: 'source-1', cursor: null }),
      }),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue(true),
    };
    const civitaiConnector = {
      type: 'civitai' as const,
      inspect: vi.fn(),
      sync: vi.fn().mockResolvedValue({
        items: remoteItems,
        nextCursor: null,
        totalItems: remoteItems.length,
      }),
    };
    return { jobRepo, civitaiConnector };
  }

  it('skips a remote item that the ledger already recorded as downloaded', async () => {
    const prisma = makeSyncPrisma();
    (prisma.sourceItemLedger.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: 'downloaded',
    });
    const { jobRepo, civitaiConnector } = makeLedgerSync([ledgerRemote('77777')], 'ledger');

    const service = createService({
      prisma,
      jobRepo,
      sourceRepo: makeSourceRepo(),
      civitaiConnector,
    });
    await service.runNextJob();
    await settleAsync();

    expect(prisma.sourceItemLedger.findUnique).toHaveBeenCalledWith({
      where: { connectorType_externalId: { connectorType: 'civitai', externalId: '77777' } },
      select: { state: true },
    });
    // 台账命中 → 既不重建元数据资源，也不重新下载
    expect(prisma.resource.create).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(jobRepo.complete).toHaveBeenCalledWith(
      'sync-job-ledger',
      'lease-ledger',
      null,
      expect.stringContaining('"skippedCount":1'),
    );
  });

  it('still downloads when the ledger only recorded metadata', async () => {
    const prisma = makeSyncPrisma();
    // metadata_only 表示上次只存了元数据（如来源开了人工审核），不能拦下载
    (prisma.sourceItemLedger.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: 'metadata_only',
    });
    const { jobRepo, civitaiConnector } = makeLedgerSync([ledgerRemote('66666')], 'meta');

    const service = createService({
      prisma,
      jobRepo,
      sourceRepo: makeSourceRepo(),
      civitaiConnector,
    });
    await service.runNextJob();
    await settleAsync();

    expect(prisma.resource.create).toHaveBeenCalledTimes(1);
    // 下载被发起（本用例网络失败，但不影响「没有被台账拦下」这一断言）
    expect(mockFetch).toHaveBeenCalled();
  });

  it('stores the connector preview URL as a preview locator on newly synced resources', async () => {
    const prisma = makeSyncPrisma();
    const jobRepo = {
      claimNext: vi.fn().mockResolvedValue({
        id: 'sync-job-preview',
        leaseToken: 'lease-preview',
        jobType: IngestionJobType.sync_source,
        request: JSON.stringify({ sourceId: 'source-rss', cursor: null }),
      }),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue(true),
    };
    const feedConnector = {
      type: 'rss' as const,
      inspect: vi.fn(),
      sync: vi.fn().mockResolvedValue({
        items: [
          {
            externalId: 'https://example.com/episodes/1',
            url: 'https://cdn.example.com/episodes/1.mp4',
            canonicalUrl: 'https://example.com/episodes/1',
            resourceType: 'video',
            mimeType: 'video/mp4',
            title: 'Episode 1',
            description: null,
            authorName: null,
            publisher: 'Example',
            previewUrl: 'https://cdn.example.com/episodes/1-thumb.jpg',
            rawMetadata: { kind: 'feed_item' },
            additionalLocators: [{ locatorType: 'page', url: 'https://example.com/episodes/1' }],
          },
        ],
        nextCursor: null,
        totalItems: 1,
      }),
    };
    const sourceRepo = makeSourceRepo({
      findById: vi.fn().mockResolvedValue({
        id: 'source-rss',
        name: 'RSS Source',
        enabled: true,
        sourceType: 'rss',
        config: JSON.stringify({}),
        baseUrl: 'https://example.com/feed.xml',
      }),
    });

    const service = createService({ prisma, jobRepo, sourceRepo, feedConnector });
    await service.runNextJob();
    await settleAsync();

    expect(prisma.resource.create).toHaveBeenCalledTimes(1);
    const createCall = (prisma.resource.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const locators = createCall.data.locators.create;
    expect(locators).toHaveLength(3); // download + preview + page
    expect(locators[1]).toMatchObject({
      locatorType: 'preview',
      url: 'https://cdn.example.com/episodes/1-thumb.jpg',
      isPrimary: false,
    });
  });

  it('absolutizes relative preview URLs and drops non-HTTP preview URLs', async () => {
    const prisma = makeSyncPrisma();
    const jobRepo = {
      claimNext: vi.fn().mockResolvedValue({
        id: 'sync-job-preview-urls',
        leaseToken: 'lease-preview-urls',
        jobType: IngestionJobType.sync_source,
        request: JSON.stringify({ sourceId: 'source-rss', cursor: null }),
      }),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue(true),
    };
    const baseItem = {
      resourceType: 'audio',
      mimeType: 'audio/mpeg',
      description: null,
      authorName: null,
      publisher: 'Example',
      rawMetadata: { kind: 'feed_item' },
      additionalLocators: [],
    };
    const feedConnector = {
      type: 'rss' as const,
      inspect: vi.fn(),
      sync: vi.fn().mockResolvedValue({
        items: [
          {
            ...baseItem,
            externalId: 'relative-1',
            url: 'https://cdn.example.com/e1.mp3',
            canonicalUrl: 'https://example.com/episodes/1',
            title: 'Relative preview',
            previewUrl: '/thumbs/e1.jpg',
          },
          {
            ...baseItem,
            externalId: 'data-1',
            url: 'https://cdn.example.com/e2.mp3',
            canonicalUrl: 'https://example.com/episodes/2',
            title: 'Data URI preview',
            previewUrl: 'data:image/png;base64,AAAA',
          },
        ],
        nextCursor: null,
        totalItems: 2,
      }),
    };
    const sourceRepo = makeSourceRepo({
      findById: vi.fn().mockResolvedValue({
        id: 'source-rss',
        name: 'RSS Source',
        enabled: true,
        sourceType: 'rss',
        config: JSON.stringify({}),
        baseUrl: 'https://example.com/feed.xml',
      }),
    });

    const service = createService({ prisma, jobRepo, sourceRepo, feedConnector });
    await service.runNextJob();
    await settleAsync();

    const createCalls = (prisma.resource.create as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0],
    );
    const relative = createCalls.find((call) => call.data.title === 'Relative preview');
    expect(
      relative.data.locators.create.find(
        (locator: { locatorType: string }) => locator.locatorType === 'preview',
      ),
    ).toMatchObject({ url: 'https://example.com/thumbs/e1.jpg' });

    const dataUri = createCalls.find((call) => call.data.title === 'Data URI preview');
    expect(
      dataUri.data.locators.create.some(
        (locator: { locatorType: string }) => locator.locatorType === 'preview',
      ),
    ).toBe(false);
  });

  it('backfills the preview locator for an already-downloaded ledger item', async () => {
    const prisma = makeSyncPrisma();
    (prisma.sourceItemLedger.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: 'downloaded',
    });
    (prisma.resourceLocator.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      resourceId: 'existing-resource-id',
      resource: { locators: [] },
    });
    const { jobRepo, civitaiConnector } = makeLedgerSync(
      [ledgerRemote('88888', 'https://image.civitai.com/88888-thumb.jpg')],
      'preview-backfill',
    );

    const service = createService({
      prisma,
      jobRepo,
      sourceRepo: makeSourceRepo(),
      civitaiConnector,
    });
    await service.runNextJob();
    await settleAsync();

    // 台账命中 → 不重建资源、不下载，但仍要补上缩略图
    expect(prisma.resource.create).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    // 按来源+externalId 或全局 identityUrl 都能定位到同一资源
    expect(prisma.resourceLocator.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { sourceId: 'source-1', externalId: '88888' },
            { identityUrl: 'civitai://image/88888' },
          ],
        },
      }),
    );
    expect(prisma.resourceLocator.create).toHaveBeenCalledWith({
      data: {
        resourceId: 'existing-resource-id',
        sourceId: 'source-1',
        locatorType: 'preview',
        url: 'https://image.civitai.com/88888-thumb.jpg',
        isPrimary: false,
      },
    });
  });

  it('batches the preview lookup and skips items that already have one', async () => {
    const prisma = makeSyncPrisma();
    (prisma.sourceItemLedger.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: 'downloaded',
    });
    (prisma.resourceLocator.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        externalId: '99999',
        identityUrl: 'civitai://image/99999',
        resource: { locators: [{ id: 'preview-1' }] },
      },
    ]);
    const { jobRepo, civitaiConnector } = makeLedgerSync(
      [ledgerRemote('99999', 'https://image.civitai.com/99999-thumb.jpg')],
      'preview-ready',
    );

    const service = createService({
      prisma,
      jobRepo,
      sourceRepo: makeSourceRepo(),
      civitaiConnector,
    });
    await service.runNextJob();
    await settleAsync();

    // 整页一次 IN 查询，而不是逐条 findFirst
    expect(prisma.resourceLocator.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { sourceId: 'source-1', externalId: { in: ['99999'] } },
            { identityUrl: { in: ['civitai://image/99999'] } },
          ]),
        }),
      }),
    );
    // 预取已确认有预览 → 不再逐条回填，也不重复插入
    expect(prisma.resourceLocator.findFirst).not.toHaveBeenCalled();
    expect(prisma.resourceLocator.create).not.toHaveBeenCalled();
  });

  it('does not duplicate a preview locator when the preview URL equals the download URL', async () => {
    const prisma = makeSyncPrisma();
    (prisma.sourceItemLedger.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: 'downloaded',
    });
    const remote = ledgerRemote('99999');
    const { jobRepo, civitaiConnector } = makeLedgerSync(
      [{ ...remote, previewUrl: remote.url }],
      'preview-same-url',
    );

    const service = createService({
      prisma,
      jobRepo,
      sourceRepo: makeSourceRepo(),
      civitaiConnector,
    });
    await service.runNextJob();
    await settleAsync();

    expect(prisma.resourceLocator.findFirst).not.toHaveBeenCalled();
    expect(prisma.resourceLocator.create).not.toHaveBeenCalled();
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

/** capture_page 测试共用的依赖 mock */
function makeSnapshotMocks(
  options: {
    resource?: object | null;
    existingSnapshot?: { id: string; storagePath: string } | null;
    html?: string;
  } = {},
) {
  const html = options.html ?? '<html><body>page</body></html>';
  const resource =
    options.resource === undefined
      ? {
          id: 'res-1',
          deletedAt: null,
          sourceId: null,
          originalFilename: 'page.html',
          locators: [
            {
              id: 'loc-page',
              locatorType: 'page',
              url: 'https://example.com/posts/1',
              canonicalUrl: 'https://example.com/posts/one',
              identityUrl: null,
              isPrimary: true,
            },
          ],
        }
      : options.resource;

  const prisma = {
    resource: { findUnique: vi.fn().mockResolvedValue(resource) },
    resourceFile: {
      findUnique: vi.fn().mockResolvedValue(options.existingSnapshot ?? null),
      upsert: vi.fn().mockResolvedValue({ id: 'file-snapshot' }),
    },
    resourceLocator: { update: vi.fn().mockResolvedValue({}) },
    ingestionJob: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };

  const storage = {
    generateKey: vi.fn(
      (role: string, hash: string, _variant?: string, ext?: string) =>
        `${role}s/ab/cd/${hash}.${ext ?? 'bin'}`,
    ),
    put: storagePutSpy(),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const sha256 = createHash('sha256').update(html, 'utf-8').digest('hex');
  const safeUrl = {
    normalize: vi.fn((value: string) => new URL(value)),
    fetchHtml: vi.fn().mockResolvedValue({
      url: 'https://example.com/posts/one',
      status: 200,
      body: html,
    }),
  };
  const fileRepo = {
    findStoragePathReferences: vi.fn().mockResolvedValue(new Map()),
  };
  return { prisma, storage, safeUrl, fileRepo, sha256, html };
}

function createSnapshotJobService(
  mocks: ReturnType<typeof makeSnapshotMocks>,
  jobId: string,
  url = 'https://example.com/posts/one',
) {
  const jobRepo = {
    claimNext: vi.fn().mockResolvedValue({
      id: jobId,
      leaseToken: `lease-${jobId}`,
      jobType: IngestionJobType.capture_page,
      request: JSON.stringify({ resourceId: 'res-1', url }),
    }),
    complete: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue(true),
  };
  const service = createService({
    prisma: mocks.prisma,
    storage: mocks.storage,
    safeUrl: mocks.safeUrl,
    fileRepo: mocks.fileRepo,
    jobRepo,
  });
  return { service, jobRepo };
}

describe('IngestionService page snapshots', () => {
  it('queues a capture_page job for the resource page URL', async () => {
    const mocks = makeSnapshotMocks();
    const jobRepo = {
      create: vi.fn().mockImplementation(async (data) => ({ id: 'job-1', ...data })),
      findActiveByIdempotencyKey: vi.fn().mockResolvedValue(null),
    };
    const service = createService({
      prisma: mocks.prisma,
      storage: mocks.storage,
      safeUrl: mocks.safeUrl,
      jobRepo,
    });

    const job = await service.createPageSnapshot('res-1');

    expect(job).toMatchObject({ jobType: 'capture_page', resourceId: 'res-1' });
    expect(JSON.parse((jobRepo.create.mock.calls[0][0] as { request: string }).request)).toEqual({
      resourceId: 'res-1',
      url: 'https://example.com/posts/one',
    });
  });

  it('reuses the active snapshot job instead of queueing a second one', async () => {
    const mocks = makeSnapshotMocks();
    const active = { id: 'job-active', status: 'pending' };
    const jobRepo = {
      create: vi.fn(),
      findActiveByIdempotencyKey: vi.fn().mockResolvedValue(active),
    };
    const service = createService({
      prisma: mocks.prisma,
      storage: mocks.storage,
      safeUrl: mocks.safeUrl,
      jobRepo,
    });

    await expect(service.createPageSnapshot('res-1')).resolves.toBe(active);
    expect(jobRepo.create).not.toHaveBeenCalled();
  });

  it('refuses to snapshot a deleted resource', async () => {
    const mocks = makeSnapshotMocks({
      resource: { id: 'r', deletedAt: new Date(), locators: [] },
    });
    const service = createService({
      prisma: mocks.prisma,
      storage: mocks.storage,
      safeUrl: mocks.safeUrl,
    });

    await expect(service.createPageSnapshot('r')).rejects.toThrow(/deleted/);
  });

  it('refuses a resource without any usable URL', async () => {
    const mocks = makeSnapshotMocks({
      resource: { id: 'r', deletedAt: null, locators: [] },
    });
    const service = createService({
      prisma: mocks.prisma,
      storage: mocks.storage,
      safeUrl: mocks.safeUrl,
    });

    await expect(service.createPageSnapshot('r')).rejects.toThrow(/page URL/);
  });

  it('enforces the archive_snapshot source policy for sourced resources', async () => {
    const mocks = makeSnapshotMocks({
      resource: {
        id: 'res-1',
        deletedAt: null,
        sourceId: 'src-1',
        locators: [
          { id: 'l', locatorType: 'page', url: 'https://example.com/a', canonicalUrl: null },
        ],
      },
    });
    const sourceRepo = makeSourceRepo({
      findById: vi.fn().mockResolvedValue({
        id: 'src-1',
        enabled: true,
        allowedModes: 'link_only,mirror_file',
        requiresReview: false,
      }),
    });
    const service = createService({
      prisma: mocks.prisma,
      sourceRepo,
      storage: mocks.storage,
      safeUrl: mocks.safeUrl,
      jobRepo: { create: vi.fn(), findActiveByIdempotencyKey: vi.fn().mockResolvedValue(null) },
    });

    await expect(service.createPageSnapshot('res-1')).rejects.toThrow(/archive_snapshot/);
  });

  it('stores the fetched HTML as a snapshot file and refreshes the page locator', async () => {
    const mocks = makeSnapshotMocks();
    const { service, jobRepo } = createSnapshotJobService(mocks, 'snap-job-1');

    await service.runNextJob();
    await settleAsync();

    const key = `snapshots/ab/cd/${mocks.sha256}.html`;
    expect(mocks.storage.put).toHaveBeenCalledWith(key, Buffer.from(mocks.html, 'utf-8'));
    expect(mocks.prisma.resourceFile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          resourceId: 'res-1',
          fileRole: 'snapshot',
          storagePath: key,
          mimeType: 'text/html',
          extension: 'html',
        }),
      }),
    );
    expect(mocks.prisma.resourceLocator.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'loc-page' },
        data: expect.objectContaining({ httpStatus: 200, contentType: 'text/html' }),
      }),
    );
    expect(jobRepo.complete).toHaveBeenCalledWith(
      'snap-job-1',
      'lease-snap-job-1',
      'res-1',
      expect.stringContaining('"status":"captured"'),
    );
  });

  it('keeps the existing snapshot object when the page content is unchanged', async () => {
    const sha = createHash('sha256')
      .update('<html><body>page</body></html>', 'utf-8')
      .digest('hex');
    const mocks = makeSnapshotMocks({
      existingSnapshot: { id: 'f-1', storagePath: `snapshots/ab/cd/${sha}.html` },
    });
    const { service, jobRepo } = createSnapshotJobService(mocks, 'snap-job-2');

    await service.runNextJob();
    await settleAsync();

    expect(mocks.storage.put).not.toHaveBeenCalled();
    expect(mocks.prisma.resourceFile.upsert).not.toHaveBeenCalled();
    expect(jobRepo.complete).toHaveBeenCalledWith(
      'snap-job-2',
      'lease-snap-job-2',
      'res-1',
      expect.stringContaining('"status":"unchanged"'),
    );
  });

  it('replaces the record and removes the previous object when the page changed', async () => {
    const mocks = makeSnapshotMocks({
      existingSnapshot: { id: 'f-old', storagePath: 'snapshots/ab/cd/stale.html' },
    });
    const { service, jobRepo } = createSnapshotJobService(mocks, 'snap-job-3');

    await service.runNextJob();
    await settleAsync();

    expect(mocks.storage.delete).toHaveBeenCalledWith('snapshots/ab/cd/stale.html');
    expect(jobRepo.complete).toHaveBeenCalledWith(
      'snap-job-3',
      'lease-snap-job-3',
      'res-1',
      expect.stringContaining('"status":"updated"'),
    );
  });

  it('keeps the previous snapshot object when another resource still references it', async () => {
    const mocks = makeSnapshotMocks({
      existingSnapshot: { id: 'f-old', storagePath: 'snapshots/ab/cd/shared.html' },
    });
    // 内容相同的快照被另一条资源共用 → 旧对象不能删
    mocks.fileRepo.findStoragePathReferences.mockResolvedValue(
      new Map([['snapshots/ab/cd/shared.html', new Set(['res-2'])]]),
    );
    const { service, jobRepo } = createSnapshotJobService(mocks, 'snap-job-4b');

    await service.runNextJob();
    await settleAsync();

    expect(mocks.fileRepo.findStoragePathReferences).toHaveBeenCalledWith([
      'snapshots/ab/cd/shared.html',
    ]);
    expect(mocks.storage.delete).not.toHaveBeenCalled();
    expect(jobRepo.complete).toHaveBeenCalledWith(
      'snap-job-4b',
      'lease-snap-job-4b',
      'res-1',
      expect.stringContaining('"status":"updated"'),
    );
  });

  it('keeps the previous snapshot object when the reference check fails', async () => {
    const mocks = makeSnapshotMocks({
      existingSnapshot: { id: 'f-old', storagePath: 'snapshots/ab/cd/stale.html' },
    });
    mocks.fileRepo.findStoragePathReferences.mockRejectedValue(new Error('db unavailable'));
    const { service, jobRepo } = createSnapshotJobService(mocks, 'snap-job-4c');

    await service.runNextJob();
    await settleAsync();

    // 无法确认是否共用时保守保留，避免误删其它资源的快照
    expect(mocks.storage.delete).not.toHaveBeenCalled();
    expect(jobRepo.complete).toHaveBeenCalledWith(
      'snap-job-4c',
      'lease-snap-job-4c',
      'res-1',
      expect.stringContaining('"status":"updated"'),
    );
  });

  it('reports the offending URL when the page cannot be fetched', async () => {
    const mocks = makeSnapshotMocks();
    mocks.safeUrl.fetchHtml.mockRejectedValue(new Error('Remote HTML exceeds 2097152 byte limit'));
    const { service, jobRepo } = createSnapshotJobService(mocks, 'snap-job-5');

    await service.runNextJob();
    await settleAsync();

    expect(mocks.storage.put).not.toHaveBeenCalled();
    const [errorCode, errorMessage] = jobRepo.fail.mock.calls[0].slice(2) as [string, string];
    expect(errorCode).toBe('invalid_remote_resource');
    expect(errorMessage).toContain('https://example.com/posts/one');
    expect(errorMessage).toContain('byte limit');
  });

  it('fails the job when the fetched page is empty', async () => {
    const mocks = makeSnapshotMocks({ html: '   ' });
    const { service, jobRepo } = createSnapshotJobService(mocks, 'snap-job-4');

    await service.runNextJob();
    await settleAsync();

    expect(mocks.storage.put).not.toHaveBeenCalled();
    expect(jobRepo.fail).toHaveBeenCalled();
  });
});

describe('IngestionService download retries', () => {
  beforeEach(() => {
    vi.spyOn(SafeUrlService.prototype, 'resolvePublicHost').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ]);
  });

  it('retries a transient failure inline and commits the successful attempt', async () => {
    const tx = {
      resource: {
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({}),
      },
      resourceFile: { create: vi.fn().mockResolvedValue({}) },
      resourceLocator: { update: vi.fn().mockResolvedValue({}) },
      sourceItemLedger: { upsert: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (t: object) => Promise<unknown>) => callback(tx)),
      resourceLocator: {
        findUnique: vi.fn().mockResolvedValue({ downloadAttempts: 0 }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const download = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({
        sha256: 'a'.repeat(64),
        mimeType: 'image/jpeg',
        extension: 'jpg',
        resourceType: 'image',
        sizeBytes: 10,
        storageKey: 'originals/ab/a.jpg',
      });
    const scheduler = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const service = createService({ prisma, directDownload: { download }, scheduler });

    vi.useFakeTimers();
    try {
      const promise = (
        service as unknown as {
          downloadRemoteFile: (
            resourceId: string,
            locatorId: string,
            remote: object,
          ) => Promise<string>;
        }
      ).downloadRemoteFile('resource-1', 'locator-1', {
        externalId: 'remote-1',
        url: 'https://example.com/a.jpg',
        resourceType: 'image',
        mimeType: 'image/jpeg',
      });
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBe('downloaded');
    } finally {
      vi.useRealTimers();
    }

    expect(download).toHaveBeenCalledTimes(2);
    expect(tx.resourceLocator.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ downloadAttempts: 0, nextDownloadAttemptAt: null }),
      }),
    );
    expect(scheduler.enqueue).toHaveBeenCalled();
  });

  it('stops after the inline retries and schedules a backoff retry', async () => {
    const prisma = {
      resourceLocator: {
        findUnique: vi.fn().mockResolvedValue({ downloadAttempts: 0 }),
        update: vi.fn().mockResolvedValueOnce({ downloadAttempts: 1 }).mockResolvedValue({}),
      },
    };
    const download = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const service = createService({ prisma, directDownload: { download } });

    vi.useFakeTimers();
    try {
      const promise = (
        service as unknown as {
          downloadRemoteFile: (
            resourceId: string,
            locatorId: string,
            remote: object,
          ) => Promise<string>;
        }
      ).downloadRemoteFile('resource-1', 'locator-1', {
        externalId: 'remote-1',
        url: 'https://example.com/a.jpg',
        resourceType: 'image',
        mimeType: 'image/jpeg',
      });
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBe('failed');
    } finally {
      vi.useRealTimers();
    }

    expect(download).toHaveBeenCalledTimes(3);
    // 计数由数据库原子自增；退避时间基于自增后的次数单独写回
    expect(prisma.resourceLocator.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'locator-1' },
      data: expect.objectContaining({
        downloadAttempts: { increment: 1 },
        lastError: 'socket hang up',
      }),
      select: { downloadAttempts: true },
    });
    expect(prisma.resourceLocator.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'locator-1' },
      data: { nextDownloadAttemptAt: expect.any(Date) },
    });
  });

  it('does not retry a non-transient failure', async () => {
    const prisma = {
      resourceLocator: {
        findUnique: vi.fn().mockResolvedValue({ downloadAttempts: 0 }),
        update: vi.fn().mockResolvedValueOnce({ downloadAttempts: 1 }).mockResolvedValue({}),
      },
    };
    const download = vi.fn().mockRejectedValue(new Error('HTTP 403'));
    const service = createService({ prisma, directDownload: { download } });

    await expect(
      (
        service as unknown as {
          downloadRemoteFile: (
            resourceId: string,
            locatorId: string,
            remote: object,
          ) => Promise<string>;
        }
      ).downloadRemoteFile('resource-1', 'locator-1', {
        externalId: 'remote-1',
        url: 'https://example.com/a.jpg',
        resourceType: 'image',
        mimeType: 'image/jpeg',
      }),
    ).resolves.toBe('failed');

    expect(download).toHaveBeenCalledOnce();
    expect(prisma.resourceLocator.update).toHaveBeenCalledTimes(2);
  });

  it('stops scheduling automatic retries once the attempt cap is reached', async () => {
    const prisma = {
      resourceLocator: {
        findUnique: vi.fn().mockResolvedValue({ downloadAttempts: 4 }),
        update: vi.fn().mockResolvedValueOnce({ downloadAttempts: 5 }).mockResolvedValue({}),
      },
    };
    const service = createService({ prisma });

    await (
      service as unknown as { markLocatorError: (id: string, msg: string) => Promise<void> }
    ).markLocatorError('locator-1', 'still failing');

    expect(prisma.resourceLocator.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'locator-1' },
      data: expect.objectContaining({
        downloadAttempts: { increment: 1 },
        lastError: 'still failing',
      }),
      select: { downloadAttempts: true },
    });
    expect(prisma.resourceLocator.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'locator-1' },
      data: { nextDownloadAttemptAt: null },
    });
  });

  it('queues due failed downloads for background retry', async () => {
    const prisma = {
      resource: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'resource-1', sourceId: null },
          { id: 'resource-2', sourceId: null },
        ]),
      },
    };
    const jobRepo = {
      findActiveByIdempotencyKey: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'retry-job' }),
    };
    const service = createService({ prisma, jobRepo });

    await expect(
      (
        service as unknown as { scheduleFailedDownloadRetries: (n: number) => Promise<number> }
      ).scheduleFailedDownloadRetries(2),
    ).resolves.toBe(2);
    expect(prisma.resource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2, orderBy: { createdAt: 'asc' } }),
    );
    expect(jobRepo.create).toHaveBeenCalledTimes(2);
  });

  it('only queues failed downloads from sources whose policy allows mirror_file', async () => {
    const prisma = {
      resource: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = createService({ prisma });

    await (
      service as unknown as { scheduleFailedDownloadRetries: (n: number) => Promise<number> }
    ).scheduleFailedDownloadRetries(20);

    expect(prisma.resource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceRecord: expect.objectContaining({
            enabled: true,
            requiresReview: false,
            // 策略不允许 mirror_file 的来源不能在补漏里建出注定失败的任务：
            // 执行期 assertDownloadAllowed 拒绝不会累加失败次数
            allowedModes: { contains: 'mirror_file' },
          }),
        }),
      }),
    );
  });

  it('skips sources that do not permit mirror downloads during a bulk retry', async () => {
    // 查询时两条都还“有资格”（模拟查询与逐条校验之间来源被禁用），
    // 逐条门禁仍需拒绝第二条。
    const prisma = {
      resource: {
        count: vi
          .fn()
          .mockImplementation(
            async ({ where }: { where: { ingestionJobs?: { some?: unknown } } }) =>
              where.ingestionJobs?.some ? 0 : 2,
          ),
        findMany: vi.fn().mockResolvedValue([
          { id: 'resource-1', sourceId: 'enabled-source' },
          { id: 'resource-2', sourceId: 'disabled-source' },
        ]),
      },
      resourceLocator: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const sourceRepo = {
      findById: vi.fn().mockImplementation(async (id: string) =>
        id === 'enabled-source'
          ? {
              id,
              enabled: true,
              allowedModes: 'metadata_only,mirror_file',
              requiresReview: false,
            }
          : {
              id,
              enabled: false,
              allowedModes: 'metadata_only',
              requiresReview: false,
            },
      ),
    };
    const jobRepo = {
      findActiveByIdempotencyKey: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'retry-job' }),
    };
    const service = createService({ prisma, sourceRepo, jobRepo });

    await expect(
      (
        service as unknown as {
          retryFailedDownloads: (params: object) => Promise<{ queued: number; skipped: number }>;
        }
      ).retryFailedDownloads({ limit: 10 }),
    ).resolves.toEqual({ queued: 1, skipped: 1 });
    expect(jobRepo.create).toHaveBeenCalledOnce();
  });

  it('reports policy-ineligible resources as skipped without letting them occupy the batch', async () => {
    const prisma = {
      resource: {
        // total=3，其中 1 条策略允许；被拒绝的 2 条不进候选集，只计入 skipped
        count: vi
          .fn()
          .mockImplementation(
            async ({
              where,
            }: {
              where: { sourceRecord?: unknown; ingestionJobs?: { some?: unknown } };
            }) => {
              if (where.ingestionJobs?.some) return 0;
              if (where.sourceRecord) return 1;
              return 3;
            },
          ),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    const service = createService({ prisma });

    await expect(
      (
        service as unknown as {
          retryFailedDownloads: (params: object) => Promise<{ queued: number; skipped: number }>;
        }
      ).retryFailedDownloads({ limit: 2 }),
    ).resolves.toEqual({ queued: 0, skipped: 2 });
    // 候选查询必须带策略过滤，否则每次都会取到同一批头部资源
    expect(prisma.resource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2,
        where: expect.objectContaining({
          sourceId: { not: null },
          sourceRecord: {
            enabled: true,
            OR: [
              { allowedModes: { contains: 'mirror_file' } },
              { requiresReview: true, allowedModes: { contains: 'metadata_only' } },
            ],
          },
        }),
      }),
    );
  });

  it('counts already-queued resources as queued and keeps them out of the batch', async () => {
    const prisma = {
      resource: {
        count: vi
          .fn()
          .mockImplementation(
            async ({
              where,
            }: {
              where: { sourceRecord?: unknown; ingestionJobs?: { some?: unknown } };
            }) => {
              if (where.ingestionJobs?.some) return 1; // 已在队列里的
              if (where.sourceRecord) return 2; // 策略允许的
              return 2;
            },
          ),
        findMany: vi.fn().mockResolvedValue([{ id: 'resource-2', sourceId: 'source-1' }]),
      },
      resourceLocator: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const sourceRepo = {
      findById: vi.fn().mockResolvedValue({
        id: 'source-1',
        enabled: true,
        allowedModes: 'metadata_only,mirror_file',
        requiresReview: false,
      }),
    };
    const jobRepo = {
      findActiveByIdempotencyKey: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'retry-job' }),
    };
    const service = createService({ prisma, sourceRepo, jobRepo });

    await expect(
      (
        service as unknown as {
          retryFailedDownloads: (params: object) => Promise<{ queued: number; skipped: number }>;
        }
      ).retryFailedDownloads({ limit: 2 }),
    ).resolves.toEqual({ queued: 2, skipped: 0 });
    // 候选集必须排除已有在途任务的资源，避免它们反复占满 limit
    expect(prisma.resource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ingestionJobs: {
            none: {
              jobType: 'download_file',
              status: { in: ['pending', 'processing'] },
            },
          },
        }),
      }),
    );
    // 手动重试会清零自动补漏预算，失败后还能重新走完整退避
    expect(prisma.resourceLocator.updateMany).toHaveBeenCalledWith({
      where: { resourceId: 'resource-2', locatorType: 'download' },
      data: { downloadAttempts: 0, nextDownloadAttemptAt: null },
    });
  });

  it('scopes the bulk retry to the requested source', async () => {
    const prisma = {
      resource: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    const service = createService({ prisma });

    await (
      service as unknown as {
        retryFailedDownloads: (params: object) => Promise<{ queued: number; skipped: number }>;
      }
    ).retryFailedDownloads({ sourceId: 'source-1', limit: 5 });

    expect(prisma.resource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 5,
        where: expect.objectContaining({ sourceId: 'source-1' }),
      }),
    );
    for (const [args] of prisma.resource.count.mock.calls) {
      expect((args as { where: { sourceId: unknown } }).where.sourceId).toBe('source-1');
    }
  });
});

describe('IngestionService download storage cleanup', () => {
  const remote = {
    externalId: 'remote-1',
    url: 'https://example.com/a.jpg',
    resourceType: 'image',
    mimeType: 'image/jpeg',
  };
  const downloaded = (storageKey: string) => ({
    sha256: 'a'.repeat(64),
    mimeType: 'image/jpeg',
    extension: 'jpg',
    resourceType: 'image',
    sizeBytes: 10,
    storageKey,
  });

  function invokeDownload(service: IngestionService, jobControl?: object) {
    return (
      service as unknown as {
        downloadRemoteFile: (
          resourceId: string,
          locatorId: string,
          remote: object,
          jobControl?: object,
        ) => Promise<'downloaded' | 'failed'>;
      }
    ).downloadRemoteFile('resource-1', 'locator-1', remote, jobControl);
  }

  function makeCommitTx(overrides: Record<string, unknown> = {}) {
    return {
      resource: {
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({}),
      },
      resourceFile: { create: vi.fn().mockResolvedValue({}) },
      resourceLocator: { update: vi.fn().mockResolvedValue({}) },
      sourceItemLedger: { upsert: vi.fn().mockResolvedValue({}) },
      ingestionJob: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      ...overrides,
    };
  }

  it('removes the stored object when the commit transaction fails', async () => {
    const tx = makeCommitTx();
    const prisma = {
      $transaction: vi.fn(async (callback: (t: object) => Promise<unknown>) => callback(tx)),
      resourceLocator: { update: vi.fn().mockResolvedValue({ downloadAttempts: 1 }) },
    };
    const storage = { delete: vi.fn().mockResolvedValue(undefined) };
    const fileRepo = { findStoragePathReferences: vi.fn().mockResolvedValue(new Map()) };
    // 事务里的 resource.update 失败（模拟 SQLITE_BUSY 等）
    tx.resource.update.mockRejectedValue(new Error('database is locked'));
    const service = createService({
      prisma,
      directDownload: { download: vi.fn().mockResolvedValue(downloaded('originals/ab/cd/a.jpg')) },
      storage,
      fileRepo,
    });

    await expect(invokeDownload(service)).resolves.toBe('failed');

    expect(fileRepo.findStoragePathReferences).toHaveBeenCalledWith(['originals/ab/cd/a.jpg']);
    expect(storage.delete).toHaveBeenCalledWith('originals/ab/cd/a.jpg');
  });

  it('keeps the stored object when another resource already references it', async () => {
    const prisma = {
      $transaction: vi.fn().mockRejectedValue(new Error('database is locked')),
      resourceLocator: { update: vi.fn().mockResolvedValue({ downloadAttempts: 1 }) },
    };
    const storage = { delete: vi.fn().mockResolvedValue(undefined) };
    const fileRepo = {
      findStoragePathReferences: vi
        .fn()
        .mockResolvedValue(new Map([['originals/ab/cd/a.jpg', new Set(['another-resource'])]])),
    };
    const service = createService({
      prisma,
      directDownload: { download: vi.fn().mockResolvedValue(downloaded('originals/ab/cd/a.jpg')) },
      storage,
      fileRepo,
    });

    await expect(invokeDownload(service)).resolves.toBe('failed');
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('removes the stored object when the job was canceled before commit', async () => {
    // 下载完成、事务提交时发现租约已失效 → 事务回滚并抛取消错误
    const tx = makeCommitTx({
      ingestionJob: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    });
    const prisma = {
      $transaction: vi.fn(async (callback: (t: object) => Promise<unknown>) => callback(tx)),
    };
    const storage = { delete: vi.fn().mockResolvedValue(undefined) };
    const fileRepo = { findStoragePathReferences: vi.fn().mockResolvedValue(new Map()) };
    const service = createService({
      prisma,
      directDownload: { download: vi.fn().mockResolvedValue(downloaded('originals/ab/cd/a.jpg')) },
      storage,
      fileRepo,
      jobRepo: { isProcessing: vi.fn().mockResolvedValue(true) },
    });

    await expect(
      invokeDownload(service, { id: 'job-1', leaseToken: 'lease-1', completeOnCommit: true }),
    ).rejects.toThrow();

    expect(storage.delete).toHaveBeenCalledWith('originals/ab/cd/a.jpg');
  });

  it('removes the stored object when the job was canceled while the file was being stored', async () => {
    const storage = { delete: vi.fn().mockResolvedValue(undefined) };
    const fileRepo = { findStoragePathReferences: vi.fn().mockResolvedValue(new Map()) };
    // 下载期间任务被取消：download() 正常返回（对象已落盘），返回后的检查点必须发现并回收
    const service = createService({
      prisma: {},
      directDownload: { download: vi.fn().mockResolvedValue(downloaded('originals/ab/cd/a.jpg')) },
      storage,
      fileRepo,
      jobRepo: { isProcessing: vi.fn().mockResolvedValue(false) },
    });

    await expect(invokeDownload(service, { id: 'job-1', leaseToken: 'lease-1' })).rejects.toThrow();

    expect(storage.delete).toHaveBeenCalledWith('originals/ab/cd/a.jpg');
  });

  it('removes the previous attempt object before retrying a transient commit failure', async () => {
    const tx = makeCommitTx();
    const prisma = {
      $transaction: vi
        .fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockImplementation(async (callback: (t: object) => Promise<unknown>) => callback(tx)),
      resourceLocator: { update: vi.fn().mockResolvedValue({ downloadAttempts: 1 }) },
    };
    const storage = { delete: vi.fn().mockResolvedValue(undefined) };
    const fileRepo = { findStoragePathReferences: vi.fn().mockResolvedValue(new Map()) };
    const download = vi
      .fn()
      .mockResolvedValueOnce(downloaded('originals/ab/cd/first.jpg'))
      .mockResolvedValueOnce(downloaded('originals/ab/cd/second.jpg'));
    const service = createService({
      prisma,
      directDownload: { download },
      storage,
      fileRepo,
      scheduler: { enqueue: vi.fn().mockResolvedValue(undefined) },
    });

    vi.useFakeTimers();
    try {
      const promise = invokeDownload(service);
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBe('downloaded');
    } finally {
      vi.useRealTimers();
    }

    expect(download).toHaveBeenCalledTimes(2);
    expect(storage.delete).toHaveBeenCalledWith('originals/ab/cd/first.jpg');
    // 成功提交的那次对象归数据库记录所有，不能删
    expect(storage.delete).not.toHaveBeenCalledWith('originals/ab/cd/second.jpg');
  });

  it('removes the stored object when a concurrent sync already owns the file record', async () => {
    // 并发同步先建了 resourceFile（P2002 被忽略），本次写入的 key 可能没有被引用
    const tx = makeCommitTx({
      resourceFile: {
        create: vi.fn().mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          }),
        ),
      },
    });
    const prisma = {
      $transaction: vi.fn(async (callback: (t: object) => Promise<unknown>) => callback(tx)),
      resourceLocator: { update: vi.fn().mockResolvedValue({ downloadAttempts: 1 }) },
    };
    const storage = { delete: vi.fn().mockResolvedValue(undefined) };
    const fileRepo = { findStoragePathReferences: vi.fn().mockResolvedValue(new Map()) };
    const service = createService({
      prisma,
      directDownload: { download: vi.fn().mockResolvedValue(downloaded('originals/ab/cd/a.jpg')) },
      storage,
      fileRepo,
      scheduler: { enqueue: vi.fn().mockResolvedValue(undefined) },
    });

    await expect(invokeDownload(service)).resolves.toBe('downloaded');
    expect(fileRepo.findStoragePathReferences).toHaveBeenCalledWith(['originals/ab/cd/a.jpg']);
    expect(storage.delete).toHaveBeenCalledWith('originals/ab/cd/a.jpg');
  });
});

describe('IngestionService batch mirror', () => {
  const eligibleResource = {
    id: 'res-ok',
    sourceId: 'source-1',
    deletedAt: null,
    files: [],
    locators: [{ locatorType: 'download' }],
  };

  function createBatchService(resources: Record<string, object | null>) {
    const prisma = {
      resource: {
        findUnique: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => {
          return resources[where.id] ?? null;
        }),
      },
      resourceLocator: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const jobRepo = {
      findActiveByIdempotencyKey: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async (data: { resourceId: string }) => ({
        id: `job-${data.resourceId}`,
      })),
    };
    const sourceRepo = {
      findById: vi.fn().mockImplementation(async (sourceId: string) => {
        if (sourceId === 'source-disabled') {
          return {
            id: sourceId,
            enabled: false,
            allowedModes: 'mirror_file',
            requiresReview: false,
          };
        }
        if (sourceId === 'source-link-only') {
          return { id: sourceId, enabled: true, allowedModes: 'link_only', requiresReview: false };
        }
        return {
          id: sourceId,
          enabled: true,
          allowedModes: 'mirror_file,metadata_only',
          requiresReview: false,
        };
      }),
    };
    return { service: createService({ prisma, jobRepo, sourceRepo }), prisma, jobRepo, sourceRepo };
  }

  it('queues eligible resources and reports why each other resource was skipped', async () => {
    const { service, jobRepo } = createBatchService({
      'res-ok': eligibleResource,
      'res-local': { ...eligibleResource, id: 'res-local', files: [{ id: 'file-1' }] },
      'res-no-url': { ...eligibleResource, id: 'res-no-url', locators: [] },
      'res-deleted': { ...eligibleResource, id: 'res-deleted', deletedAt: new Date() },
      'res-disabled': { ...eligibleResource, id: 'res-disabled', sourceId: 'source-disabled' },
      'res-link-only': { ...eligibleResource, id: 'res-link-only', sourceId: 'source-link-only' },
      'res-no-source': { ...eligibleResource, id: 'res-no-source', sourceId: null },
    });

    const result = await service.mirrorRemoteResources([
      'res-ok',
      'res-local',
      'res-no-url',
      'res-deleted',
      'res-disabled',
      'res-link-only',
      'res-no-source',
      'res-missing',
    ]);

    expect(result.queued).toBe(1);
    expect(result.skipped).toBe(7);
    expect(
      Object.fromEntries(result.skippedResources.map((item) => [item.id, item.reason])),
    ).toEqual({
      'res-local': 'already_local',
      'res-no-url': 'no_source_url',
      'res-deleted': 'deleted',
      'res-disabled': 'policy',
      'res-link-only': 'policy',
      'res-no-source': 'no_source',
      'res-missing': 'not_found',
    });
    // 只有可下载的资源真正入队
    expect(jobRepo.create).toHaveBeenCalledTimes(1);
    expect(jobRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'res-ok', jobType: 'download_file' }),
    );
  });

  it('deduplicates resource ids so a repeated selection enqueues only once', async () => {
    const { service, prisma, jobRepo } = createBatchService({ 'res-ok': eligibleResource });

    const result = await service.mirrorRemoteResources(['res-ok', 'res-ok', 'res-ok']);

    expect(result).toMatchObject({ resourceIds: ['res-ok'], queued: 1, skipped: 0 });
    expect(prisma.resource.findUnique).toHaveBeenCalledTimes(1);
    expect(jobRepo.create).toHaveBeenCalledTimes(1);
  });

  it('rejects batches larger than the server limit before touching resources', async () => {
    const prisma = { resource: { findUnique: vi.fn() } };
    const service = createService({ prisma });
    const ids = Array.from(
      { length: MAX_BATCH_MIRROR_RESOURCES + 1 },
      (_, index) => `resource-${index}`,
    );

    await expect(service.mirrorRemoteResources(ids)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.resource.findUnique).not.toHaveBeenCalled();
  });
});

describe('IngestionService manual download rate limit', () => {
  const source = {
    id: 'source-1',
    enabled: true,
    allowedModes: 'mirror_file',
    requiresReview: false,
    rateLimitPerMinute: 1,
    downloadIntervalMs: 0,
    downloadDirectory: null,
    sourceType: 'civitai',
  };
  const resource = {
    id: 'res-1',
    sourceId: 'source-1',
    deletedAt: null,
    files: [],
    locators: [{ id: 'loc-1', locatorType: 'download', url: 'https://example.com/a.jpg' }],
  };

  it('paces downloads per source and applies a new rate config without resetting the wait', () => {
    vi.useFakeTimers();
    try {
      const service = createService({});
      const reserve = (
        service as unknown as { reserveSourceDownloadSlot: (input: object) => number }
      ).reserveSourceDownloadSlot.bind(service);
      const perMinute60 = { id: 'source-1', rateLimitPerMinute: 60, downloadIntervalMs: 0 };

      expect(reserve(perMinute60)).toBe(0);
      expect(reserve(perMinute60)).toBeGreaterThan(0);
      // 其它来源互不影响
      expect(reserve({ ...perMinute60, id: 'source-2' })).toBe(0);
      // 配置变化不重置已有等待窗口：同步持有旧快照、手动读取新配置时，
      // 若每次都重置并放行，会交替产生突发下载。
      expect(reserve({ ...perMinute60, rateLimitPerMinute: 1 })).toBeGreaterThan(0);

      vi.advanceTimersByTime(1_000);
      // 旧窗口到期后按新配置重新计时
      expect(reserve({ ...perMinute60, rateLimitPerMinute: 1 })).toBe(0);
      expect(reserve({ ...perMinute60, rateLimitPerMinute: 1 })).toBeGreaterThan(50_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('defers the job instead of blocking the ingestion queue when the slot is exhausted', async () => {
    const prisma = { resource: { findUnique: vi.fn().mockResolvedValue(resource) } };
    const sourceRepo = { findById: vi.fn().mockResolvedValue(source) };
    const jobRepo = { release: vi.fn().mockResolvedValue(true) };
    const directDownload = { download: vi.fn() };
    const service = createService({ prisma, sourceRepo, jobRepo, directDownload });
    const internals = service as unknown as {
      reserveSourceDownloadSlot: (input: object) => number;
      manualDownloadPriorityUntil: Map<string, number>;
      runDownloadResourceJob: (job: object, leaseToken: string) => Promise<void>;
    };
    // 占掉当前速率槽：队列里的下一个同来源任务必须等待
    expect(internals.reserveSourceDownloadSlot(source)).toBe(0);

    await internals.runDownloadResourceJob(
      { id: 'job-1', request: JSON.stringify({ resourceId: 'res-1' }) },
      'lease-1',
    );

    // 不阻塞摄入队列：任务被释放并按剩余间隔延迟重排，下载没有开始
    expect(jobRepo.release).toHaveBeenCalledWith('job-1', 'lease-1', expect.any(Number));
    expect(directDownload.download).not.toHaveBeenCalled();
    // 同时给该来源留下优先窗口，避免同步等待者把手动任务一直挤在后面
    expect(internals.manualDownloadPriorityUntil.get(source.id)).toBeGreaterThan(Date.now());
  });

  it('leaves the job for stale recovery instead of failing it when release throws', async () => {
    const prisma = { resource: { findUnique: vi.fn().mockResolvedValue(resource) } };
    const sourceRepo = { findById: vi.fn().mockResolvedValue(source) };
    const jobRepo = { release: vi.fn().mockRejectedValue(new Error('SQLITE_BUSY')) };
    const directDownload = { download: vi.fn() };
    const service = createService({ prisma, sourceRepo, jobRepo, directDownload });
    const internals = service as unknown as {
      reserveSourceDownloadSlot: (input: object) => number;
      runDownloadResourceJob: (job: object, leaseToken: string) => Promise<void>;
    };
    internals.reserveSourceDownloadSlot(source);

    // release 抛错时不能让 runNextJob 把任务标记为终态失败：
    // 保持 processing，等 stale 恢复重新排队即可自动重试。
    await expect(
      internals.runDownloadResourceJob(
        { id: 'job-1', request: JSON.stringify({ resourceId: 'res-1' }) },
        'lease-1',
      ),
    ).resolves.toBeUndefined();
    expect(directDownload.download).not.toHaveBeenCalled();
  });

  it('shares the source budget between blocking sync waits and manual downloads', async () => {
    vi.useFakeTimers();
    try {
      const service = createService({});
      const internals = service as unknown as {
        reserveSourceDownloadSlot: (input: object) => number;
        waitForSourceDownloadSlot: (input: object) => Promise<void>;
      };
      const perMinute60 = { id: 'source-shared', rateLimitPerMinute: 60, downloadIntervalMs: 0 };
      expect(internals.reserveSourceDownloadSlot(perMinute60)).toBe(0);

      let resolved = false;
      const waiting = internals.waitForSourceDownloadSlot(perMinute60).then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      await waiting;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a deferred manual download take the next slot before sync waiters', async () => {
    vi.useFakeTimers();
    try {
      const service = createService({});
      const internals = service as unknown as {
        manualDownloadPriorityUntil: Map<string, number>;
        waitForSourceDownloadSlot: (input: object) => Promise<void>;
      };
      const source = { id: 'source-priority', rateLimitPerMinute: 60, downloadIntervalMs: 0 };
      internals.manualDownloadPriorityUntil.set(source.id, Date.now() + 1_000);

      let resolved = false;
      const waiting = internals.waitForSourceDownloadSlot(source).then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      await waiting;
      expect(resolved).toBe(true);
      // 优先窗口用完后必须清理，不能永久卡住同步下载
      expect(internals.manualDownloadPriorityUntil.has(source.id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops waiting when the sync job is canceled', async () => {
    vi.useFakeTimers();
    try {
      const service = createService({});
      const internals = service as unknown as {
        reserveSourceDownloadSlot: (input: object) => number;
        waitForSourceDownloadSlot: (
          input: object,
          assertActive?: () => Promise<void>,
        ) => Promise<void>;
      };
      const source = { id: 'source-cancel', rateLimitPerMinute: 60, downloadIntervalMs: 0 };
      // 先占掉槽位，强制等待循环至少走一轮
      expect(internals.reserveSourceDownloadSlot(source)).toBe(0);

      const assertActive = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('canceled'));
      const waiting = internals.waitForSourceDownloadSlot(source, assertActive);
      const assertion = expect(waiting).rejects.toThrow('canceled');
      await vi.advanceTimersByTimeAsync(300);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('IngestionService sync job deferral', () => {
  it('does not fail the sync job when release throws while another sync is running', async () => {
    const jobRepo = {
      claimNext: vi.fn().mockResolvedValue({
        id: 'sync-job',
        jobType: 'sync_source',
        leaseToken: 'lease-1',
        request: JSON.stringify({ sourceId: 'source-1' }),
      }),
      release: vi.fn().mockRejectedValue(new Error('SQLITE_BUSY')),
      fail: vi.fn(),
    };
    const service = createService({
      jobRepo,
      config: { get: vi.fn().mockReturnValue(3000) },
    });
    (service as unknown as { syncJobRunning: boolean }).syncJobRunning = true;

    await expect(service.runNextJob()).resolves.toBe(true);
    // release 失败只记录 warning，不能把任务标记为终态失败
    expect(jobRepo.fail).not.toHaveBeenCalled();
  });
});

describe('IngestionService download heartbeat', () => {
  it('refreshes startedAt during a download longer than the stale timeout', async () => {
    vi.useFakeTimers();
    try {
      const prisma = {
        ingestionJob: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        resourceLocator: { update: vi.fn().mockResolvedValue({ downloadAttempts: 1 }) },
      };
      let rejectDownload!: (error: Error) => void;
      const download = vi.fn().mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectDownload = reject;
          }),
      );
      const service = createService({
        prisma,
        directDownload: { download },
        config: {
          get: vi.fn((key: string) => (key === 'ingestion.staleJobTimeoutMs' ? 60_000 : undefined)),
        },
      });
      const promise = (
        service as unknown as {
          downloadRemoteFile: (
            resourceId: string,
            locatorId: string,
            remote: object,
            jobControl: object,
          ) => Promise<string>;
        }
      ).downloadRemoteFile(
        'resource-1',
        'locator-1',
        {
          externalId: 'remote-1',
          url: 'https://example.com/a.jpg',
          resourceType: 'image',
          mimeType: 'image/jpeg',
        },
        { id: 'job-1', leaseToken: 'lease-1' },
      );

      // stale 60s → 心跳间隔 5s：4s 时不应写心跳，超过 5s 后必须刷新
      await vi.advanceTimersByTimeAsync(4_000);
      expect(prisma.ingestionJob.updateMany).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(prisma.ingestionJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'job-1', status: 'processing', leaseToken: 'lease-1' },
          data: { startedAt: expect.any(Date) },
        }),
      );

      rejectDownload(new Error('HTTP 403'));
      await expect(promise).resolves.toBe('failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('derives the heartbeat interval from the configured stale timeout', () => {
    const makeService = (staleTimeoutMs: number | undefined) =>
      createService({
        config: {
          get: vi.fn((key: string) =>
            key === 'ingestion.staleJobTimeoutMs' ? staleTimeoutMs : undefined,
          ),
        },
      });
    const resolveInterval = (service: object) =>
      (
        service as unknown as { resolveJobHeartbeatIntervalMs: () => number }
      ).resolveJobHeartbeatIntervalMs.bind(service);

    expect(resolveInterval(makeService(60_000))()).toBe(5_000);
    // stale 被调小时心跳同比收缩
    expect(resolveInterval(makeService(6_000))()).toBe(2_000);
    // 缺失 / 0 / NaN 回退默认 60s，不能算出 NaN 让心跳失效
    expect(resolveInterval(makeService(undefined))()).toBe(5_000);
    expect(resolveInterval(makeService(0))()).toBe(5_000);
    expect(resolveInterval(makeService(Number.NaN))()).toBe(5_000);
  });
});
