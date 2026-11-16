import { describe, expect, it } from 'vitest';
import { ResourceType } from '../../common/constants/enums';
import { SearchService } from './search.service';
import { ResourceSortField, SortOrder } from './dto/search-resource.dto';

describe('SearchService', () => {
  const service = new SearchService();

  it('excludes soft-deleted resources by default', () => {
    expect(service.buildWhereClause({})).toEqual({ deletedAt: null });
  });

  it('omits soft-delete filter when includeDeleted is true', () => {
    expect(service.buildWhereClause({ includeDeleted: true })).toEqual({});
  });

  it('filters to deleted-only resources when deletedOnly is true', () => {
    expect(service.buildWhereClause({ deletedOnly: true })).toEqual({
      deletedAt: { not: null },
    });
  });

  it('prefers deletedOnly over includeDeleted', () => {
    expect(service.buildWhereClause({ deletedOnly: true, includeDeleted: true })).toEqual({
      deletedAt: { not: null },
    });
  });

  it('builds keyword search across searchable fields', () => {
    expect(service.buildWhereClause({ keyword: 'demo' })).toEqual({
      AND: [
        { deletedAt: null },
        {
          OR: [
            { title: { contains: 'demo' } },
            { originalFilename: { contains: 'demo' } },
            { description: { contains: 'demo' } },
            { source: { contains: 'demo' } },
            { author: { contains: 'demo' } },
            { searchVector: { contains: 'demo' } },
          ],
        },
      ],
    });
  });

  it('builds structured type, category, favorite, and size filters', () => {
    expect(
      service.buildWhereClause({
        resourceType: ResourceType.image,
        categoryId: 'cat-1',
        isFavorite: true,
        sizeRange: { min: 10, max: 100 },
      }),
    ).toEqual({
      AND: [
        { deletedAt: null },
        { resourceType: ResourceType.image },
        { categoryId: 'cat-1' },
        { sizeBytes: { gte: BigInt(10), lte: BigInt(100) } },
        { isFavorite: true },
      ],
    });
  });

  it('builds uncategorized root-folder filters', () => {
    expect(service.buildWhereClause({ uncategorized: true })).toEqual({
      AND: [{ deletedAt: null }, { categoryId: null }],
    });
  });

  it('builds explicit ordering and defaults', () => {
    expect(service.buildOrderBy()).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
    expect(service.buildOrderBy(ResourceSortField.title, SortOrder.asc)).toEqual([
      { title: 'asc' },
      { id: 'asc' },
    ]);
  });
});
