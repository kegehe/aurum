import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import {
  BatchFavoriteResourcesDto,
  BatchResourceIdsDto,
  BatchTagResourcesDto,
} from './batch-resource.dto';

describe('batch resource DTOs', () => {
  it('rejects empty resource id arrays', async () => {
    const dto = plainToInstance(BatchResourceIdsDto, { resourceIds: [] });

    const errors = await validate(dto);

    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('arrayMinSize');
  });

  it('rejects empty tag id arrays', async () => {
    const dto = plainToInstance(BatchTagResourcesDto, {
      resourceIds: ['r1'],
      tagIds: [],
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'tagIds')).toBe(true);
  });

  it('accepts valid favorite batch payloads', async () => {
    const dto = plainToInstance(BatchFavoriteResourcesDto, {
      resourceIds: ['r1'],
      isFavorite: true,
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });
});
