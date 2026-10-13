import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

/**
 * 读取 ZIP 数据描述符中的压缩/未压缩大小。
 * 条目以流写入时，本地文件头中的 crc/大小会被置零，真实值写在数据描述符里；
 * 描述符布局：signature PK\x07\x08(4) + crc(4) + compressedSize(4) + uncompressedSize(4)。
 */
function readDataDescriptorSizes(archive: Buffer): {
  compressedSize: number;
  uncompressedSize: number;
} {
  const signature = Buffer.from([0x50, 0x4b, 0x07, 0x08]);
  const index = archive.indexOf(signature);
  if (index === -1) {
    throw new Error('ZIP data descriptor not found');
  }
  return {
    compressedSize: archive.readUInt32LE(index + 8),
    uncompressedSize: archive.readUInt32LE(index + 12),
  };
}

function createService() {
  const resourceRepo = {
    batchSetCategory: vi.fn(),
    batchSetFavorite: vi.fn(),
    batchRestore: vi.fn(),
    batchSoftDelete: vi.fn(),
    findActiveOriginalFiles: vi.fn(),
    findByIdWithRelations: vi.fn(),
    findDeletedWithFiles: vi.fn(),
    deleteDeleted: vi.fn(),
    findById: vi.fn(),
    findSortKeys: vi.fn(),
    update: vi.fn(),
    updateProcessingStatus: vi.fn(),
  };
  const fileRepo = {};
  const categoryRepo = {
    findById: vi.fn(),
  };
  const storage = {
    getStream: vi.fn(),
    delete: vi.fn(),
  };
  const scheduler = {
    enqueue: vi.fn(),
  };
  const searchService = {
    buildWhereClause: vi.fn((_query) => ({ deletedAt: null })),
    buildOrderBy: vi.fn(),
  };
  const service = new ResourceService(
    resourceRepo as never,
    fileRepo as never,
    categoryRepo as never,
    storage as never,
    scheduler as never,
    searchService as never,
  );

  return { service, resourceRepo, categoryRepo, storage, scheduler, searchService };
}

