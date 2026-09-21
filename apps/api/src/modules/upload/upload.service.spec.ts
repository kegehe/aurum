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
  const fileRepo = { create: vi.fn() };
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
  return { service, storage, resourceRepo, prisma };
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
});
