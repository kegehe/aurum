import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CollectionService } from './collection.service';

function createService() {
  const collectionRepo = {
    findById: vi.fn(),
    batchAddResources: vi.fn(),
  };
  const service = new CollectionService(collectionRepo as never);
  return { service, collectionRepo };
}

describe('CollectionService batch operations', () => {
  it('adds multiple resources to an existing collection', async () => {
    const { service, collectionRepo } = createService();
    collectionRepo.findById.mockResolvedValue({ id: 'collection-1' });
    collectionRepo.batchAddResources.mockResolvedValue(2);

    await expect(service.batchAddResources('collection-1', ['r1', 'r2', 'r3'])).resolves.toEqual({
      collectionId: 'collection-1',
      resourceIds: ['r1', 'r2', 'r3'],
      added: 2,
    });
    expect(collectionRepo.batchAddResources).toHaveBeenCalledWith('collection-1', [
      'r1',
      'r2',
      'r3',
    ]);
  });

  it('rejects batch add when the collection does not exist', async () => {
    const { service, collectionRepo } = createService();
    collectionRepo.findById.mockResolvedValue(null);

    await expect(service.batchAddResources('missing', ['r1'])).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(collectionRepo.batchAddResources).not.toHaveBeenCalled();
  });
});
