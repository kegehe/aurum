import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  AcquisitionMode,
  FileRole,
  JobType,
  ProcessingStatus,
  ResourceType,
} from '../../common/constants/enums';
import { ResourceService, type EmptyTrashProgress } from './resource.service';

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
    findIds: vi.fn(),
    findMany: vi.fn(),
    getTrashFileUsage: vi.fn(),
    deleteDeleted: vi.fn(),
    findById: vi.fn(),
    restore: vi.fn(),
    softDelete: vi.fn(),
    count: vi.fn(),
    countBefore: vi.fn(),
    findNeighbor: vi.fn(),
    update: vi.fn(),
    updateProcessingStatus: vi.fn(),
  };
  const fileRepo = {
    findByResourceAndRole: vi.fn(),
    findStoragePathReferences: vi.fn().mockResolvedValue(new Map()),
  };
  const categoryRepo = {
    findById: vi.fn(),
  };
  const storage = {
    get: vi.fn(),
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

  return { service, resourceRepo, fileRepo, categoryRepo, storage, scheduler, searchService };
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

  it('creates a zip stream for downloadable resources and tracks skipped resources', async () => {
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
      {
        id: 'r3',
        title: 'Remote only',
        originalFilename: 'remote.jpg',
        files: [],
      },
    ]);
    storage.getStream.mockImplementation((key: string) => Readable.from([`content-${key}`]));

    const result = await service.createBatchDownload(['r1', 'r2', 'r3', 'deleted']);

    expect(result.filename).toMatch(/^resources-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(result.foundResources).toBe(2);
    expect(result.missingResources).toBe(2);
    // 无本地原文件的资源与查不到的资源都要如实回传，前端才能提示少了哪些
    expect(result.missingResourceIds).toEqual(['r3', 'deleted']);
    expect(result.stream).toBeInstanceOf(Readable);

    const archive = await readStream(result.stream);
    expect(archive.length).toBeGreaterThan(0);
    // 跳过清单随压缩包返回，列出未打包资源
    expect(archive.includes('_skipped-resources.txt')).toBe(true);
  });

  it('stops reading resource files once the client disconnects', async () => {
    const { service, resourceRepo, storage } = createService();
    resourceRepo.findActiveOriginalFiles.mockResolvedValue([
      { id: 'r1', title: 'First', originalFilename: 'a.txt', files: [{ storagePath: 'a.txt' }] },
      { id: 'r2', title: 'Second', originalFilename: 'b.txt', files: [{ storagePath: 'b.txt' }] },
    ]);
    storage.getStream.mockImplementation(() => Readable.from(['content']));

    const result = await service.createBatchDownload(['r1', 'r2']);
    // controller 在 res close（用户点了取消）时会 destroy 输出流；
    // 打包循环在 setImmediate 里启动，这里先断开，模拟"还没开始读文件就取消"
    result.stream.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(storage.getStream).not.toHaveBeenCalled();
  });

  it('keeps the skipped manifest filename when a resource uses the same name', async () => {
    const { service, resourceRepo, storage } = createService();
    resourceRepo.findActiveOriginalFiles.mockResolvedValue([
      {
        id: 'r1',
        title: 'Manifest lookalike',
        originalFilename: '_skipped-resources.txt',
        files: [{ storagePath: 'originals/lookalike.txt' }],
      },
      { id: 'r2', title: 'Remote only', originalFilename: 'remote.jpg', files: [] },
    ]);
    storage.getStream.mockImplementation(() => Readable.from(['content']));

    const result = await service.createBatchDownload(['r1', 'r2']);
    const archive = await readStream(result.stream);

    // 清单名已提前占位，不会被同名资源挤掉，toast 的提示始终准确
    expect(archive.includes('_skipped-resources.txt')).toBe(true);
    expect(archive.includes('_skipped-resources-2.txt')).toBe(true);
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

  it('deletes the resource record before cleaning up its storage files', async () => {
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
    // 先删记录：只有记录真的删掉了，才允许动磁盘文件
    expect(calls).toEqual(['db:r1', 'file:originals/a.txt', 'file:thumbs/a.webp']);
  });

  it('does not touch files when the resource was restored before deletion', async () => {
    const { service, resourceRepo, fileRepo, storage } = createService();
    resourceRepo.findByIdWithRelations.mockResolvedValue({
      id: 'r1',
      deletedAt: new Date(),
      files: [{ storagePath: 'originals/a.txt' }],
    });
    // 并发恢复：deleteDeleted 的 where(deletedAt != null) 不再命中
    resourceRepo.deleteDeleted.mockResolvedValue(0);

    await expect(service.permanentDelete('r1')).resolves.toEqual({
      id: 'r1',
      deleted: false,
      deletedFiles: 0,
    });
    expect(fileRepo.findStoragePathReferences).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('keeps storage files that another resource still references', async () => {
    const { service, resourceRepo, fileRepo, storage } = createService();
    resourceRepo.findByIdWithRelations.mockResolvedValue({
      id: 'r1',
      deletedAt: new Date(),
      files: [{ storagePath: 'originals/a.txt' }, { storagePath: 'thumbs/a.webp' }],
    });
    // 本资源的 file 行已随记录删除；同一份文件仍被 r2 引用
    fileRepo.findStoragePathReferences.mockResolvedValue(
      new Map([
        ['originals/a.txt', new Set(['r2'])],
        ['thumbs/a.webp', new Set(['r2'])],
      ]),
    );
    resourceRepo.deleteDeleted.mockResolvedValue(1);

    await expect(service.permanentDelete('r1')).resolves.toEqual({
      id: 'r1',
      deleted: true,
      deletedFiles: 0,
    });
    expect(storage.delete).not.toHaveBeenCalled();
    expect(resourceRepo.deleteDeleted).toHaveBeenCalledWith('r1');
  });

  it('deletes only the unshared files of a trashed duplicate', async () => {
    const { service, resourceRepo, fileRepo, storage } = createService();
    resourceRepo.findByIdWithRelations.mockResolvedValue({
      id: 'r1',
      deletedAt: new Date(),
      files: [{ storagePath: 'originals/shared.txt' }, { storagePath: 'thumbs/only-r1.webp' }],
    });
    fileRepo.findStoragePathReferences.mockResolvedValue(
      new Map([['originals/shared.txt', new Set(['r2'])]]),
    );
    resourceRepo.deleteDeleted.mockResolvedValue(1);

    await expect(service.permanentDelete('r1')).resolves.toEqual({
      id: 'r1',
      deleted: true,
      deletedFiles: 1,
    });
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith('thumbs/only-r1.webp');
  });

  it('still deletes the record when storage cleanup fails', async () => {
    const { service, resourceRepo, storage } = createService();
    resourceRepo.findByIdWithRelations.mockResolvedValue({
      id: 'r1',
      deletedAt: new Date(),
      files: [{ storagePath: 'originals/a.txt' }],
    });
    resourceRepo.deleteDeleted.mockResolvedValue(1);
    storage.delete.mockRejectedValue(new Error('disk unavailable'));

    // 记录已删，磁盘失败只留下孤儿文件；不能把已经删掉的资源再报成失败
    await expect(service.permanentDelete('r1')).resolves.toEqual({
      id: 'r1',
      deleted: true,
      deletedFiles: 0,
    });
    expect(resourceRepo.deleteDeleted).toHaveBeenCalledWith('r1');
  });

  it('empties trash by deleting records first, then their storage files', async () => {
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
    expect(calls).toEqual(['db:r1', 'db:r2', 'file:originals/a.txt', 'file:originals/b.txt']);
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
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith('originals/a.txt');
  });

  it('does not delete files of a resource restored during empty-trash', async () => {
    const { service, resourceRepo, fileRepo, storage } = createService();
    resourceRepo.findDeletedWithFiles.mockResolvedValue([
      { id: 'r1', files: [{ storagePath: 'originals/shared.txt' }] },
      { id: 'r2', files: [{ storagePath: 'originals/shared.txt' }] },
    ]);
    // r2 在清理过程中被恢复 → 行仍在；只有 r1 的记录真正删除
    resourceRepo.deleteDeleted.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    fileRepo.findStoragePathReferences.mockResolvedValue(
      new Map([['originals/shared.txt', new Set(['r2'])]]),
    );
    storage.delete.mockResolvedValue(undefined);

    await expect(service.emptyTrash()).resolves.toEqual({
      deletedResources: 1,
      deletedFiles: 0,
      skippedResources: 1,
    });
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('still deletes trash records when storage cleanup fails', async () => {
    const { service, resourceRepo, storage } = createService();
    resourceRepo.findDeletedWithFiles.mockResolvedValue([
      { id: 'r1', files: [{ storagePath: 'originals/a.txt' }] },
    ]);
    resourceRepo.deleteDeleted.mockResolvedValue(1);
    storage.delete.mockRejectedValue(new Error('disk unavailable'));

    // 记录已删；磁盘失败只留下孤儿文件，不能因此把清空操作判定为失败
    await expect(service.emptyTrash()).resolves.toEqual({
      deletedResources: 1,
      deletedFiles: 0,
      skippedResources: 0,
    });
    expect(resourceRepo.deleteDeleted).toHaveBeenCalledWith('r1');
  });

  it('does not delete trash files still referenced by an active resource', async () => {
    const { service, resourceRepo, fileRepo, storage } = createService();
    resourceRepo.findDeletedWithFiles.mockResolvedValue([
      {
        id: 'r1',
        files: [{ storagePath: 'originals/shared.txt' }, { storagePath: 'thumbs/only-r1.webp' }],
      },
    ]);
    // 本资源的行已删；shared 仍被正常资源引用，only-r1 已无引用
    fileRepo.findStoragePathReferences.mockResolvedValue(
      new Map([['originals/shared.txt', new Set(['active'])]]),
    );
    storage.delete.mockResolvedValue(undefined);
    resourceRepo.deleteDeleted.mockResolvedValue(1);

    await expect(service.emptyTrash()).resolves.toEqual({
      deletedResources: 1,
      deletedFiles: 1,
      skippedResources: 0,
    });
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith('thumbs/only-r1.webp');
  });

  it('deletes a file shared by two trashed resources only once', async () => {
    const { service, resourceRepo, fileRepo, storage } = createService();
    resourceRepo.findDeletedWithFiles.mockResolvedValue([
      { id: 'r1', files: [{ storagePath: 'originals/shared.txt' }] },
      { id: 'r2', files: [{ storagePath: 'originals/shared.txt' }] },
    ]);
    // 两条记录都已删除 → 文件不再被任何资源引用
    fileRepo.findStoragePathReferences.mockResolvedValue(new Map());
    storage.delete.mockResolvedValue(undefined);
    resourceRepo.deleteDeleted.mockResolvedValue(1);

    await expect(service.emptyTrash()).resolves.toEqual({
      deletedResources: 2,
      deletedFiles: 1,
      skippedResources: 0,
    });
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith('originals/shared.txt');
  });

  it('reports empty-trash progress as resources are deleted and files cleaned up', async () => {
    const { service, resourceRepo, storage } = createService();
    resourceRepo.findDeletedWithFiles.mockResolvedValue([
      { id: 'r1', files: [{ storagePath: 'originals/a.txt' }, { storagePath: 'thumbs/a.webp' }] },
      { id: 'r2', files: [{ storagePath: 'originals/b.txt' }] },
    ]);
    storage.delete.mockResolvedValue(undefined);
    resourceRepo.deleteDeleted.mockResolvedValue(1);

    const snapshots: EmptyTrashProgress[] = [];
    await service.emptyTrash({ onProgress: (progress) => snapshots.push(progress) });

    // 首帧携带总数；每个资源一帧（此时只删记录）；文件清理完成后再一帧
    expect(snapshots).toHaveLength(4);
    expect(snapshots[0]).toEqual({
      totalResources: 2,
      totalFiles: 3,
      processedResources: 0,
      processedFiles: 0,
      deletedResources: 0,
      deletedFiles: 0,
      skippedResources: 0,
    });
    expect(snapshots[1]).toEqual({
      totalResources: 2,
      totalFiles: 3,
      processedResources: 1,
      processedFiles: 2,
      deletedResources: 1,
      deletedFiles: 0,
      skippedResources: 0,
    });
    expect(snapshots[2]).toMatchObject({
      processedResources: 2,
      processedFiles: 3,
      deletedResources: 2,
      deletedFiles: 0,
    });
    expect(snapshots[3]).toMatchObject({
      processedResources: 2,
      processedFiles: 3,
      deletedResources: 2,
      deletedFiles: 3,
    });
  });

  it('deduplicates shared files and excludes files still used by active resources', async () => {
    const { service, resourceRepo, fileRepo } = createService();
    resourceRepo.getTrashFileUsage.mockResolvedValue({
      resourceCount: 3,
      files: [
        // a 被两条回收站资源共用 → 只计一次
        { resourceId: 'r1', storagePath: 'originals/a.png', sizeBytes: 100n },
        { resourceId: 'r2', storagePath: 'originals/a.png', sizeBytes: 100n },
        // b 只属于回收站资源 → 可回收
        { resourceId: 'r1', storagePath: 'originals/b.png', sizeBytes: 200n },
        // c 仍被正常资源引用 → 不可回收
        { resourceId: 'r1', storagePath: 'originals/c.png', sizeBytes: 300n },
      ],
    });
    fileRepo.findStoragePathReferences.mockResolvedValue(
      new Map([
        ['originals/a.png', new Set(['r1', 'r2'])],
        ['originals/b.png', new Set(['r1'])],
        ['originals/c.png', new Set(['r1', 'active'])],
      ]),
    );

    await expect(service.getTrashStats()).resolves.toEqual({
      resourceCount: 3,
      fileCount: 2,
      totalSizeBytes: '300',
    });
  });

  it('returns zero reclaimable size for an empty trash', async () => {
    const { service, resourceRepo, fileRepo } = createService();
    resourceRepo.getTrashFileUsage.mockResolvedValue({ resourceCount: 0, files: [] });

    await expect(service.getTrashStats()).resolves.toEqual({
      resourceCount: 0,
      fileCount: 0,
      totalSizeBytes: '0',
    });
    expect(fileRepo.findStoragePathReferences).not.toHaveBeenCalled();
  });

  it('reuses trash stats within the TTL instead of rescanning on every fetch', async () => {
    const { service, resourceRepo } = createService();
    resourceRepo.getTrashFileUsage.mockResolvedValue({ resourceCount: 1, files: [] });

    await service.getTrashStats();
    await service.getTrashStats();

    expect(resourceRepo.getTrashFileUsage).toHaveBeenCalledTimes(1);
  });

  it('invalidates the trash stats cache after a restore', async () => {
    const { service, resourceRepo } = createService();
    resourceRepo.getTrashFileUsage.mockResolvedValue({ resourceCount: 1, files: [] });
    resourceRepo.findById.mockResolvedValue({ id: 'r1' });
    resourceRepo.restore.mockResolvedValue({ id: 'r1', deletedAt: null });

    await service.getTrashStats();
    await service.restore('r1');
    await service.getTrashStats();

    // 用户自己的恢复操作必须立刻反映到统计里，不能等 TTL 过期
    expect(resourceRepo.getTrashFileUsage).toHaveBeenCalledTimes(2);
  });

  it('does not cache a stats read that raced with an invalidation', async () => {
    const { service, resourceRepo } = createService();
    let resolveUsage!: (value: { resourceCount: number; files: never[] }) => void;
    resourceRepo.getTrashFileUsage.mockReturnValue(
      new Promise((resolve) => {
        resolveUsage = resolve;
      }),
    );

    const pending = service.getTrashStats();
    // 计算尚未返回时回收站发生变化
    service.invalidateTrashStats();
    resolveUsage({ resourceCount: 1, files: [] });
    await expect(pending).resolves.toEqual({
      resourceCount: 1,
      fileCount: 0,
      totalSizeBytes: '0',
    });

    resourceRepo.getTrashFileUsage.mockResolvedValue({ resourceCount: 0, files: [] });
    await service.getTrashStats();

    // 失效前发起的那次计算不能被写回缓存
    expect(resourceRepo.getTrashFileUsage).toHaveBeenCalledTimes(2);
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

describe('ResourceService 缩略图 ETag', () => {
  it('hits 304 without opening the file when If-None-Match matches', async () => {
    const { service, fileRepo, storage } = createService();
    fileRepo.findByResourceAndRole.mockResolvedValue({
      id: 'f1',
      sizeBytes: 1024n,
      storagePath: 'thumbnails/a.webp',
      mimeType: 'image/webp',
    });

    await expect(service.getThumbnailFile('r1', '"f1-1024"')).resolves.toEqual({
      notModified: true,
      etag: '"f1-1024"',
    });
    expect(storage.getStream).not.toHaveBeenCalled();
  });

  it('returns a stream and the same ETag when the client has no copy', async () => {
    const { service, fileRepo, storage } = createService();
    const stream = { pipe: vi.fn() };
    fileRepo.findByResourceAndRole.mockResolvedValue({
      id: 'f1',
      sizeBytes: 1024n,
      storagePath: 'thumbnails/a.webp',
      mimeType: 'image/webp',
    });
    storage.getStream.mockResolvedValue(stream);

    await expect(service.getThumbnailFile('r1')).resolves.toEqual({
      stream,
      mimeType: 'image/webp',
      etag: '"f1-1024"',
    });
    // 命中缩略图时只查一次 resource_files
    expect(fileRepo.findByResourceAndRole).toHaveBeenCalledTimes(1);
  });
});

describe('ResourceService 缩放预览', () => {
  it('skips non-bitmap resources so videos keep Range support', async () => {
    const { service, resourceRepo } = createService();
    resourceRepo.findById.mockResolvedValue({
      id: 'r1',
      mimeType: 'video/mp4',
      originalFilename: 'clip.mp4',
    });

    await expect(service.getResizedPreview('r1', 2048)).resolves.toBeNull();
  });

  it('skips images whose recorded dimensions already fit', async () => {
    const { service, resourceRepo, storage } = createService();
    resourceRepo.findById.mockResolvedValue({
      id: 'r1',
      mimeType: 'image/png',
      width: 800,
      height: 600,
      originalFilename: 'small.png',
    });

    await expect(service.getResizedPreview('r1', 2048)).resolves.toBeNull();
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('skips oversized originals instead of loading them into memory', async () => {
    const { service, resourceRepo, fileRepo, storage } = createService();
    resourceRepo.findById.mockResolvedValue({
      id: 'r1',
      mimeType: 'image/png',
      width: 12000,
      height: 12000,
      originalFilename: 'huge.png',
    });
    fileRepo.findByResourceAndRole.mockResolvedValue({
      id: 'f1',
      sizeBytes: 80n * 1024n * 1024n,
      storagePath: 'originals/huge.png',
      mimeType: 'image/png',
    });

    // 超过 64MB 上限：不做内存缩放，交给调用方回退原图流
    await expect(service.getResizedPreview('r1', 2048)).resolves.toBeNull();
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('returns null when the original file row is gone so callers can fall back', async () => {
    const { service, resourceRepo, fileRepo, storage } = createService();
    resourceRepo.findById.mockResolvedValue({
      id: 'r1',
      mimeType: 'image/png',
      width: 4000,
      height: 3000,
      originalFilename: 'thumb-only.png',
    });
    fileRepo.findByResourceAndRole.mockResolvedValue(null);

    // 抛 404 会让 /preview 整块裂掉；返回 null 才会落到原文件/缩略图降级分支
    await expect(service.getResizedPreview('r1', 2048)).resolves.toBeNull();
    expect(storage.get).not.toHaveBeenCalled();
  });
});

describe('ResourceService findNeighbors', () => {
  it('throws 404 when the resource does not exist', async () => {
    const { service, resourceRepo } = createService();
    resourceRepo.findById.mockResolvedValue(null);

    await expect(service.findNeighbors('missing', {} as never)).rejects.toThrow(NotFoundException);
    expect(resourceRepo.findNeighbor).not.toHaveBeenCalled();
  });

  it('returns no neighbors when the resource falls outside the filtered result', async () => {
    const { service, resourceRepo, searchService } = createService();
    resourceRepo.findById.mockResolvedValue({ id: 'r2', createdAt: new Date('2026-01-02') });
    searchService.buildWhereClause.mockReturnValue({ resourceType: 'image' });
    resourceRepo.count.mockResolvedValueOnce(2).mockResolvedValueOnce(0);

    await expect(service.findNeighbors('r2', {} as never)).resolves.toEqual({
      previousId: null,
      nextId: null,
      currentIndex: null,
      total: 2,
    });
    expect(resourceRepo.findNeighbor).not.toHaveBeenCalled();
  });

  it('returns prev/next by createdAt desc (default) using the current row as cursor', async () => {
    const { service, resourceRepo, searchService } = createService();
    const key = new Date('2026-01-02');
    resourceRepo.findById.mockResolvedValue({ id: 'r2', createdAt: key });
    searchService.buildWhereClause.mockReturnValue({ deletedAt: null });
    resourceRepo.count.mockResolvedValueOnce(3).mockResolvedValueOnce(1);
    resourceRepo.countBefore.mockResolvedValue(1);
    resourceRepo.findNeighbor
      .mockResolvedValueOnce({ id: 'r3' })
      .mockResolvedValueOnce({ id: 'r1' });

    await expect(service.findNeighbors('r2', {} as never)).resolves.toEqual({
      previousId: 'r3',
      nextId: 'r1',
      currentIndex: 2,
      total: 3,
    });

    expect(resourceRepo.countBefore).toHaveBeenCalledWith({
      where: { deletedAt: null },
      field: 'createdAt',
      key,
      id: 'r2',
      order: 'desc',
    });
    expect(resourceRepo.findNeighbor).toHaveBeenNthCalledWith(1, {
      where: { deletedAt: null },
      field: 'createdAt',
      key,
      id: 'r2',
      order: 'desc',
      direction: 'previous',
    });
    expect(resourceRepo.findNeighbor).toHaveBeenNthCalledWith(2, {
      where: { deletedAt: null },
      field: 'createdAt',
      key,
      id: 'r2',
      order: 'desc',
      direction: 'next',
    });
  });

  it('returns null at the list bounds and honors ascending order', async () => {
    const { service, resourceRepo } = createService();
    const key = new Date('2026-01-03');
    resourceRepo.findById.mockResolvedValue({ id: 'r3', createdAt: key });
    resourceRepo.count.mockResolvedValueOnce(3).mockResolvedValueOnce(1);
    resourceRepo.countBefore.mockResolvedValue(2);
    resourceRepo.findNeighbor.mockResolvedValueOnce({ id: 'r2' }).mockResolvedValueOnce(null);

    await expect(
      service.findNeighbors('r3', { sortBy: 'createdAt', sortOrder: 'asc' } as never),
    ).resolves.toEqual({
      previousId: 'r2',
      nextId: null,
      currentIndex: 3,
      total: 3,
    });
    expect(resourceRepo.findNeighbor).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ order: 'asc', direction: 'next', key }),
    );
  });

  it('uses the selected sort field as the cursor value', async () => {
    const { service, resourceRepo } = createService();
    resourceRepo.findById.mockResolvedValue({ id: 'r2', title: 'beta' });
    resourceRepo.count.mockResolvedValueOnce(3).mockResolvedValueOnce(1);
    resourceRepo.countBefore.mockResolvedValue(2);
    resourceRepo.findNeighbor.mockResolvedValueOnce({ id: 'r3' }).mockResolvedValueOnce(null);

    await expect(
      service.findNeighbors('r2', { sortBy: 'title', sortOrder: 'asc' } as never),
    ).resolves.toEqual({
      previousId: 'r3',
      nextId: null,
      currentIndex: 3,
      total: 3,
    });
    expect(resourceRepo.findNeighbor).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ field: 'title', key: 'beta', order: 'asc' }),
    );
  });
});

describe('ResourceService design media', () => {
  function resource(overrides: Record<string, unknown> = {}) {
    return {
      id: 'res-1',
      title: '示例图片',
      originalFilename: 'sample.png',
      resourceType: ResourceType.image,
      acquisitionMode: AcquisitionMode.local_upload,
      processingStatus: ProcessingStatus.completed,
      deletedAt: null,
      width: 800,
      height: 600,
      durationSeconds: null,
      sha256: 'sha-1',
      ...overrides,
    };
  }

  it('rejects remote-only resources with a download hint', async () => {
    const { service, resourceRepo, fileRepo } = createService();
    resourceRepo.findById.mockResolvedValue(
      resource({ acquisitionMode: AcquisitionMode.metadata_only }),
    );
    fileRepo.findByResourceAndRole.mockResolvedValue(null);

    await expect(service.assertDesignMedia('res-1')).rejects.toThrow('下载到本地');
  });

  it('rejects videos until the cover frame exists', async () => {
    const { service, resourceRepo, fileRepo } = createService();
    resourceRepo.findById.mockResolvedValue(
      resource({ resourceType: ResourceType.video, originalFilename: 'clip.mp4' }),
    );
    fileRepo.findByResourceAndRole.mockImplementation(async (_id: string, role: string) =>
      role === FileRole.original ? { id: 'file-1' } : null,
    );

    await expect(service.assertDesignMedia('res-1')).rejects.toThrow('视频封面');
  });

  it('returns metadata for a local image', async () => {
    const { service, resourceRepo, fileRepo } = createService();
    resourceRepo.findById.mockResolvedValue(resource());
    fileRepo.findByResourceAndRole.mockImplementation(async (_id: string, role: string) =>
      role === FileRole.original ? { id: 'file-1' } : null,
    );

    await expect(service.assertDesignMedia('res-1')).resolves.toEqual({
      kind: 'image',
      title: '示例图片',
      width: 800,
      height: 600,
      durationSeconds: null,
    });
  });

  it('reads a video cover from the thumbnail file', async () => {
    const { service, resourceRepo, fileRepo } = createService();
    resourceRepo.findById.mockResolvedValue(
      resource({ resourceType: ResourceType.video, originalFilename: 'clip.mp4' }),
    );
    fileRepo.findByResourceAndRole.mockResolvedValue({ id: 'file-1' });
    vi.spyOn(service, 'getThumbnailFile').mockResolvedValue({
      stream: Readable.from([Buffer.from('cover')]),
      mimeType: 'image/jpeg',
      etag: '"thumb-1"',
    });

    await expect(service.readDesignMedia('res-1')).resolves.toMatchObject({
      buffer: Buffer.from('cover'),
      mimeType: 'image/jpeg',
      kind: 'video',
      cacheKey: '"thumb-1"',
    });
  });

  it('prefers a resized image over the original', async () => {
    const { service, resourceRepo, fileRepo } = createService();
    resourceRepo.findById.mockResolvedValue(resource());
    fileRepo.findByResourceAndRole.mockResolvedValue({ id: 'file-1' });
    vi.spyOn(service, 'getResizedPreview').mockResolvedValue({
      buffer: Buffer.from('resized'),
      mimeType: 'image/webp',
      originalFilename: 'sample.png',
    });

    await expect(service.readDesignMedia('res-1', { maxEdge: 1600 })).resolves.toMatchObject({
      buffer: Buffer.from('resized'),
      mimeType: 'image/webp',
      kind: 'image',
      cacheKey: 'sha-1:1600',
    });
  });
});

describe('ResourceService design media fallback', () => {
  it('falls back to the thumbnail when a thumbnail-only image cannot be resized', async () => {
    const { service, resourceRepo, fileRepo } = createService();
    resourceRepo.findById.mockResolvedValue({
      id: 'res-1',
      title: '只有缩略图',
      originalFilename: 'thumb-only.png',
      resourceType: ResourceType.image,
      acquisitionMode: AcquisitionMode.local_upload,
      processingStatus: ProcessingStatus.completed,
      deletedAt: null,
      width: 2000,
      height: 1600,
      durationSeconds: null,
      sha256: null,
    });
    fileRepo.findByResourceAndRole.mockImplementation(async (_id: string, role: string) =>
      role === FileRole.thumbnail ? { id: 'thumb-1' } : null,
    );
    vi.spyOn(service, 'getResizedPreview').mockRejectedValue(
      new NotFoundException('Original file for resource res-1 not found'),
    );
    vi.spyOn(service, 'getOriginalFileInfo').mockRejectedValue(
      new NotFoundException('Original file for resource res-1 not found'),
    );
    vi.spyOn(service, 'getThumbnailFile').mockResolvedValue({
      stream: Readable.from([Buffer.from('thumb-bytes')]),
      mimeType: 'image/webp',
      etag: '"thumb-1"',
    });

    await expect(service.readDesignMedia('res-1')).resolves.toMatchObject({
      buffer: Buffer.from('thumb-bytes'),
      mimeType: 'image/webp',
      kind: 'image',
      cacheKey: '"thumb-1"',
    });
  });
});

describe('ResourceService findIds', () => {
  it('returns every id in the filtered scope without paging or loading rows', async () => {
    const { service, resourceRepo, searchService } = createService();
    searchService.buildWhereClause.mockReturnValue({ deletedAt: null, categoryId: 'cat-1' });
    resourceRepo.findIds.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);

    await expect(
      service.findIds({
        categoryId: 'cat-1',
        page: 1,
        pageSize: 100,
      } as never),
    ).resolves.toEqual({ ids: ['r1', 'r2', 'r3'], total: 3 });

    // 选择集必须和列表用同一套筛选条件；分页参数不参与，才能一次拿全
    expect(searchService.buildWhereClause).toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: 'cat-1' }),
    );
    expect(resourceRepo.findIds).toHaveBeenCalledWith({
      deletedAt: null,
      categoryId: 'cat-1',
    });
  });
});

describe('ResourceService list serialization', () => {
  it('exposes the remote media URL separately from the preview thumbnail', async () => {
    const { service, resourceRepo } = createService();
    resourceRepo.findMany.mockResolvedValue([
      {
        id: 'res-video',
        title: 'Episode 1',
        sizeBytes: BigInt(0),
        acquisitionMode: AcquisitionMode.metadata_only,
        locators: [
          {
            locatorType: 'download',
            url: 'https://cdn.example.com/episode.mp4',
            lastError: null,
            downloadAttempts: 0,
          },
          {
            locatorType: 'preview',
            url: 'https://cdn.example.com/episode-thumb.jpg',
            lastError: null,
            downloadAttempts: 0,
          },
        ],
      },
    ]);
    resourceRepo.count.mockResolvedValue(1);

    const result = await service.findMany({ page: 1, pageSize: 20 } as never);

    // 卡片用 previewUrl 展示缩略图，用 downloadUrl 播放视频，两者不能混用
    expect(result.items[0]).toMatchObject({
      previewUrl: 'https://cdn.example.com/episode-thumb.jpg',
      downloadUrl: 'https://cdn.example.com/episode.mp4',
    });
  });

  it('keeps the preview empty when the source provides no preview locator', async () => {
    const { service, resourceRepo } = createService();
    resourceRepo.findMany.mockResolvedValue([
      {
        id: 'res-image',
        title: 'Photo',
        sizeBytes: BigInt(0),
        acquisitionMode: AcquisitionMode.metadata_only,
        locators: [
          {
            locatorType: 'download',
            url: 'https://cdn.example.com/photo.jpg',
            lastError: null,
            downloadAttempts: 0,
          },
        ],
      },
    ]);
    resourceRepo.count.mockResolvedValue(1);

    const result = await service.findMany({ page: 1, pageSize: 20 } as never);

    // 列表预览只认 preview 定位器；图片资源由前端回退到 downloadUrl 展示
    expect(result.items[0]).toMatchObject({
      previewUrl: null,
      downloadUrl: 'https://cdn.example.com/photo.jpg',
    });
  });
});

describe('ResourceService preview resize concurrency', () => {
  it('never lets more than the configured number of resizes run at once', async () => {
    const { service } = createService();
    const internals = service as unknown as {
      acquirePreviewResizeSlot: () => Promise<() => void>;
      previewResizeActive: number;
    };

    const first = await internals.acquirePreviewResizeSlot();
    const second = await internals.acquirePreviewResizeSlot();
    expect(internals.previewResizeActive).toBe(2);

    let thirdAcquired = false;
    const third = internals.acquirePreviewResizeSlot().then((release) => {
      thirdAcquired = true;
      return release;
    });
    await Promise.resolve();
    expect(thirdAcquired).toBe(false);

    // 释放一个槽位时直接移交给等待者，计数既不能瞬时超限也不能掉到 1
    first();
    const thirdRelease = await third;
    expect(thirdAcquired).toBe(true);
    expect(internals.previewResizeActive).toBe(2);

    second();
    thirdRelease();
    expect(internals.previewResizeActive).toBe(0);
  });
});