describe('ResourceService batch operations', () => {
  it('returns success and failure counts for batch category changes', async () => {
    const { service, resourceRepo, categoryRepo } = createService();
    categoryRepo.findById.mockResolvedValue({ id: 'cat-1', name: 'Design' });
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

  it('returns success and failure counts for batch restore', async () => {
    const { service, resourceRepo } = createService();
    resourceRepo.batchRestore.mockResolvedValue({ restored: 2, failedIds: ['b'] });

    await expect(service.batchRestore(['a', 'b', 'c'])).resolves.toEqual({
      resourceIds: ['a', 'b', 'c'],
      restored: 2,
      failed: 1,
      failedResourceIds: ['b'],
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

  it('stores already-compressed formats (e.g. video) without deflate', async () => {
    const { service, resourceRepo, storage } = createService();
    resourceRepo.findActiveOriginalFiles.mockResolvedValue([
      {
        id: 'r1',
        title: 'Movie',
        originalFilename: 'movie.mp4',
        files: [{ storagePath: 'originals/movie.mp4', mimeType: 'video/mp4', extension: 'mp4' }],
      },
    ]);
    storage.getStream.mockImplementation(() => Readable.from([Buffer.alloc(1024)]));

    const result = await service.createBatchDownload(['r1']);
    const archive = await readStream(result.stream);

    // ZIP 本地文件头偏移 8-9 为压缩方式（小端）：0 = STORE，8 = DEFLATE
    expect(archive.readUInt16LE(8)).toBe(0);
    // 数据描述符中的大小证明内容确实是原样存储（未压缩）
    const sizes = readDataDescriptorSizes(archive);
    expect(sizes.uncompressedSize).toBe(1024);
    expect(sizes.compressedSize).toBe(1024);
  });

  it('deflates compressible formats (e.g. text)', async () => {
    const { service, resourceRepo, storage } = createService();
    resourceRepo.findActiveOriginalFiles.mockResolvedValue([
      {
        id: 'r1',
        title: 'Notes',
        originalFilename: 'notes.txt',
        files: [{ storagePath: 'originals/notes.txt', mimeType: 'text/plain', extension: 'txt' }],
      },
    ]);
    storage.getStream.mockImplementation(() =>
      Readable.from([Buffer.from('hello world '.repeat(100))]),
    );

    const result = await service.createBatchDownload(['r1']);
    const archive = await readStream(result.stream);

    expect(archive.readUInt16LE(8)).toBe(8);
    // 数据描述符：未压缩 1200 字节，压缩后应显著更小（证明确实走了 DEFLATE）
    const sizes = readDataDescriptorSizes(archive);
    expect(sizes.uncompressedSize).toBe(1200);
    expect(sizes.compressedSize).toBeLessThan(1200);
  });

  it('deflates uncompressed image formats (e.g. svg)', async () => {
    const { service, resourceRepo, storage } = createService();
    resourceRepo.findActiveOriginalFiles.mockResolvedValue([
      {
        id: 'r1',
        title: 'Vector',
        originalFilename: 'vector.svg',
        files: [
          { storagePath: 'originals/vector.svg', mimeType: 'image/svg+xml', extension: 'svg' },
        ],
      },
    ]);
    storage.getStream.mockImplementation(() =>
      Readable.from([Buffer.from('<svg></svg>'.repeat(100))]),
    );

    const result = await service.createBatchDownload(['r1']);
    const archive = await readStream(result.stream);

    // svg 是可压缩的文本格式，不应被 STORE
    expect(archive.readUInt16LE(8)).toBe(8);
    const sizes = readDataDescriptorSizes(archive);
    expect(sizes.uncompressedSize).toBe(1100);
    expect(sizes.compressedSize).toBeLessThan(1100);
  });

  it('falls back to mimeType when the filename has no extension', async () => {
    const { service, resourceRepo, storage } = createService();
    resourceRepo.findActiveOriginalFiles.mockResolvedValue([
      {
        id: 'r1',
        title: 'Clip',
        originalFilename: 'clip-noext',
        files: [{ storagePath: 'originals/clip', mimeType: 'video/mp4', extension: null }],
      },
    ]);
    storage.getStream.mockImplementation(() => Readable.from([Buffer.alloc(1024)]));

    const result = await service.createBatchDownload(['r1']);
    const archive = await readStream(result.stream);

    expect(archive.readUInt16LE(8)).toBe(0);
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
      return 1;
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
      return 1;
    });

    await expect(service.emptyTrash()).resolves.toEqual({
      deletedResources: 2,
      deletedFiles: 2,
      skippedResources: 0,
    });
    expect(calls).toEqual(['file:originals/a.txt', 'db:r1', 'file:originals/b.txt', 'db:r2']);
  });

  it('skips resources already deleted by a concurrent request', async () => {
    const { service, resourceRepo, storage } = createService();
    resourceRepo.findDeletedWithFiles.mockResolvedValue([
      { id: 'r1', files: [{ storagePath: 'originals/a.txt' }] },
      { id: 'r2', files: [{ storagePath: 'originals/b.txt' }] },
    ]);
    storage.delete.mockResolvedValue(undefined);
    // r1 正常删除，r2 已被并发请求删除（count=0）
    resourceRepo.deleteDeleted.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(service.emptyTrash()).resolves.toEqual({
      deletedResources: 1,
      deletedFiles: 1,
      skippedResources: 1,
    });
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

describe('ResourceService category validation', () => {
  it('updates a resource with a valid category via connect', async () => {
    const { service, resourceRepo, categoryRepo } = createService();
    resourceRepo.findById.mockResolvedValue({ id: 'r1' });
    categoryRepo.findById.mockResolvedValue({ id: 'cat-1', name: 'Design' });
    resourceRepo.update.mockResolvedValue({ id: 'r1', sizeBytes: BigInt(10) });

    await expect(service.update('r1', { categoryId: 'cat-1' })).resolves.toEqual({
      id: 'r1',
      sizeBytes: '10',
    });
    expect(categoryRepo.findById).toHaveBeenCalledWith('cat-1');
    expect(resourceRepo.update).toHaveBeenCalledWith('r1', {
      category: { connect: { id: 'cat-1' } },
    });
  });

  it('throws a readable BadRequestException when the category was deleted', async () => {
    const { service, resourceRepo, categoryRepo } = createService();
    resourceRepo.findById.mockResolvedValue({ id: 'r1' });
    categoryRepo.findById.mockResolvedValue(null);

    await expect(service.update('r1', { categoryId: 'cat-deleted' })).rejects.toThrow(
      BadRequestException,
    );
    expect(resourceRepo.update).not.toHaveBeenCalled();
  });

  it('translates a race-window FK error in update to a readable BadRequestException', async () => {
    const { service, resourceRepo, categoryRepo } = createService();
    resourceRepo.findById.mockResolvedValue({ id: 'r1' });
    // 预校验时分类还在，写入时被并发删除 → Prisma P2025；兜底复查确认分类已不存在
    categoryRepo.findById.mockResolvedValueOnce({ id: 'cat-1' }).mockResolvedValueOnce(null);
    resourceRepo.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        "An operation failed because it depends on one or more records that were required but not found.\nCause: No 'Category' record(s) was found for a nested connect on 'Resource#r1'.",
        { code: 'P2025', clientVersion: 'test' },
      ),
    );

    await expect(service.update('r1', { categoryId: 'cat-1' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('returns 404 when the resource is deleted concurrently but the category still exists', async () => {
    const { service, resourceRepo, categoryRepo } = createService();
    resourceRepo.findById.mockResolvedValue({ id: 'r1' });
    // 预校验与兜底复查都返回分类存在 → P2025 实际源于资源被并发删除
    categoryRepo.findById.mockResolvedValue({ id: 'cat-1' });
    resourceRepo.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        "An operation failed because it depends on one or more records that were required but not found.\nCause: No 'Category' record(s) was found for a nested connect on 'Resource#r1'.",
        { code: 'P2025', clientVersion: 'test' },
      ),
    );

    await expect(service.update('r1', { categoryId: 'cat-1' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('does not translate unrelated FK errors in update', async () => {
    const { service, resourceRepo, categoryRepo } = createService();
    resourceRepo.findById.mockResolvedValue({ id: 'r1' });
    categoryRepo.findById.mockResolvedValue({ id: 'cat-1' });
    // 资源本身在写入前被删除：P2025 但信息不含 category，应保持原样抛出
    resourceRepo.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        'An operation failed because it depends on one or more records that were required but not found.',
        { code: 'P2025', clientVersion: 'test' },
      ),
    );

    await expect(service.update('r1', { categoryId: 'cat-1' })).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
  });

  it('throws a readable BadRequestException in batchSetCategory when category was deleted', async () => {
    const { service, resourceRepo, categoryRepo } = createService();
    categoryRepo.findById.mockResolvedValue(null);

    await expect(service.batchSetCategory(['r1'], 'cat-deleted')).rejects.toThrow(
      BadRequestException,
    );
    expect(resourceRepo.batchSetCategory).not.toHaveBeenCalled();
  });

  it('translates a race-window FK error in batchSetCategory to a readable BadRequestException', async () => {
    const { service, resourceRepo, categoryRepo } = createService();
    categoryRepo.findById.mockResolvedValue({ id: 'cat-1' });
    // SQLite 下 updateMany 直接写不存在的 categoryId 产生 P2003，消息通用不含字段名
    resourceRepo.batchSetCategory.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated: `foreign key`', {
        code: 'P2003',
        clientVersion: 'test',
      }),
    );

    await expect(service.batchSetCategory(['r1'], 'cat-1')).rejects.toThrow(BadRequestException);
  });

  it('disconnects a category when categoryId is null', async () => {
    const { service, resourceRepo, categoryRepo } = createService();
    resourceRepo.findById.mockResolvedValue({ id: 'r1' });
    resourceRepo.update.mockResolvedValue({ id: 'r1', sizeBytes: BigInt(10) });

    await expect(service.update('r1', { categoryId: null })).resolves.toEqual({
      id: 'r1',
      sizeBytes: '10',
    });
    expect(categoryRepo.findById).not.toHaveBeenCalled();
    expect(resourceRepo.update).toHaveBeenCalledWith('r1', {
      category: { disconnect: true },
    });
  });
});

describe('ResourceService findNeighbors', () => {
  it('throws 404 when the resource does not exist', async () => {
    const { service, resourceRepo } = createService();
    resourceRepo.findById.mockResolvedValue(null);

    await expect(service.findNeighbors('missing', {} as never)).rejects.toThrow(NotFoundException);
    expect(resourceRepo.findSortKeys).not.toHaveBeenCalled();
  });

  it('returns no neighbors when the resource falls outside the filtered result', async () => {
    const { service, resourceRepo, searchService } = createService();
    resourceRepo.findById.mockResolvedValue({ id: 'r2' });
    searchService.buildWhereClause.mockReturnValue({ resourceType: 'image' });
    resourceRepo.findSortKeys.mockResolvedValue([
      { id: 'r1', sortKey: new Date('2026-01-01') },
      { id: 'r3', sortKey: new Date('2026-01-03') },
    ]);

    await expect(service.findNeighbors('r2', {} as never)).resolves.toEqual({
      previousId: null,
      nextId: null,
      currentIndex: null,
      total: 2,
    });
    expect(resourceRepo.findSortKeys).toHaveBeenCalledWith({
      where: { resourceType: 'image' },
      field: 'createdAt',
    });
  });

  it('returns prev/next by createdAt desc (default) with id tiebreak', async () => {
    const { service, resourceRepo } = createService();
    resourceRepo.findById.mockResolvedValue({ id: 'r2' });
    resourceRepo.findSortKeys.mockResolvedValue([
      { id: 'r1', sortKey: new Date('2026-01-01') },
      { id: 'r2', sortKey: new Date('2026-01-02') },
      { id: 'r3', sortKey: new Date('2026-01-03') },
    ]);

    await expect(service.findNeighbors('r2', {} as never)).resolves.toEqual({
      previousId: 'r3',
      nextId: 'r1',
      currentIndex: 2,
      total: 3,
    });
  });

  it('returns null at the list bounds and honors ascending order', async () => {
    const { service, resourceRepo } = createService();
    resourceRepo.findById.mockResolvedValue({ id: 'r3' });
    resourceRepo.findSortKeys.mockResolvedValue([
      { id: 'r1', sortKey: new Date('2026-01-01') },
      { id: 'r2', sortKey: new Date('2026-01-02') },
      { id: 'r3', sortKey: new Date('2026-01-03') },
    ]);

    // asc：r3 最大、位于末尾 → next 为 null，prev 为 r2
    await expect(
      service.findNeighbors('r3', { sortBy: 'createdAt', sortOrder: 'asc' } as never),
    ).resolves.toEqual({
      previousId: 'r2',
      nextId: null,
      currentIndex: 3,
      total: 3,
    });
  });

  it('sorts by title:null-first in ascending order', async () => {
    const { service, resourceRepo } = createService();
    resourceRepo.findById.mockResolvedValue({ id: 'r2' });
    resourceRepo.findSortKeys.mockResolvedValue([
      { id: 'r1', sortKey: null },
      { id: 'r2', sortKey: 'beta' },
      { id: 'r3', sortKey: 'alpha' },
    ]);

    // title asc：NULL 最前 → r1, r3(alpha), r2(beta)；r2 位于末尾 → next 为 null，prev 为 r3
    await expect(
      service.findNeighbors('r2', { sortBy: 'title', sortOrder: 'asc' } as never),
    ).resolves.toEqual({
      previousId: 'r3',
      nextId: null,
      currentIndex: 3,
      total: 3,
    });
  });
});

