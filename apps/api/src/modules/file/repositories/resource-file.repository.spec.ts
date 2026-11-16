import { describe, expect, it, vi } from 'vitest';
import { ResourceFileRepository } from './resource-file.repository';

function createRepository() {
  const prisma = {
    resourceFile: {
      findMany: vi.fn(),
    },
  };
  const repository = new ResourceFileRepository(prisma as never);
  return { repository, prisma };
}

describe('ResourceFileRepository findStoragePathReferences', () => {
  it('maps each storage path to every resource that references it', async () => {
    const { repository, prisma } = createRepository();
    prisma.resourceFile.findMany.mockResolvedValue([
      { storagePath: 'originals/a.png', resourceId: 'r1' },
      { storagePath: 'originals/a.png', resourceId: 'r2' },
      { storagePath: 'thumbnails/a.webp', resourceId: 'r1' },
    ]);

    const references = await repository.findStoragePathReferences([
      'originals/a.png',
      'thumbnails/a.webp',
    ]);

    expect(references.get('originals/a.png')).toEqual(new Set(['r1', 'r2']));
    expect(references.get('thumbnails/a.webp')).toEqual(new Set(['r1']));
    expect(references.has('unreferenced.path')).toBe(false);
    expect(prisma.resourceFile.findMany).toHaveBeenCalledWith({
      where: {
        storagePath: { in: ['originals/a.png', 'thumbnails/a.webp'] },
      },
      select: { storagePath: true, resourceId: true },
    });
  });

  it('deduplicates paths and queries in chunks to stay under SQLite parameter limits', async () => {
    const { repository, prisma } = createRepository();
    prisma.resourceFile.findMany.mockResolvedValue([]);
    const paths = Array.from({ length: 600 }, (_, index) => `originals/${index}.png`);

    await repository.findStoragePathReferences([...paths, ...paths]);

    expect(prisma.resourceFile.findMany).toHaveBeenCalledTimes(2);
    const firstCall = prisma.resourceFile.findMany.mock.calls[0][0] as {
      where: { storagePath: { in: string[] } };
    };
    const secondCall = prisma.resourceFile.findMany.mock.calls[1][0] as {
      where: { storagePath: { in: string[] } };
    };
    expect(firstCall.where.storagePath.in).toHaveLength(500);
    expect(secondCall.where.storagePath.in).toHaveLength(100);
  });

  it('does not query the database when there are no paths', async () => {
    const { repository, prisma } = createRepository();

    await expect(repository.findStoragePathReferences([])).resolves.toEqual(new Map());
    expect(prisma.resourceFile.findMany).not.toHaveBeenCalled();
  });
});
