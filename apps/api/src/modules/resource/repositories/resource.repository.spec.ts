import { describe, expect, it, vi } from 'vitest';
import { ResourceRepository } from './resource.repository';

function createRepository() {
  const prisma = {
    resource: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    resourceFile: {
      findMany: vi.fn(),
    },
  };
  const repository = new ResourceRepository(prisma as never);
  return { repository, prisma };
}

describe('ResourceRepository findNeighbor', () => {
  const key = new Date('2026-01-02');

  it('asc + next: compares field/id with gt, ordered by field asc then id asc', async () => {
    const { repository, prisma } = createRepository();
    prisma.resource.findFirst.mockResolvedValue({ id: 'r3' });

    await expect(
      repository.findNeighbor({
        where: { deletedAt: null },
        field: 'createdAt',
        key,
        id: 'r2',
        direction: 'next',
        order: 'asc',
      }),
    ).resolves.toEqual({ id: 'r3' });

    expect(prisma.resource.findFirst).toHaveBeenCalledWith({
      where: {
        AND: [
          { deletedAt: null },
          {
            OR: [{ createdAt: { gt: key } }, { AND: [{ createdAt: key }, { id: { gt: 'r2' } }] }],
          },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
  });

  it('desc + next: compares field with lt but keeps the id-asc tiebreak', async () => {
    const { repository, prisma } = createRepository();
    prisma.resource.findFirst.mockResolvedValue(null);

    await repository.findNeighbor({
      field: 'createdAt',
      key,
      id: 'r2',
      direction: 'next',
      order: 'desc',
    });

    expect(prisma.resource.findFirst).toHaveBeenCalledWith({
      where: {
        AND: [
          {},
          {
            OR: [{ createdAt: { lt: key } }, { AND: [{ createdAt: key }, { id: { gt: 'r2' } }] }],
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: { id: true },
    });
  });

  it('desc + previous: walks the opposite side with gt and must order by the reverse total order', async () => {
    const { repository, prisma } = createRepository();
    prisma.resource.findFirst.mockResolvedValue({ id: 'r1' });

    await repository.findNeighbor({
      field: 'sizeBytes',
      key: 1024n,
      id: 'r2',
      direction: 'previous',
      order: 'desc',
    });

    expect(prisma.resource.findFirst).toHaveBeenCalledWith({
      where: {
        AND: [
          {},
          {
            OR: [
              { sizeBytes: { gt: 1024n } },
              { AND: [{ sizeBytes: 1024n }, { id: { lt: 'r2' } }] },
            ],
          },
        ],
      },
      // 全序是 sizeBytes desc, id asc；previous 必须反过来排，才能拿到最近的一条
      orderBy: [{ sizeBytes: 'asc' }, { id: 'desc' }],
      select: { id: true },
    });
  });

  it('asc + previous: keeps the comparison but reverses the ordering', async () => {
    const { repository, prisma } = createRepository();
    prisma.resource.findFirst.mockResolvedValue({ id: 'r1' });

    await repository.findNeighbor({
      field: 'createdAt',
      key,
      id: 'r2',
      direction: 'previous',
      order: 'asc',
    });

    expect(prisma.resource.findFirst).toHaveBeenCalledWith({
      where: {
        AND: [
          {},
          {
            OR: [{ createdAt: { lt: key } }, { AND: [{ createdAt: key }, { id: { lt: 'r2' } }] }],
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
  });

  it('countBefore reuses the previous-side comparison', async () => {
    const { repository, prisma } = createRepository();
    prisma.resource.count.mockResolvedValue(7);

    await expect(
      repository.countBefore({
        where: { deletedAt: null },
        field: 'title',
        key: 'beta',
        id: 'r2',
        order: 'asc',
      }),
    ).resolves.toBe(7);

    expect(prisma.resource.count).toHaveBeenCalledWith({
      where: {
        AND: [
          { deletedAt: null },
          {
            OR: [{ title: { lt: 'beta' } }, { AND: [{ title: 'beta' }, { id: { lt: 'r2' } }] }],
          },
        ],
      },
    });
  });
});

describe('ResourceRepository getTrashFileUsage', () => {
  it('returns the trash resource count and raw file rows', async () => {
    const { repository, prisma } = createRepository();
    prisma.resource.count.mockResolvedValue(2);
    prisma.resourceFile.findMany.mockResolvedValue([
      { resourceId: 'r1', storagePath: 'originals/a.png', sizeBytes: 1024n },
      { resourceId: 'r2', storagePath: 'originals/a.png', sizeBytes: 1024n },
    ]);

    await expect(repository.getTrashFileUsage()).resolves.toEqual({
      resourceCount: 2,
      files: [
        { resourceId: 'r1', storagePath: 'originals/a.png', sizeBytes: 1024n },
        { resourceId: 'r2', storagePath: 'originals/a.png', sizeBytes: 1024n },
      ],
    });
    expect(prisma.resource.count).toHaveBeenCalledWith({
      where: { deletedAt: { not: null } },
    });
    expect(prisma.resourceFile.findMany).toHaveBeenCalledWith({
      where: { resource: { deletedAt: { not: null } } },
      select: { resourceId: true, storagePath: true, sizeBytes: true },
    });
  });

  it('returns an empty file list for an empty trash', async () => {
    const { repository, prisma } = createRepository();
    prisma.resource.count.mockResolvedValue(0);
    prisma.resourceFile.findMany.mockResolvedValue([]);

    await expect(repository.getTrashFileUsage()).resolves.toEqual({
      resourceCount: 0,
      files: [],
    });
  });
});

describe('ResourceRepository batchRestore', () => {
  it('restores only trash resources and reports the rest as failed', async () => {
    const { repository, prisma } = createRepository();
    // r1 在回收站中 → 恢复；r2 未删除（deletedAt 为空）→ 失败；r3 不存在 → 失败
    prisma.resource.findMany
      .mockResolvedValueOnce([
        { id: 'r1', deletedAt: new Date('2026-01-01') },
        { id: 'r2', deletedAt: null },
      ])
      .mockResolvedValueOnce([{ id: 'r1' }]);
    prisma.resource.updateMany.mockResolvedValue({ count: 1 });

    const result = await repository.batchRestore(['r1', 'r2', 'r3']);

    expect(result).toEqual({ restored: 1, failedIds: ['r2', 'r3'] });
    expect(prisma.resource.findMany).toHaveBeenNthCalledWith(1, {
      where: { id: { in: ['r1', 'r2', 'r3'] } },
      select: { id: true, deletedAt: true },
    });
    expect(prisma.resource.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['r1'] }, deletedAt: { not: null } },
      data: { deletedAt: null },
    });
    // 结束后按最终状态复核：并发恢复/删除不能让 restored + failed 漏计数
    expect(prisma.resource.findMany).toHaveBeenNthCalledWith(2, {
      where: { id: { in: ['r1', 'r2', 'r3'] }, deletedAt: null },
      select: { id: true },
    });
  });

  it('counts a concurrently restored resource as restored and a deleted one as failed', async () => {
    const { repository, prisma } = createRepository();
    prisma.resource.findMany
      .mockResolvedValueOnce([
        { id: 'r1', deletedAt: new Date('2026-01-01') },
        { id: 'r2', deletedAt: new Date('2026-01-02') },
      ])
      // updateMany 期间 r1 被另一个请求恢复、r2 被彻底删除
      .mockResolvedValueOnce([{ id: 'r1' }]);
    prisma.resource.updateMany.mockResolvedValue({ count: 0 });

    await expect(repository.batchRestore(['r1', 'r2'])).resolves.toEqual({
      restored: 1,
      failedIds: ['r2'],
    });
  });

  it('returns all ids as failed without issuing an update when nothing is in the trash', async () => {
    const { repository, prisma } = createRepository();
    prisma.resource.findMany.mockResolvedValue([{ id: 'r1', deletedAt: null }]);

    const result = await repository.batchRestore(['r1']);

    expect(result).toEqual({ restored: 0, failedIds: ['r1'] });
    expect(prisma.resource.updateMany).not.toHaveBeenCalled();
  });
});

describe('ResourceRepository findIds', () => {
  it('selects only ids and never paginates or loads relations', async () => {
    const { repository, prisma } = createRepository();
    prisma.resource.findMany.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);

    const where = { deletedAt: null, categoryId: 'c1' };
    await expect(repository.findIds(where)).resolves.toEqual([{ id: 'r1' }, { id: 'r2' }]);

    // 全选只关心选择集合：不带 skip/take、不带 include，否则会被 pageSize 上限切割
    expect(prisma.resource.findMany).toHaveBeenCalledWith({ where, select: { id: true } });
  });
});

describe('ResourceRepository batch chunking', () => {
  it('splits large id lists to stay under the SQLite variable limit', async () => {
    const { repository, prisma } = createRepository();
    prisma.resource.updateMany.mockResolvedValue({ count: 1 });
    const ids = Array.from({ length: 501 }, (_, index) => `r${index}`);

    await expect(repository.batchSoftDelete(ids)).resolves.toBe(2);
    expect(prisma.resource.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.resource.updateMany.mock.calls[0][0].where.id.in).toHaveLength(500);
    expect(prisma.resource.updateMany.mock.calls[1][0].where.id.in).toHaveLength(1);
  });
});
