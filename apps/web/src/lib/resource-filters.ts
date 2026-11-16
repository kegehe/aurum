import { RESOURCE_TYPE_LABELS } from './constants';
import type { SearchResourcesParams } from './types';
import type { ResourceType } from '@aurum/shared-types';

/**
 * 资源筛选状态的唯一来源。
 *
 * 列表页（接口参数 / URL 同步 / 位置记忆 / 全选当前目录）与详情页相邻导航
 * 都必须用这里的同一套规则，否则同一个链接在不同入口会得到不同的结果集。
 */

const SORT_FIELD_VALUES = ['createdAt', 'title', 'sizeBytes'] as const;
const SORT_ORDER_VALUES = ['asc', 'desc'] as const;
const DATE_FIELD_VALUES = ['createdAt', 'updatedAt'] as const;

export type DateField = (typeof DATE_FIELD_VALUES)[number];

export type ResourceFilterState = {
  keyword: string;
  resourceType: ResourceType | '';
  categoryId: string;
  categoryScope: 'root' | 'all';
  acquisitionMode: string;
  /** 只看收藏：与其它条件叠加，后端按 isFavorite 过滤 */
  favoriteOnly: boolean;
  author: string;
  dateField: DateField;
  dateFrom: string;
  dateTo: string;
  minSizeMb: string;
  maxSizeMb: string;
  sortBy: string;
  sortOrder: string;
};

function isResourceType(value: string | null): value is ResourceType {
  // 用 hasOwn 而不是 in：in 会命中 toString/constructor 等原型属性，
  // 让 ?resourceType=constructor 这种非法值被当成合法类型发给后端（400）。
  return !!value && Object.prototype.hasOwnProperty.call(RESOURCE_TYPE_LABELS, value);
}

function parseSortField(value: string | null): string {
  return (SORT_FIELD_VALUES as readonly string[]).includes(value ?? '')
    ? (value as string)
    : 'createdAt';
}

function parseSortOrder(value: string | null): string {
  return (SORT_ORDER_VALUES as readonly string[]).includes(value ?? '')
    ? (value as string)
    : 'desc';
}

function parseDateField(value: string | null): DateField {
  return (DATE_FIELD_VALUES as readonly string[]).includes(value ?? '')
    ? (value as DateField)
    : 'createdAt';
}

/** 只接受 <input type="date"> 的 YYYY-MM-DD 形式，其他取值一律视为空 */
function parseDateParam(value: string | null): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

/** 大小输入以 MB 为单位；只接受非负数字，其余视为空 */
function parseSizeParam(value: string | null): string {
  if (!value) return '';
  const size = Number(value);
  return Number.isFinite(size) && size >= 0 ? value : '';
}

/** MB → bytes，非法输入返回 undefined */
function toBytes(mb: string): number | undefined {
  if (!mb.trim()) return undefined;
  const size = Number(mb);
  return Number.isFinite(size) && size >= 0 ? Math.round(size * 1024 * 1024) : undefined;
}

/**
 * 起止日期 → ISO 区间。
 * 输入是本地日历日：结束日要取当天 23:59:59.999，否则结束日当天导入的资源会被漏掉。
 */
function buildDateRangeParam(
  from: string,
  to: string,
): { start?: string; end?: string } | undefined {
  const range: { start?: string; end?: string } = {};
  if (from) {
    const start = new Date(`${from}T00:00:00`);
    if (!Number.isNaN(start.getTime())) range.start = start.toISOString();
  }
  if (to) {
    const end = new Date(`${to}T23:59:59.999`);
    if (!Number.isNaN(end.getTime())) range.end = end.toISOString();
  }
  return range.start || range.end ? range : undefined;
}

/**
 * URL → 筛选状态。
 *
 * scope 的推导规则（与资源库列表页一致）：
 * - 有 categoryId：限定在该文件夹（根目录作用域，保留“子文件夹”导航语义）
 * - scope=all / scope=root：显式指定
 * - 只有关键词/类型/只看收藏：全库范围（顶栏全局搜索、类型深链、跨文件夹收藏视图）
 * - 其余：根目录默认视图
 */
export function filtersFromSearchParams(params: URLSearchParams): ResourceFilterState {
  const keyword = params.get('keyword') ?? '';
  const type = params.get('resourceType');
  const resourceType = isResourceType(type) ? type : '';
  const categoryId = params.get('categoryId') ?? '';
  const scope = params.get('scope');
  const favoriteOnly = params.get('favorite') === 'true';

  let categoryScope: 'root' | 'all';
  if (categoryId) categoryScope = 'root';
  else if (scope === 'all') categoryScope = 'all';
  else if (scope === 'root') categoryScope = 'root';
  // 收藏是跨文件夹的视角：只看收藏时默认全库，否则放在文件夹里的收藏会看不见
  else if (keyword || resourceType || favoriteOnly) categoryScope = 'all';
  else categoryScope = 'root';

  return {
    keyword,
    resourceType,
    categoryId,
    categoryScope,
    acquisitionMode: params.get('acquisitionMode') ?? '',
    favoriteOnly,
    author: params.get('author') ?? '',
    dateField: parseDateField(params.get('dateField')),
    dateFrom: parseDateParam(params.get('dateFrom')),
    dateTo: parseDateParam(params.get('dateTo')),
    minSizeMb: parseSizeParam(params.get('minSizeMb')),
    maxSizeMb: parseSizeParam(params.get('maxSizeMb')),
    sortBy: parseSortField(params.get('sortBy')),
    sortOrder: parseSortOrder(params.get('sortOrder')),
  };
}

