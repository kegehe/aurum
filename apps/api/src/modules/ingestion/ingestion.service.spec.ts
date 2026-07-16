import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { SafeUrlService } from '../../common/security/safe-url.service';
import { IngestionJobStatus, IngestionJobType } from '../../common/constants/enums';
import { IngestionService } from './ingestion.service';

function createService(baseUrl: string | null) {
  const prisma = {
    source: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'source-1',
        enabled: true,
        allowedModes: 'link_only,metadata_only',
        baseUrl,
      }),
    },
  };
  const sourceRepo = {
    findById: vi.fn().mockResolvedValue({
      id: 'source-1',
      enabled: true,
      allowedModes: 'link_only,metadata_only',
      baseUrl,
    }),
  };
  const service = new IngestionService(
    prisma as never,
    {} as never,
    sourceRepo as never,
    {} as never,
    new SafeUrlService(),
    {} as never,
  );
  return { service, prisma, sourceRepo };
}

describe('IngestionService source URL policy', () => {
  it('accepts a URL under the configured source base URL', async () => {
    const { service } = createService('https://example.com/assets');

    await expect(
      (service as unknown as { assertLinkImportAllowed: (sourceId: string, url: string) => Promise<void> })
        .assertLinkImportAllowed('source-1', 'https://example.com/assets/icons/logo.svg'),
    ).resolves.toBeUndefined();
  });

  it('treats a trailing slash on the source base URL as equivalent', async () => {
    const { service } = createService('https://example.com/assets/');

    await expect(
      (service as unknown as { assertLinkImportAllowed: (sourceId: string, url: string) => Promise<void> })
        .assertLinkImportAllowed('source-1', 'https://example.com/assets'),
    ).resolves.toBeUndefined();
  });

  it('rejects a URL from a different origin or path', async () => {
    const { service } = createService('https://example.com/assets');
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
    const service = new IngestionService(
      {} as never,
      jobRepo as never,
      sourceRepo as never,
      resourceRepo as never,
      new SafeUrlService(),
      connector as never,
    );

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
    const service = new IngestionService(
      {} as never,
      jobRepo as never,
      {} as never,
      {} as never,
      new SafeUrlService(),
      {} as never,
    );

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
      findActiveByIdempotencyKey: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(activeJob),
      retryIfRetryable: vi.fn().mockResolvedValue(null),
    };
    const service = new IngestionService(
      {} as never,
      jobRepo as never,
      {} as never,
      {} as never,
      new SafeUrlService(),
      {} as never,
    );

    await expect(service.retryJob('failed-job')).resolves.toEqual(activeJob);
    expect(jobRepo.retryIfRetryable).toHaveBeenCalledWith('failed-job');
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
    const service = new IngestionService(
      prisma as never,
      jobRepo as never,
      {} as never,
      {} as never,
      new SafeUrlService(),
      {} as never,
    );

    await expect(
      service.createLinkImport({
        url: 'https://example.com/resource',
        categoryId: '0d21f2f2-1fa0-4db0-a8b7-f31d23f220b0',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(jobRepo.create).not.toHaveBeenCalled();
  });

  it('rejects unknown tags before creating an ingestion task', async () => {
    const jobRepo = {
      findActiveByIdempotencyKey: vi.fn(),
      create: vi.fn(),
    };
    const prisma = {
      tag: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = new IngestionService(
      prisma as never,
      jobRepo as never,
      {} as never,
      {} as never,
      new SafeUrlService(),
      {} as never,
    );

    await expect(
      service.createLinkImport({
        url: 'https://example.com/resource',
        tagIds: ['0d21f2f2-1fa0-4db0-a8b7-f31d23f220b0'],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(jobRepo.create).not.toHaveBeenCalled();
  });
});

describe('IngestionService existing link reuse', () => {
  it('merges explicit title, category and tags into an existing link resource', async () => {
    const jobRepo = {
      claimNext: vi.fn().mockResolvedValue({
        id: 'job-1',
        leaseToken: 'lease-1',
        jobType: IngestionJobType.import_url,
        request: JSON.stringify({
          url: 'https://example.com/resource',
          title: 'Updated title',
          categoryId: 'category-1',
          tagIds: ['tag-1'],
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
      resourceTag: { create: vi.fn().mockResolvedValue({ resourceId: 'resource-1', tagId: 'tag-1' }) },
    };
    const connector = {
      type: 'link_metadata',
      inspect: vi.fn().mockResolvedValue({
        finalUrl: 'https://example.com/resource',
        canonicalUrl: 'https://example.com/resource',
      }),
    };
    const service = new IngestionService(
      prisma as never,
      jobRepo as never,
      {} as never,
      resourceRepo as never,
      new SafeUrlService(),
      connector as never,
    );

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
    expect(prisma.resourceTag.create).toHaveBeenCalledWith({
      data: { resourceId: 'resource-1', tagId: 'tag-1' },
    });
    expect(jobRepo.complete).toHaveBeenCalledWith(
      'job-1',
      'lease-1',
      'resource-1',
      JSON.stringify({ canonicalUrl: 'https://example.com/resource' }),
    );
  });

  it('treats a concurrently-created tag association as already linked', async () => {
    const jobRepo = {
      claimNext: vi.fn().mockResolvedValue({
        id: 'job-1',
        leaseToken: 'lease-1',
        jobType: IngestionJobType.import_url,
        request: JSON.stringify({ url: 'https://example.com/resource', tagIds: ['tag-1'] }),
      }),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn(),
    };
    const resourceRepo = {
      findByIdentityUrl: vi.fn().mockResolvedValue({
        resourceId: 'resource-1',
        resource: { deletedAt: null },
      }),
    };
    const prisma = {
      resourceTag: {
        create: vi.fn().mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError('Duplicate resource tag', {
            code: 'P2002',
            clientVersion: '5.22.0',
          }),
        ),
      },
    };
    const connector = {
      type: 'link_metadata',
      inspect: vi.fn().mockResolvedValue({
        finalUrl: 'https://example.com/resource',
        canonicalUrl: 'https://example.com/resource',
      }),
    };
    const service = new IngestionService(
      prisma as never,
      jobRepo as never,
      {} as never,
      resourceRepo as never,
      new SafeUrlService(),
      connector as never,
    );

    await service.runNextJob();

    expect(jobRepo.complete).toHaveBeenCalled();
    expect(jobRepo.fail).not.toHaveBeenCalled();
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
    const service = new IngestionService(
      {} as never,
      {} as never,
      sourceRepo as never,
      {} as never,
      new SafeUrlService(),
      {} as never,
    );

    await expect(
      (service as unknown as { assertLinkImportAllowed: (sourceId: string, url: string) => Promise<void> })
        .assertLinkImportAllowed('source-1', 'https://example.com/page'),
    ).resolves.toBeUndefined();

    expect(sourceRepo.findById).toHaveBeenCalledWith('source-1');
  });
});
