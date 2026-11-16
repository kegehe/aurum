import { describe, expect, it } from 'vitest';
import {
  buildFilterParams,
  filtersFromSearchParams,
  filterSignature,
  hasAdvancedFilters,
  hasAdvancedFiltersInUrl,
  writeFilterParams,
} from './resource-filters';

const emptyFilters = filtersFromSearchParams(new URLSearchParams());

describe('filtersFromSearchParams', () => {
  it('空 URL 落到根目录默认视图', () => {
    expect(emptyFilters.categoryScope).toBe('root');
    expect(emptyFilters.sortBy).toBe('createdAt');
    expect(emptyFilters.sortOrder).toBe('desc');
    expect(hasAdvancedFilters(emptyFilters)).toBe(false);
  });

  it('有 categoryId 时限定在该文件夹', () => {
    const filters = filtersFromSearchParams(new URLSearchParams('categoryId=c1'));
    expect(filters.categoryId).toBe('c1');
    expect(filters.categoryScope).toBe('root');
  });

  it('只有关键词/类型时推断为全库范围，显式 scope=root 时保留根目录', () => {
    expect(filtersFromSearchParams(new URLSearchParams('keyword=abc')).categoryScope).toBe('all');
    expect(filtersFromSearchParams(new URLSearchParams('resourceType=video')).categoryScope).toBe(
      'all',
    );
    expect(
      filtersFromSearchParams(new URLSearchParams('keyword=abc&scope=root')).categoryScope,
    ).toBe('root');
    expect(filtersFromSearchParams(new URLSearchParams('scope=all')).categoryScope).toBe('all');
  });

  it('favorite=true 进入只看收藏，并推断为全库范围（跨文件夹）', () => {
    const filters = filtersFromSearchParams(new URLSearchParams('favorite=true'));
    expect(filters.favoriteOnly).toBe(true);
    expect(filters.categoryScope).toBe('all');

    // 显式指定文件夹时仍以文件夹为准
    expect(
      filtersFromSearchParams(new URLSearchParams('favorite=true&categoryId=c1')).categoryScope,
    ).toBe('root');
    expect(filtersFromSearchParams(new URLSearchParams('favorite=false')).favoriteOnly).toBe(false);
  });

  it('忽略非法/原型链上的类型名', () => {
    expect(filtersFromSearchParams(new URLSearchParams('resourceType=video')).resourceType).toBe(
      'video',
    );
    expect(filtersFromSearchParams(new URLSearchParams('resourceType=toString')).resourceType).toBe(
      '',
    );
    expect(
      filtersFromSearchParams(new URLSearchParams('resourceType=constructor')).resourceType,
    ).toBe('');
  });

  it('丢弃非法日期与大小', () => {
    const filters = filtersFromSearchParams(
      new URLSearchParams('dateFrom=2026-10-01x&dateTo=2026-10-31&minSizeMb=-1&maxSizeMb=500'),
    );
    expect(filters.dateFrom).toBe('');
    expect(filters.dateTo).toBe('2026-10-31');
    expect(filters.minSizeMb).toBe('');
    expect(filters.maxSizeMb).toBe('500');
  });
});

