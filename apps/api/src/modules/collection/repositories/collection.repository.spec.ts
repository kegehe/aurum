import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { CollectionRepository } from './collection.repository';

function createRepository() {
  const prisma = {
    collectionResource: {
      create: vi.fn(),
      delete: vi.fn(),
    },
  };
  const repository = new CollectionRepository(prisma as never);
  return { repository, prisma };
}

function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError('Prisma error', {
    code,
    clientVersion: 'test',
  });
}

describe('CollectionRepository resource links', () => {
  it('ignores duplicate single resource additions', async () => {
    const { repository, prisma } = createRepository();
    prisma.collectionResource.create.mockRejectedValue(prismaError('P2002'));

    await expect(repository.addResource('collection-1', 'resource-1')).resolves.toBeUndefined();
  });

  it('propagates invalid resource errors for single resource additions', async () => {
    const { repository, prisma } = createRepository();
    prisma.collectionResource.create.mockRejectedValue(prismaError('P2003'));

    await expect(repository.addResource('collection-1', 'missing-resource')).rejects.toMatchObject({
      code: 'P2003',
    });
  });

  it('ignores missing links when removing a resource', async () => {
    const { repository, prisma } = createRepository();
    prisma.collectionResource.delete.mockRejectedValue(prismaError('P2025'));

    await expect(
      repository.removeResource('collection-1', 'resource-1'),
    ).resolves.toBeUndefined();
  });

  it('propagates unexpected remove errors', async () => {
    const { repository, prisma } = createRepository();
    prisma.collectionResource.delete.mockRejectedValue(new Error('database unavailable'));

    await expect(repository.removeResource('collection-1', 'resource-1')).rejects.toThrow(
      'database unavailable',
    );
  });
});
