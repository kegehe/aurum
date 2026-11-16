import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { SourceType } from '../../common/constants/enums';
import { SourceService } from './source.service';

/** 可控的 fs.readdir mock，供 listDownloadDirectories 测试注入目录/抛错 */
const { readdirMock } = vi.hoisted(() => ({ readdirMock: vi.fn() }));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readdir: readdirMock };
});

function createService(repoOverrides: Record<string, unknown> = {}) {
  const sourceRepo = {
    findById: vi.fn(),
    findBySlug: vi.fn(),
    findMany: vi.fn(),
    findDownloadDirectories: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    ...repoOverrides,
  };
  const config = { get: vi.fn(() => './storage') };
  const service = new SourceService(sourceRepo as never, config as never);
  return { service, sourceRepo, config };
}

describe('SourceService', () => {
  describe('createSource', () => {
    it('rejects a duplicate slug', async () => {
      const { service, sourceRepo } = createService();
      sourceRepo.findBySlug.mockResolvedValue({ id: 'existing' });

      await expect(
        service.createSource({
          name: 'Test',
          slug: 'test-source',
          sourceType: SourceType.link_metadata,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects invalid allowedModes values', async () => {
      const { service, sourceRepo } = createService();
      sourceRepo.findBySlug.mockResolvedValue(null);

      await expect(
        service.createSource({
          name: 'Test',
          slug: 'test-source',
          sourceType: SourceType.link_metadata,
          allowedModes: 'link_only,invalid_mode',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a download folder that does not exist', async () => {
      const { service, sourceRepo } = createService({
        findCategoryById: vi.fn().mockResolvedValue(null),
      });
      sourceRepo.findBySlug.mockResolvedValue(null);

      await expect(
        service.createSource({
          name: 'Test',
          slug: 'test-source',
          sourceType: SourceType.link_metadata,
          downloadCategoryId: 'missing-folder',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(sourceRepo.create).not.toHaveBeenCalled();
    });

    it('stores the configured download folder id', async () => {
      const { service, sourceRepo } = createService({
        findCategoryById: vi.fn().mockResolvedValue({ id: 'folder-1' }),
      });
      sourceRepo.findBySlug.mockResolvedValue(null);
      sourceRepo.create.mockResolvedValue({ id: 'new-source' });

      await service.createSource({
        name: 'Test',
        slug: 'test-source',
        sourceType: SourceType.civitai,
        downloadCategoryId: 'folder-1',
      });

      expect(sourceRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ downloadCategoryId: 'folder-1' }),
      );
    });

    it('creates a source with default values', async () => {
      const { service, sourceRepo } = createService();
      sourceRepo.findBySlug.mockResolvedValue(null);
      sourceRepo.create.mockResolvedValue({ id: 'new-source' });

      await service.createSource({
        name: 'Test',
        slug: 'test-source',
        sourceType: SourceType.link_metadata,
      });

      expect(sourceRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Test',
          slug: 'test-source',
          sourceType: SourceType.link_metadata,
          enabled: true,
          allowedModes: 'link_only,mirror_file',
          rateLimitPerMinute: 30,
          maxConcurrency: 1,
          requiresReview: false,
        }),
      );
    });

    it('passes autoSyncIntervalHours to the repository', async () => {
      const { service, sourceRepo } = createService();
      sourceRepo.findBySlug.mockResolvedValue(null);
      sourceRepo.create.mockResolvedValue({ id: 'new-source' });

      await service.createSource({
        name: 'Test',
        slug: 'test-source',
        sourceType: SourceType.link_metadata,
        autoSyncIntervalHours: 24,
      });

      expect(sourceRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ autoSyncIntervalHours: 24 }),
      );
    });

    it('handles P2002 unique constraint violation as slug conflict', async () => {
      const { service, sourceRepo } = createService();
      sourceRepo.findBySlug.mockResolvedValue(null);
      sourceRepo.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.22.0',
        }),
      );

      await expect(
        service.createSource({
          name: 'Test',
          slug: 'test-source',
          sourceType: SourceType.link_metadata,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('updateSource', () => {
    it('rejects updating a non-existent source', async () => {
      const { service, sourceRepo } = createService();
      sourceRepo.findById.mockResolvedValue(null);

      await expect(service.updateSource('missing', { name: 'Updated' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects updating slug to an already-taken value', async () => {
      const { service, sourceRepo } = createService();
      sourceRepo.findById.mockResolvedValue({ id: 'source-1', slug: 'old-slug' });
      sourceRepo.findBySlug.mockResolvedValue({ id: 'source-2', slug: 'taken-slug' });

      await expect(service.updateSource('source-1', { slug: 'taken-slug' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('allows updating slug to its own current value', async () => {
      const { service, sourceRepo } = createService();
      sourceRepo.findById.mockResolvedValue({ id: 'source-1', slug: 'same-slug' });
      sourceRepo.update.mockResolvedValue({ id: 'source-1', slug: 'same-slug' });

      const _result = await service.updateSource('source-1', { slug: 'same-slug' });
      expect(sourceRepo.update).toHaveBeenCalled();
    });

    it('clears autoSyncIntervalHours when null is passed', async () => {
      const { service, sourceRepo } = createService();
      sourceRepo.findById.mockResolvedValue({ id: 'source-1', slug: 'same-slug' });
      sourceRepo.update.mockResolvedValue({ id: 'source-1' });

      await service.updateSource('source-1', { autoSyncIntervalHours: null });

      expect(sourceRepo.update).toHaveBeenCalledWith(
        'source-1',
        expect.objectContaining({ autoSyncIntervalHours: null }),
      );
    });

    it('updates autoSyncIntervalHours to the given value', async () => {
      const { service, sourceRepo } = createService();
      sourceRepo.findById.mockResolvedValue({ id: 'source-1', slug: 'same-slug' });
      sourceRepo.update.mockResolvedValue({ id: 'source-1' });

      await service.updateSource('source-1', { autoSyncIntervalHours: 6 });

      expect(sourceRepo.update).toHaveBeenCalledWith(
        'source-1',
        expect.objectContaining({ autoSyncIntervalHours: 6 }),
      );
    });

    it('clears downloadCategoryId when null is passed', async () => {
      const { service, sourceRepo } = createService();
      sourceRepo.findById.mockResolvedValue({ id: 'source-1', slug: 'same-slug' });
      sourceRepo.update.mockResolvedValue({ id: 'source-1' });

      await service.updateSource('source-1', { downloadCategoryId: null });

      expect(sourceRepo.update).toHaveBeenCalledWith(
        'source-1',
        expect.objectContaining({ downloadCategoryId: null }),
      );
    });

    it('rejects updating to a non-existent download folder', async () => {
      const { service, sourceRepo } = createService({
        findCategoryById: vi.fn().mockResolvedValue(null),
      });
      sourceRepo.findById.mockResolvedValue({ id: 'source-1', slug: 'same-slug' });

      await expect(
        service.updateSource('source-1', { downloadCategoryId: 'missing-folder' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(sourceRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteSource', () => {
    it('deletes a source even when it has associated resources', async () => {
      const { service, sourceRepo } = createService();
      // 方案 B：有关联资源的来源也可删除，repo 直接返回 deleted: true
      sourceRepo.delete.mockResolvedValue({ deleted: true });

      await expect(service.deleteSource('source-1')).resolves.toEqual({
        id: 'source-1',
        deleted: true,
      });
    });

    it('rejects deleting a non-existent source', async () => {
      const { service, sourceRepo } = createService();
      sourceRepo.delete.mockResolvedValue({ deleted: false, reason: 'not_found' });

      await expect(service.deleteSource('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('deletes a source with no associations', async () => {
      const { service, sourceRepo } = createService();
      sourceRepo.delete.mockResolvedValue({ deleted: true });

      const result = await service.deleteSource('source-1');
      expect(result).toEqual({ id: 'source-1', deleted: true });
    });
  });

  describe('getSource', () => {
    it('throws NotFoundException for missing source', async () => {
      const { service, sourceRepo } = createService();
      sourceRepo.findById.mockResolvedValue(null);

      await expect(service.getSource('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('allowedModes validation', () => {
    it('accepts valid comma-separated modes', async () => {
      const { service, sourceRepo } = createService();
      sourceRepo.findBySlug.mockResolvedValue(null);
      sourceRepo.create.mockResolvedValue({ id: 'new' });

      await service.createSource({
        name: 'Test',
        slug: 'test',
        sourceType: SourceType.link_metadata,
        allowedModes: 'link_only,metadata_only',
      });

      expect(sourceRepo.create).toHaveBeenCalled();
    });

    it('rejects modes that are not valid AcquisitionMode values', async () => {
      const { service, sourceRepo } = createService();
      sourceRepo.findBySlug.mockResolvedValue(null);

      await expect(
        service.createSource({
          name: 'Test',
          slug: 'test',
          sourceType: SourceType.link_metadata,
          allowedModes: 'link_only,invalid_mode',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('listDownloadDirectories', () => {
    it('unions DB directories with existing top-level custom dirs, excluding system role dirs', async () => {
      const { service } = createService({
        findDownloadDirectories: vi.fn().mockResolvedValue([
          { downloadDirectory: 'civitai/anime' },
          { downloadDirectory: 'civitai/real' },
          { downloadDirectory: null },
        ]),
      });
      readdirMock.mockResolvedValue([
        { name: 'originals', isDirectory: () => true },
        { name: 'temp', isDirectory: () => true },
        { name: 'civitai', isDirectory: () => true },
        { name: 'my-dir', isDirectory: () => true },
        { name: 'file.txt', isDirectory: () => false },
        { name: '_internal', isDirectory: () => true },
        { name: '.hidden', isDirectory: () => true },
      ]);

      const dirs = await service.listDownloadDirectories();

      expect(dirs).toEqual(['civitai', 'civitai/anime', 'civitai/real', 'my-dir']);
    });

    it('returns only DB directories when the storage root does not exist', async () => {
      const { service } = createService({
        findDownloadDirectories: vi.fn().mockResolvedValue([
          { downloadDirectory: 'civitai/anime' },
        ]),
      });
      readdirMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const dirs = await service.listDownloadDirectories();

      expect(dirs).toEqual(['civitai/anime']);
    });
  });
});