function selectionFields(filters: ResourceFilterState): string[] {
  return [
    filters.keyword,
    filters.resourceType,
    filters.categoryId,
    filters.categoryScope,
    filters.acquisitionMode,
    filters.favoriteOnly ? 'favorite' : '',
    filters.author,
    filters.dateField,
    filters.dateFrom,
    filters.dateTo,
    filters.minSizeMb,
    filters.maxSizeMb,
  ];
}

/** 筛选/排序签名：任一字段变化都会让签名变化（用于触发重新请求、重置页码） */
export function filterSignature(filters: ResourceFilterState): string {
  return [...selectionFields(filters), filters.sortBy, filters.sortOrder].join('|');
}

/**
 * 选择上下文签名：排序只影响顺序、不影响集合，所以不参与。
 * 筛选条件一变，之前勾选的资源可能已不可见，应清空选择。
 */
export function selectionScopeKey(filters: ResourceFilterState): string {
  return selectionFields(filters).join('|');
}

/** “更多筛选”里是否设置了任何条件 */
export function hasAdvancedFilters(filters: ResourceFilterState): boolean {
  return !!(
    filters.author ||
    filters.dateFrom ||
    filters.dateTo ||
    filters.minSizeMb ||
    filters.maxSizeMb
  );
}

/** URL 里是否带了“更多筛选”条件（用于进页面时决定是否展开面板） */
export function hasAdvancedFiltersInUrl(params: URLSearchParams): boolean {
  return !!(
    params.get('author') ||
    params.get('dateFrom') ||
    params.get('dateTo') ||
    params.get('minSizeMb') ||
    params.get('maxSizeMb')
  );
}

/** 列表 / 全选 ID / 详情页相邻导航共用的接口参数 */
export function buildFilterParams(filters: ResourceFilterState): SearchResourcesParams {
  const params: SearchResourcesParams = {};
  if (filters.keyword) params.keyword = filters.keyword;
  if (filters.resourceType) params.resourceType = filters.resourceType;
  if (filters.categoryId) params.categoryId = filters.categoryId;
  else if (filters.categoryScope === 'root') params.uncategorized = true;
  if (filters.acquisitionMode) params.acquisitionMode = filters.acquisitionMode;
  if (filters.favoriteOnly) params.isFavorite = true;
  if (filters.author) params.author = filters.author;

  const dateRange = buildDateRangeParam(filters.dateFrom, filters.dateTo);
  if (dateRange) {
    if (filters.dateField === 'updatedAt') params.updatedAtRange = dateRange;
    else params.createdAtRange = dateRange;
  }

  const min = toBytes(filters.minSizeMb);
  const max = toBytes(filters.maxSizeMb);
  if (min !== undefined || max !== undefined) {
    params.sizeRange = {};
    if (min !== undefined) params.sizeRange.min = min;
    if (max !== undefined) params.sizeRange.max = max;
  }

  params.sortBy = filters.sortBy as SearchResourcesParams['sortBy'];
  params.sortOrder = filters.sortOrder as SearchResourcesParams['sortOrder'];
  return params;
}

/**
 * 把筛选状态写入查询串（只处理受管理的参数，调用方负责 base 与 page）。
 * URL 同步与详情页相邻导航共用，避免两处规则各写一遍后逐渐不一致。
 */
export function writeFilterParams(params: URLSearchParams, filters: ResourceFilterState) {
  if (filters.keyword) params.set('keyword', filters.keyword);
  else params.delete('keyword');
  if (filters.resourceType) params.set('resourceType', filters.resourceType);
  else params.delete('resourceType');
  if (filters.categoryId) params.set('categoryId', filters.categoryId);
  else params.delete('categoryId');
  if (filters.categoryScope === 'all') {
    params.set('scope', 'all');
  } else if (
    filters.categoryScope === 'root' &&
    !filters.categoryId &&
    (filters.keyword || filters.resourceType || filters.favoriteOnly)
  ) {
    // 关键词/类型/只看收藏在 URL 读取时会被推断为全库范围，需显式 scope=root 保持“仅根目录”语义。
    params.set('scope', 'root');
  } else {
    params.delete('scope');
  }
  if (filters.acquisitionMode) params.set('acquisitionMode', filters.acquisitionMode);
  else params.delete('acquisitionMode');
  if (filters.favoriteOnly) params.set('favorite', 'true');
  else params.delete('favorite');
  if (filters.author) params.set('author', filters.author);
  else params.delete('author');
  if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
  else params.delete('dateFrom');
  if (filters.dateTo) params.set('dateTo', filters.dateTo);
  else params.delete('dateTo');
  // 更新时间与默认的创建时间同义时不必写入，保持默认链接简洁
  if (filters.dateField === 'updatedAt' && (filters.dateFrom || filters.dateTo)) {
    params.set('dateField', filters.dateField);
  } else {
    params.delete('dateField');
  }
  if (filters.minSizeMb) params.set('minSizeMb', filters.minSizeMb);
  else params.delete('minSizeMb');
  if (filters.maxSizeMb) params.set('maxSizeMb', filters.maxSizeMb);
  else params.delete('maxSizeMb');
  if (filters.sortBy !== 'createdAt' || filters.sortOrder !== 'desc') {
    params.set('sortBy', filters.sortBy);
    params.set('sortOrder', filters.sortOrder);
  } else {
    params.delete('sortBy');
    params.delete('sortOrder');
  }
}
