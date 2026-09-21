import { describe, expect, it, vi } from 'vitest';
import { ResourceRepository } from './resource.repository';

function createRepository() {
  const prisma = {
    resource: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  const repository = new ResourceRepository(prisma as never);
  return { repository, prisma };
}

describe('ResourceRepository findSortKeys', () => {
  it('selects only id and the requested sort field, ordered by id ascending', async () => {
    const { repository, prisma } = createRepository();
    prisma.resource.findMany.mockResolvedValue([
      { id: 'r2', createdAt: new Date('2026-01-02') },
      { id: 'r1', createdAt: new Date('2026-01-01') },
    ]);

    const result = await repository.findSortKeys({ where: { deletedAt: null }, field: 'createdAt' });

    expect(result).toEqual([
      { id: 'r2', sortKey: new Date('2026-01-02') },
      { id: 'r1', sortKey: new Date('2026-01-01') },
    ]);
    expect(prisma.resource.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
      orderBy: { id: 'asc' },
      select: { id: true, createdAt: true },
    });
  });
});


describe('ResourceRepository batchRestore', () => {
  it('restores only trash resources and reports the rest as failed', async () => {
    const { repository, prisma } = createRepository();
    // r1 在回收站中 → 恢复；r2 未删除（deletedAt 为空）→ 失败；r3 不存在 → 失败
    prisma.resource.findMany.mockResolvedValue([
      { id: 'r1', deletedAt: new Date('2026-01-01') },
      { id: 'r2', deletedAt: null },
    ]);
    prisma.resource.updateMany.mockResolvedValue({ count: 1 });

    const result = await repository.batchRestore(['r1', 'r2', 'r3']);

    expect(result).toEqual({ restored: 1, failedIds: ['r2', 'r3'] });
    expect(prisma.resource.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['r1', 'r2', 'r3'] } },
      select: { id: true, deletedAt: true },
    });
    expect(prisma.resource.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['r1'] }, deletedAt: { not: null } },
      data: { deletedAt: null },
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