describe('buildFilterParams', () => {
  it('结束日期取当天 23:59:59.999，起始日期取 00:00', () => {
    const params = buildFilterParams({
      ...emptyFilters,
      dateFrom: '2026-10-01',
      dateTo: '2026-10-07',
    });
    expect(params.createdAtRange).toEqual({
      start: new Date('2026-10-01T00:00:00').toISOString(),
      end: new Date('2026-10-07T23:59:59.999').toISOString(),
    });
    expect(params.updatedAtRange).toBeUndefined();
  });

  it('dateField=updatedAt 时作用在更新时间上', () => {
    const params = buildFilterParams({
      ...emptyFilters,
      dateField: 'updatedAt',
      dateFrom: '2026-10-01',
    });
    expect(params.updatedAtRange).toBeDefined();
    expect(params.createdAtRange).toBeUndefined();
  });

  it('大小按 MB 换算成 bytes，只填一侧时另一侧不出现', () => {
    const params = buildFilterParams({ ...emptyFilters, minSizeMb: '500' });
    expect(params.sizeRange).toEqual({ min: 500 * 1024 * 1024 });
  });

  it('作者原样透传，空字符串不产生参数', () => {
    expect(buildFilterParams({ ...emptyFilters, author: '张三' }).author).toBe('张三');
    expect(buildFilterParams(emptyFilters).author).toBeUndefined();
    expect(buildFilterParams(emptyFilters).sizeRange).toBeUndefined();
    expect(buildFilterParams(emptyFilters).createdAtRange).toBeUndefined();
  });

  it('只看收藏转成 isFavorite=true，未开启时不带该参数', () => {
    expect(buildFilterParams({ ...emptyFilters, favoriteOnly: true }).isFavorite).toBe(true);
    expect(buildFilterParams(emptyFilters).isFavorite).toBeUndefined();
  });

  it('根目录视图用 uncategorized，全库视图不加分类条件', () => {
    expect(buildFilterParams(emptyFilters).uncategorized).toBe(true);
    expect(
      buildFilterParams({ ...emptyFilters, categoryScope: 'all' }).uncategorized,
    ).toBeUndefined();
  });
});

describe('writeFilterParams', () => {
  it('写入后再读回得到同一份筛选状态（刷新/分享链接不丢条件）', () => {
    const filters = {
      ...emptyFilters,
      keyword: '周报',
      author: '张三',
      dateField: 'updatedAt' as const,
      dateFrom: '2026-10-01',
      dateTo: '2026-10-31',
      minSizeMb: '100',
      maxSizeMb: '2048',
      sortBy: 'sizeBytes',
      sortOrder: 'asc',
    };
    const params = new URLSearchParams();
    writeFilterParams(params, filters);

    expect(filtersFromSearchParams(params)).toEqual(filters);
  });

  it('默认值不写进 URL', () => {
    const params = new URLSearchParams();
    writeFilterParams(params, emptyFilters);
    expect(params.toString()).toBe('');

    const withDates = new URLSearchParams();
    writeFilterParams(withDates, { ...emptyFilters, dateFrom: '2026-10-01' });
    // 创建时间是默认字段，不必写 dateField
    expect(withDates.get('dateField')).toBeNull();
    expect(withDates.get('dateFrom')).toBe('2026-10-01');
  });

  it('只看收藏写入 favorite=true 并能原样读回', () => {
    const filters = { ...emptyFilters, favoriteOnly: true, categoryScope: 'all' as const };
    const params = new URLSearchParams();
    writeFilterParams(params, filters);
    expect(params.get('favorite')).toBe('true');
    expect(filtersFromSearchParams(params)).toEqual(filters);
  });

  it('收藏 + 显式根目录时写入 scope=root，刷新后仍是根目录范围', () => {
    const filters = { ...emptyFilters, favoriteOnly: true, categoryScope: 'root' as const };
    const params = new URLSearchParams();
    writeFilterParams(params, filters);
    expect(params.get('scope')).toBe('root');
    expect(filtersFromSearchParams(params)).toEqual(filters);
  });

  it('签名随任一条件变化', () => {
    expect(filterSignature(emptyFilters)).not.toBe(
      filterSignature({ ...emptyFilters, maxSizeMb: '1' }),
    );
    expect(filterSignature(emptyFilters)).not.toBe(
      filterSignature({ ...emptyFilters, favoriteOnly: true }),
    );
  });
});

describe('hasAdvancedFiltersInUrl', () => {
  it('识别作者/日期/大小参数', () => {
    expect(hasAdvancedFiltersInUrl(new URLSearchParams('keyword=a'))).toBe(false);
    expect(hasAdvancedFiltersInUrl(new URLSearchParams('author=张三'))).toBe(true);
    expect(hasAdvancedFiltersInUrl(new URLSearchParams('minSizeMb=10'))).toBe(true);
    expect(hasAdvancedFiltersInUrl(new URLSearchParams('dateTo=2026-10-01'))).toBe(true);
  });
});
