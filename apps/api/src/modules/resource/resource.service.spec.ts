import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { JobType, ProcessingStatus } from '../../common/constants/enums';
import { ResourceService } from './resource.service';

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function createService() {
  const resourceRepo = {
    batchSetCategory: vi.fn(),
    batchSetFavorite: vi.fn(),
    batchSoftDelete: vi.fn(),
    findActiveOriginalFiles: vi.fn(),
    findByIdWithRelations: vi.fn(),
    findDeletedWithFiles: vi.fn(),
    deleteDeleted: vi.fn(),
    findById: vi.fn(),
    updateProcessingStatus: vi.fn(),
  };
  const fileRepo = {};
  const tagRepo = {
    batchAddToResources: vi.fn(),
    batchRemoveFromResources: vi.fn(),
  };
  const storage = {
    getStream: vi.fn(),
    delete: vi.fn(),
  };
  const scheduler = {
    enqueue: vi.fn(),
  };
  const searchService = {};
  const service = new ResourceService(
    resourceRepo as never,
    fileRepo as never,
    tagRepo as never,
    storage as never,
    scheduler as never,
    searchService as never,
  );

  return { service, resourceRepo, tagRepo, storage, scheduler };
}

describe('ResourceService batch operations', () => {
  it('returns success and failure counts for batch category changes', async () => {
    const { service, resourceRepo } = createService();
    resourceRepo.batchSetCategory.mockResolvedValue(2);

    await expect(service.batchSetCategory(['a', 'b', 'c'], 'cat-1')).resolves.toEqual({
      resourceIds: ['a', 'b', 'c'],
      categoryId: 'cat-1',
      updated: 2,
      failed: 1,
    });
  });

  it('returns success and failure counts for batch favorite changes', async () => {
    const { service, resourceRepo } = createService();
    resourceRepo.batchSetFavorite.mockResolvedValue(1);

    await expect(service.batchSetFavorite(['a', 'b'], true)).resolves.toEqual({
      resourceIds: ['a', 'b'],
      isFavorite: true,
      updated: 1,
      failed: 1,
    });
  });

  it('returns success and failure counts for batch soft delete', async () => {
    const { service, resourceRepo } = createService();
    resourceRepo.batchSoftDelete.mockResolvedValue(3);

    await expect(service.batchSoftDelete(['a', 'b', 'c'])).resolves.toEqual({
      resourceIds: ['a', 'b', 'c'],
      deleted: 3,
      failed: 0,
    });
  });

  it('delegates batch tag add and remove', async () => {
    const { service, tagRepo } = createService();
    tagRepo.batchAddToResources.mockResolvedValue(2);
    tagRepo.batchRemoveFromResources.mockResolvedValue(1);

    await expect(service.batchAddTags(['r1', 'r2'], ['t1'])).resolves.toEqual({
      resourceIds: ['r1', 'r2'],
      tagIds: ['t1'],
      added: 2,
    });
    await expect(service.batchRemoveTags(['r1', 'r2'], ['t1'])).resolves.toEqual({
      resourceIds: ['r1', 'r2'],
      tagIds: ['t1'],
      removed: 1,
    });
  });

  it('throws when no resources are downloadable', async () => {
    const { service, resourceRepo } = createService();
    resourceRepo.findActiveOriginalFiles.mockResolvedValue([{ id: 'r1', files: [] }]);

    await expect(service.createBatchDownload(['r1'])).rejects.toBeInstanceOf(NotFoundException);
  });

  it('creates a zip stream for downloadable resources and tracks missing resources', async () => {
    const { service, resourceRepo, storage } = createService();
    resourceRepo.findActiveOriginalFiles.mockResolvedValue([
      {
        id: 'r1',
        title: 'First',
        originalFilename: 'same:name.txt',
        files: [{ storagePath: 'originals/a.txt' }],
      },
      {
        id: 'r2',
        title: 'Second',
        originalFilename: 'same:name.txt',
        files: [{ storagePath: 'originals/b.txt' }],
      },
    ]);
    storage.getStream.mockImplementation((key: string) => Readable.from([`content-${key}`]));

    const result = await service.createBatchDownload(['r1', 'r2', 'missing']);

    expect(result.filename).toMatch(/^resources-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(result.foundResources).toBe(2);
    expect(result.missingResources).toBe(1);
    expect(result.stream).toBeInstanceOf(Readable);

    const archive = await readStream(result.stream);
    expect(archive.length).toBeGreaterThan(0);
  });

  it('propagates batch download storage errors through the zip stream', async () => {
    const { service, resourceRepo, storage } = createService();
    resourceRepo.findActiveOriginalFiles.mockResolvedValue([
      {
        id: 'r1',
        title: 'First',
        originalFilename: 'first.txt',
        files: [{ storagePath: 'originals/missing.txt' }],
      },
    ]);
    storage.getStream.mockRejectedValue(new Error('read failed'));

    const result = await service.createBatchDownload(['r1']);

    await expect(readStream(result.stream)).rejects.toThrow('read failed');
  });

  it('deletes storage files before deleting a trashed resource record', async () => {
    const { service, resourceRepo, storage } = createService();
    resourceRepo.findByIdWithRelations.mockResolvedValue({
      id: 'r1',
      deletedAt: new Date(),
      files: [{ storagePath: 'originals/a.txt' }, { storagePath: 'thumbs/a.webp' }],
    });
    const calls: string[] = [];
    storage.delete.mockImplementation(async (key: string) => {
      calls.push(`file:${key}`);
    });
    resourceRepo.deleteDeleted.mockImplementation(async (id: string) => {
      calls.push(`db:${id}`);
    });

    await expect(service.permanentDelete('r1')).resolves.toEqual({
      id: 'r1',
      deleted: true,
      deletedFiles: 2,
    });
    expect(calls).toEqual(['file:originals/a.txt', 'file:thumbs/a.webp', 'db:r1']);
  });

  it('keeps the trashed resource record when storage deletion fails', async () => {
    const { service, resourceRepo, storage } = createService();
    resourceRepo.findByIdWithRelations.mockResolvedValue({
      id: 'r1',
      deletedAt: new Date(),
      files: [{ storagePath: 'originals/a.txt' }],
    });
    storage.delete.mockRejectedValue(new Error('disk unavailable'));

    await expect(service.permanentDelete('r1')).rejects.toThrow('disk unavailable');
    expect(resourceRepo.deleteDeleted).not.toHaveBeenCalled();
  });

  it('empties trash by deleting files before each resource record', async () => {
    const { service, resourceRepo, storage } = createService();
    resourceRepo.findDeletedWithFiles.mockResolvedValue([
      { id: 'r1', files: [{ storagePath: 'originals/a.txt' }] },
      { id: 'r2', files: [{ storagePath: 'originals/b.txt' }] },
    ]);
    const calls: string[] = [];
    storage.delete.mockImplementation(async (key: string) => {
      calls.push(`file:${key}`);
    });
    resourceRepo.deleteDeleted.mockImplementation(async (id: string) => {
      calls.push(`db:${id}`);
    });

    await expect(service.emptyTrash()).resolves.toEqual({
      deletedResources: 2,
      deletedFiles: 2,
    });
    expect(calls).toEqual(['file:originals/a.txt', 'db:r1', 'file:originals/b.txt', 'db:r2']);
  });

  it('does not delete trash records after a storage deletion failure', async () => {
    const { service, resourceRepo, storage } = createService();
    resourceRepo.findDeletedWithFiles.mockResolvedValue([
      { id: 'r1', files: [{ storagePath: 'originals/a.txt' }] },
    ]);
    storage.delete.mockRejectedValue(new Error('disk unavailable'));

    await expect(service.emptyTrash()).rejects.toThrow('disk unavailable');
    expect(resourceRepo.deleteDeleted).not.toHaveBeenCalled();
  });

  it('reprocesses a resource and returns the active processing status', async () => {
    const { service, resourceRepo, scheduler } = createService();
    resourceRepo.findById.mockResolvedValue({ id: 'r1' });

    await expect(service.reprocess('r1')).resolves.toEqual({
      id: 'r1',
      processingStatus: ProcessingStatus.processing,
    });
    expect(scheduler.enqueue).toHaveBeenCalledWith(JobType.detect_metadata, 'r1');
    expect(resourceRepo.updateProcessingStatus).toHaveBeenCalledWith(
      'r1',
      ProcessingStatus.processing,
    );
  });
});
