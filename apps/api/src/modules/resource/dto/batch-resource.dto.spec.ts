import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import {
  BatchCategoryResourcesDto,
  BatchFavoriteResourcesDto,
  BatchResourceIdsDto,
} from './batch-resource.dto';

describe('batch resource DTOs', () => {
  it('rejects empty resource id arrays', async () => {
    const dto = plainToInstance(BatchResourceIdsDto, { resourceIds: [] });

    const errors = await validate(dto);

    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('arrayMinSize');
  });

  // 原生表单下载只能提交 urlencoded，且 ID 必须挤在一个字段里（多字段会撞上解析器参数上限）
  describe('urlencoded 表单提交', () => {
    it('splits a comma joined id list into an array', async () => {
      const dto = plainToInstance(BatchResourceIdsDto, { resourceIds: 'r1,r2,r3' });

      await expect(validate(dto)).resolves.toHaveLength(0);
      expect(dto.resourceIds).toEqual(['r1', 'r2', 'r3']);
    });

    it('accepts a single id and ignores a trailing comma', async () => {
      const dto = plainToInstance(BatchResourceIdsDto, { resourceIds: 'r1,' });

      await expect(validate(dto)).resolves.toHaveLength(0);
      expect(dto.resourceIds).toEqual(['r1']);
    });

    it('rejects an empty joined string', async () => {
      const dto = plainToInstance(BatchResourceIdsDto, { resourceIds: '' });

      const errors = await validate(dto);
      expect(errors).toHaveLength(1);
      expect(errors[0].constraints).toHaveProperty('arrayMinSize');
    });
  });

  it('accepts valid favorite batch payloads', async () => {
    const dto = plainToInstance(BatchFavoriteResourcesDto, {
      resourceIds: ['r1'],
      isFavorite: true,
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  describe('BatchCategoryResourcesDto', () => {
    it('accepts null categoryId (disconnect category)', async () => {
      const dto = plainToInstance(BatchCategoryResourcesDto, {
        resourceIds: ['r1'],
        categoryId: null,
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('accepts valid UUID categoryId', async () => {
      const dto = plainToInstance(BatchCategoryResourcesDto, {
        resourceIds: ['r1'],
        categoryId: '550e8400-e29b-41d4-a716-446655440000',
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('rejects empty string categoryId', async () => {
      const dto = plainToInstance(BatchCategoryResourcesDto, {
        resourceIds: ['r1'],
        categoryId: '',
      });

      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'categoryId')).toBe(true);
    });

    it('rejects non-UUID categoryId', async () => {
      const dto = plainToInstance(BatchCategoryResourcesDto, {
        resourceIds: ['r1'],
        categoryId: 'not-a-uuid',
      });

      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'categoryId')).toBe(true);
    });

    it('accepts omitted categoryId (no change)', async () => {
      const dto = plainToInstance(BatchCategoryResourcesDto, {
        resourceIds: ['r1'],
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });
  });
});
