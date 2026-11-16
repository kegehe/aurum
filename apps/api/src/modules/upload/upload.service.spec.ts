import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { UploadService } from './upload.service';

function createService() {
  const storage = {
    generateKey: vi.fn(),
    put: vi.fn(async (_key: string, stream: NodeJS.ReadableStream) => {
      // 模拟真实存储：消费传入的可读流，避免遗留未读的 Readable（打开的文件句柄）
      // 在测试结束后异步触发 unhandled 'error'。
      for await (const _chunk of stream) {
        // drain
      }
    }),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const resourceRepo = {
    findBySha256: vi.fn(),
    create: vi.fn(),
  };
  const fileRepo = {
    create: vi.fn(),
    findStoragePathReferences: vi.fn().mockResolvedValue(new Map()),
  };
  const jobRepo = { create: vi.fn() };
  const prisma = {
    category: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  };
  const config = {
    get: vi.fn((key: string) => (key === 'upload.maxFileSizeMB' ? 1024 : undefined)),
  };
  const service = new UploadService(
    storage as never,
    resourceRepo as never,
    fileRepo as never,
    jobRepo as never,
    prisma as never,
    config as never,
  );
  return { service, storage, resourceRepo, fileRepo, prisma };
}

/** 创建一个真实存在的临时文件，供 sha256 / MIME 检测读取；返回清理函数 */
function createTempFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'aurum-upload-spec-'));
  const filePath = join(dir, `${randomUUID()}.png`);
  writeFileSync(filePath, 'fake image bytes');
  return {
    path: filePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeFile(path: string): Express.Multer.File {
  return {
    path,
    size: 1024,
    originalname: 'photo.png',
    mimetype: 'image/png',
  } as Express.Multer.File;
}

describe('UploadService category validation', () => {
  it('throws a readable BadRequestException when the selected category was deleted', async () => {
    const { service, storage, resourceRepo, prisma } = createService();
    prisma.category.findUnique.mockResolvedValue(null);

    // 文件路径不必真实存在：分类校验在读取文件之前就会失败
    await expect(
      service.handleUpload(makeFile('temp/does-not-exist.tmp'), { categoryId: 'cat-deleted' }),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.category.findUnique).toHaveBeenCalledWith({
      where: { id: 'cat-deleted' },
    });
    // 不应进入事务，也不应写入存储
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(resourceRepo.create).not.toHaveBeenCalled();
  });

  it('translates a race-window FK error in the create transaction to a readable BadRequestException', async () => {
    const { service, storage, prisma } = createService();
    prisma.category.findUnique.mockResolvedValue({ id: 'cat-1' });
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        "An operation failed because it depends on one or more records that were required but not found.\nCause: No 'Category' record(s) was found for a nested connect on 'Resource#r1'.",
        { code: 'P2025', clientVersion: 'test' },
      ),
    );
    storage.generateKey.mockReturnValue('originals/abc');

    const temp = createTempFile();
    try {
      await expect(
        service.handleUpload(makeFile(temp.path), { categoryId: 'cat-1' }),
      ).rejects.toThrow(BadRequestException);
      // 竞态窗口下应清理已移入正式存储的孤儿文件
      expect(storage.delete).toHaveBeenCalledWith('originals/abc');
    } finally {
      temp.cleanup();
    }
  });

  it('cleans up the stored object when the transaction fails for any other reason', async () => {
    const { service, storage, resourceRepo, fileRepo, prisma } = createService();
    prisma.category.findUnique.mockResolvedValue({ id: 'cat-1' });
    // 非分类竞态：例如 SQLite busy / 约束错误。事务回滚后不应留下存储孤儿。
    prisma.$transaction.mockRejectedValue(new Error('database is locked'));
    storage.generateKey.mockReturnValue('originals/abc');

    const temp = createTempFile();
    try {
      await expect(
        service.handleUpload(makeFile(temp.path), { categoryId: 'cat-1' }),
      ).rejects.toThrow('database is locked');

      expect(fileRepo.findStoragePathReferences).toHaveBeenCalledWith(['originals/abc']);
      expect(storage.delete).toHaveBeenCalledWith('originals/abc');
      // 不是分类问题，不应改写成 400
      expect(resourceRepo.create).not.toHaveBeenCalled();
    } finally {
      temp.cleanup();
    }
  });

  it('keeps an unreferenced-check failure conservative (no delete when the check throws)', async () => {
    const { service, storage, fileRepo, prisma } = createService();
    prisma.category.findUnique.mockResolvedValue({ id: 'cat-1' });
    prisma.$transaction.mockRejectedValue(new Error('database is locked'));
    storage.generateKey.mockReturnValue('originals/abc');
    // 引用查询本身失败：无法确认是否共用，保守保留，交由一致性检查回收
    fileRepo.findStoragePathReferences.mockRejectedValue(new Error('db unavailable'));

    const temp = createTempFile();
    try {
      await expect(
        service.handleUpload(makeFile(temp.path), { categoryId: 'cat-1' }),
      ).rejects.toThrow('database is locked');
      expect(storage.delete).not.toHaveBeenCalled();
    } finally {
      temp.cleanup();
    }
  });

  it('does not delete an object still referenced by an existing duplicate', async () => {
    const { service, storage, fileRepo, prisma } = createService();
    prisma.category.findUnique.mockResolvedValue({ id: 'cat-1' });
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        "An operation failed because it depends on one or more records that were required but not found.\nCause: No 'Category' record(s) was found for a nested connect on 'Resource#r1'.",
        { code: 'P2025', clientVersion: 'test' },
      ),
    );
    storage.generateKey.mockReturnValue('originals/abc');
    // 上传的是已存在的重复文件：这个 storage key 仍被已有资源引用
    fileRepo.findStoragePathReferences.mockResolvedValue(
      new Map([['originals/abc', new Set(['existing-resource'])]]),
    );

    const temp = createTempFile();
    try {
      await expect(
        service.handleUpload(makeFile(temp.path), { categoryId: 'cat-1' }),
      ).rejects.toThrow(BadRequestException);
      expect(storage.delete).not.toHaveBeenCalled();
    } finally {
      temp.cleanup();
    }
  });
});
