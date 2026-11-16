import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StatsRepository } from './stats.repository';

/**
 * 用临时 SQLite 库跑真实 SQL：去重与「回收站可释放」的判断都在 SQL 里，
 * mock groupBy 的单元测试无法覆盖，SQL 写错时会静默返回错误数字。
 */
describe('StatsRepository storageUsage', () => {
  let dir: string;
  let prisma: PrismaClient;
  let repository: StatsRepository;

  beforeEach(async () => {
    dir = path.join(tmpdir(), `aurum-stats-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    prisma = new PrismaClient({
      datasourceUrl: `file:${path.join(dir, 'stats.db').split(path.sep).join('/')}`,
    });
    repository = new StatsRepository(prisma as never);
    await prisma.$executeRawUnsafe(
      'CREATE TABLE "resources" ("id" TEXT PRIMARY KEY, "deletedAt" DATETIME)',
    );
    await prisma.$executeRawUnsafe(
      'CREATE TABLE "resource_files" ("id" TEXT PRIMARY KEY, "resourceId" TEXT NOT NULL, "storagePath" TEXT NOT NULL, "sizeBytes" BIGINT NOT NULL)',
    );
  });

  afterEach(async () => {
    await prisma.$disconnect();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function addResource(id: string, deleted: boolean) {
    const deletedAt = deleted ? new Date().toISOString() : null;
    await prisma.$executeRaw`INSERT INTO "resources" ("id", "deletedAt") VALUES (${id}, ${deletedAt})`;
  }

  async function addFile(id: string, resourceId: string, storagePath: string, sizeBytes: bigint) {
    await prisma.$executeRaw`INSERT INTO "resource_files" ("id", "resourceId", "storagePath", "sizeBytes") VALUES (${id}, ${resourceId}, ${storagePath}, ${sizeBytes})`;
  }

  it('deduplicates by storagePath and only counts files without active references as reclaimable', async () => {
    await addResource('r1', false);
    await addResource('r2', true);
    await addResource('r3', true);

    // 同一份磁盘内容被多条 ResourceFile 引用，只能计一次
    await addFile('f1', 'r1', 'originals/a.png', 100n);
    await addFile('f2', 'r2', 'originals/a.png', 100n); // 仍被正常资源 r1 引用 → 不可回收
    await addFile('f3', 'r2', 'originals/b.png', 200n);
    await addFile('f4', 'r3', 'originals/b.png', 200n); // 两个回收站资源共用 → 只计一次
    await addFile('f5', 'r1', 'originals/c.png', 300n);
    await addFile('f6', 'r3', 'originals/d.png', 400n);
    await addFile('f7', 'r2', 'originals/d.png', 450n); // 脏数据大小不一致时取最大值

    await expect(repository.storageUsage()).resolves.toEqual({
      totalBytes: 1050n, // a 100 + b 200 + c 300 + d 450
      trashBytes: 650n, // b 200 + d 450
    });
  });

  it('returns zeros for an empty library', async () => {
    await expect(repository.storageUsage()).resolves.toEqual({
      totalBytes: 0n,
      trashBytes: 0n,
    });
  });
});
