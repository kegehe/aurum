import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { SourceType } from '../../common/constants/enums';
import { SourceService } from './source.service';

function createService() {
  const sourceRepo = {
    findById: vi.fn(),
    findBySlug: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const service = new SourceService(sourceRepo as never);
  return { service, sourceRepo };
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
          allowedModes: 'link_only,metadata_only',
          rateLimitPerMinute: 30,
          maxConcurrency: 1,
          requiresReview: false,
        }),
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

      await expect(
        service.updateSource('missing', { name: 'Updated' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects updating slug to an already-taken value', async () => {
      const { service, sourceRepo } = createService();
      sourceRepo.findById.mockResolvedValue({ id: 'source-1', slug: 'old-slug' });
      sourceRepo.findBySlug.mockResolvedValue({ id: 'source-2', slug: 'taken-slug' });

      await expect(
        service.updateSource('source-1', { slug: 'taken-slug' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('allows updating slug to its own current value', async () => {
      const { service, sourceRepo } = createService();
      sourceRepo.findById.mockResolvedValue({ id: 'source-1', slug: 'same-slug' });
      sourceRepo.update.mockResolvedValue({ id: 'source-1', slug: 'same-slug' });

      const _result = await service.updateSource('source-1', { slug: 'same-slug' });
      expect(sourceRepo.update).toHaveBeenCalled();
    });
  });

  describe('deleteSource', () => {
    it('rejects deleting a source with associated resources', async () => {
      const { service, sourceRepo } = createService();
      sourceRepo.delete.mockResolvedValue({ deleted: false, reason: 'has_resources' });

      await expect(
        service.deleteSource('source-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects deleting a non-existent source', async () => {
      const { service, sourceRepo } = createService();
      sourceRepo.delete.mockResolvedValue({ deleted: false, reason: 'not_found' });

      await expect(
        service.deleteSource('missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
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

      await expect(
        service.getSource('missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
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
});
