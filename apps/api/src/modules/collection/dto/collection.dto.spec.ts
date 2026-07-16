import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { BatchAddResourcesDto, CreateCollectionDto } from './collection.dto';

describe('collection DTOs', () => {
  it('rejects empty batch resource arrays', async () => {
    const dto = plainToInstance(BatchAddResourcesDto, { resourceIds: [] });

    const errors = await validate(dto);

    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('arrayMinSize');
  });

  it('accepts valid batch add resource payloads', async () => {
    const dto = plainToInstance(BatchAddResourcesDto, { resourceIds: ['r1', 'r2'] });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('accepts valid collection creation payloads', async () => {
    const dto = plainToInstance(CreateCollectionDto, {
      name: 'Design references',
      description: 'Useful source materials',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });
});
