'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CloudDownload,
  Download,
  ExternalLink,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  Heart,
  HeartOff,
  Pencil,
  SlidersHorizontal,
  SquareCheck,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { ResourceGrid } from '@/components/shared/resource-grid';
import { DataTable, type Column } from '@/components/shared/data-table';
import { ErrorState } from '@/components/shared/error-state';
import { EmptyState } from '@/components/shared/empty-state';
import { ResourcePreview } from '@/components/shared/resource-preview';
import { ResourceTypeBadge } from '@/components/shared/resource-type-badge';
import { SearchInput } from '@/components/shared/search-input';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  batchDeleteResources,
  batchMirrorResources,
  batchSetResourceCategory,
  batchSetResourceFavorite,
  canStreamZipToDisk,
  downloadResourcesZip,
  listResourceIds,
  listResources,
  restoreResource,
  softDeleteResource,
  type BatchMirrorSkipReason,
} from '@/lib/api/resources';
import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
} from '@/lib/api/categories';
import { formatBytes, formatByteString, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { readViewMemory, writeViewMemory } from '@/lib/view-memory';
import {
  buildFilterParams,
  filterSignature,
  filtersFromSearchParams,
  selectionScopeKey,
  hasAdvancedFilters,
  hasAdvancedFiltersInUrl,
  writeFilterParams,
  type DateField,
  type ResourceFilterState,
} from '@/lib/resource-filters';
import { RESOURCE_TYPE_LABELS } from '@/lib/constants';
import { designMediaHref, isDesignMediaType } from '@/lib/resource';
import { ResourceListSkeleton, ResourceViewPanels, ResourceViewToggle } from './resource-views';
import type { ResourceListItem, CategoryTreeNode } from '@/lib/types';
import type { ResourceType } from '@aurum/shared-types';

const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
const PAGE_SIZE_STORAGE_KEY = 'aurum.resources.page-size';
const ALL_RESOURCE_TYPES_VALUE = '__all_resource_types__';
const ALL_CATEGORIES_VALUE = '__all_categories__';
const UNCATEGORIZED_CATEGORY_VALUE = '__uncategorized__';
const ALL_ACQUISITION_MODES_VALUE = '__all_acquisition_modes__';
const ROOT_FOLDER_VALUE = '__root_folder__';
const NO_FOLDER_VALUE = '__no_folder__';
const DRAG_DATA_TYPE = 'application/x-aurum';

/** 批量下载到本地时，被跳过资源的提示文案 */
const BATCH_MIRROR_SKIP_LABELS: Record<BatchMirrorSkipReason, string> = {
  not_found: '资源或来源不存在',
  deleted: '已删除',
  already_local: '已有本地原文件',
  no_source_url: '没有下载地址',
  no_source: '缺少来源配置',
  policy: '来源策略不允许',
  error: '提交失败',
};

function describeBatchMirrorSkips(
  skippedResources: Array<{ reason: BatchMirrorSkipReason }>,
): string {
  const counts = new Map<BatchMirrorSkipReason, number>();
  for (const { reason } of skippedResources) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return Array.from(
    counts,
    ([reason, count]) => `${BATCH_MIRROR_SKIP_LABELS[reason]} ${count} 个`,
  ).join('、');
}

/**
 * 批量下载到本地时每个请求的最大资源数。
 * 服务端逐条走策略门禁与入队，单个请求太小会多几次往返，太大会长时间占用连接；
 * 100 与服务端的批量上限配合，正常使用不会触发服务端 400。
 */
const BATCH_MIRROR_CHUNK_SIZE = 100;

function chunkIds(ids: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

type DragPayload = { type: 'resources'; ids: string[] } | { type: 'folder'; id: string };

type PaginationItem = number | 'start-ellipsis' | 'end-ellipsis';

function getStoredPageSize(): number {
  if (typeof window === 'undefined') return DEFAULT_PAGE_SIZE;

  const storedValue = Number(window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY));
  return PAGE_SIZE_OPTIONS.includes(storedValue as (typeof PAGE_SIZE_OPTIONS)[number])
    ? storedValue
    : DEFAULT_PAGE_SIZE;
}

function flattenCategories(categories: CategoryTreeNode[]): CategoryTreeNode[] {
  return categories.flatMap((category) => [category, ...flattenCategories(category.children)]);
}

function findCategory(categories: CategoryTreeNode[], id: string): CategoryTreeNode | null {
  for (const category of categories) {
    if (category.id === id) return category;
    const child = findCategory(category.children, id);
    if (child) return child;
  }
  return null;
}

function getCategoryPath(categories: CategoryTreeNode[], id: string): CategoryTreeNode[] {
  for (const category of categories) {
    if (category.id === id) return [category];
    const childPath = getCategoryPath(category.children, id);
    if (childPath.length > 0) return [category, ...childPath];
  }
  return [];
}

function containsCategory(categories: CategoryTreeNode[], id: string): boolean {
  return categories.some(
    (category) => category.id === id || containsCategory(category.children, id),
  );
}

export default function ResourcesPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // 数据
  const [resources, setResources] = useState<ResourceListItem[]>([]);
  const [loading, setLoading] = useState(true);
  // 已有数据时的再次拉取（搜索/筛选/翻页）：不卸载列表，只在顶部显示细进度条。
  // 用骨架屏替换整块列表会让内容高度骤降（滚动位被夹回顶部），并让 50 张缩略图重新解码。
  const [refreshing, setRefreshing] = useState(false);
  const loadedOnceRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(getStoredPageSize);
  const [pageInput, setPageInput] = useState('1');
  // URL 参数是否已应用到筛选状态：首次请求前先等待，避免挂载时用默认状态发一次无效请求。
  const [urlParamsApplied, setUrlParamsApplied] = useState(false);
  // 请求序号：用于忽略过期响应，避免慢的旧请求后返回时用旧数据覆盖新结果（竞态）。
  const requestIdRef = useRef(0);
  // 列表顶部锚点：翻页/换筛选后滚到这里，而不是整页跳回顶部
  const listAnchorRef = useRef<HTMLDivElement>(null);
  // 位置恢复：等对应页的数据回来、列表渲染出来后，再滚回上次的位置
  const restoreRef = useRef<{ pending: boolean; page: number; scrollY: number; key: string }>({
    pending: false,
    page: 1,
    scrollY: 0,
    key: '',
  });
  // 上一次由“状态→URL”同步 effect 写入的查询串：监听 effect 据此识别自身写入，跳过重复应用。
  const lastSyncedSearchRef = useRef<string | null>(null);
  // 最新 URL 查询串：供“状态→URL”effect 作为基底读取。该 effect 刻意不依赖 searchParams，
  // 否则外部导航（URL 先变、state 尚未提交）时会在同一提交里用旧筛选状态覆盖新 URL。
  const searchParamsRef = useRef(searchParams.toString());

  // 搜索/筛选
  // 首屏筛选值直接从 URL 取（懒初始化只算一次），避免挂载时先从空条件起步
  // 造成一次防抖滞后请求、或让深链里的条件短暂显示为空。
  const [initialFilters] = useState(() => filtersFromSearchParams(searchParams));
  const [keyword, setKeyword] = useState(initialFilters.keyword);
  // 页内输入走防抖；URL 跳转的关键词由 URL-sync effect 直接同步 debouncedKeyword，避免滞后请求。
  const [debouncedKeyword, setDebouncedKeyword] = useState(initialFilters.keyword);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword), 300);
    return () => clearTimeout(timer);
  }, [keyword]);
  const [resourceType, setResourceType] = useState<ResourceType | ''>(initialFilters.resourceType);
  const [categoryId, setCategoryId] = useState(initialFilters.categoryId);
  const [categoryScope, setCategoryScope] = useState<'root' | 'all'>(initialFilters.categoryScope);
  const [acquisitionMode, setAcquisitionMode] = useState(initialFilters.acquisitionMode);
  // 只看收藏：与其它筛选叠加，开启时会离开当前文件夹、跨文件夹查看收藏过的资源
  const [favoriteOnly, setFavoriteOnly] = useState(initialFilters.favoriteOnly);
  // 开启收藏视图时被清掉的文件夹位置：关闭时若用户没有主动换过文件夹，就还原回去。
  const favoriteReturnRef = useRef<{ categoryId: string; categoryScope: 'root' | 'all' } | null>(
    null,
  );
  const [sortBy, setSortBy] = useState<string>(initialFilters.sortBy);
  const [sortOrder, setSortOrder] = useState<string>(initialFilters.sortOrder);

  // 更多筛选（后端已支持，但默认收起，避免筛选栏过挤）
  const [author, setAuthor] = useState(initialFilters.author);
  const [debouncedAuthor, setDebouncedAuthor] = useState(initialFilters.author);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedAuthor(author), 300);
    return () => clearTimeout(timer);
  }, [author]);
  const [dateField, setDateField] = useState<DateField>(initialFilters.dateField);
  const [dateFrom, setDateFrom] = useState(initialFilters.dateFrom);
  const [dateTo, setDateTo] = useState(initialFilters.dateTo);
  const [minSizeMb, setMinSizeMb] = useState(initialFilters.minSizeMb);
  const [maxSizeMb, setMaxSizeMb] = useState(initialFilters.maxSizeMb);
  const [filtersOpen, setFiltersOpen] = useState(() => hasAdvancedFiltersInUrl(searchParams));

  // 所有会影响结果集的筛选集中到一处：请求参数、URL、位置记忆、全选上下文都从这里取，
  // 新增条件时不必再逐个改 4 份重复的拼接逻辑。
  const filterState = useMemo<ResourceFilterState>(
    () => ({
      keyword: debouncedKeyword,
      resourceType,
      categoryId,
      categoryScope,
      acquisitionMode,
      favoriteOnly,
      author: debouncedAuthor,
      dateField,
      dateFrom,
      dateTo,
      minSizeMb,
      maxSizeMb,
      sortBy,
      sortOrder,
    }),
    [
      debouncedKeyword,
      resourceType,
      categoryId,
      categoryScope,
      acquisitionMode,
      favoriteOnly,
      debouncedAuthor,
      dateField,
      dateFrom,
      dateTo,
      minSizeMb,
      maxSizeMb,
      sortBy,
      sortOrder,
    ],
  );

  // 批量编辑模式：开启后点击卡片为选中而非跳转，按住拖拽可扫选多个资源
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectingAllDirectory, setSelectingAllDirectory] = useState(false);

  // 多选
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const selectionContextKey = selectionScopeKey(filterState);
  const selectionContextKeyRef = useRef(selectionContextKey);
  selectionContextKeyRef.current = selectionContextKey;
  const selectAllRequestIdRef = useRef(0);
  useEffect(() => {
    // 筛选条件变化后，旧选择可能已不可见；作废进行中的全选并清空勾选。
    selectAllRequestIdRef.current += 1;
    setSelectedIds(new Set());
  }, [selectionContextKey]);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [moveTargetCategoryId, setMoveTargetCategoryId] = useState(NO_FOLDER_VALUE);

  // 批量删除确认（单条删除直接执行，靠 toast 撤销）
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);

  // 批量下载：边收边写盘时在右下角显示进度，可随时取消；native 模式交给浏览器下载列表。
  // 离开本页不中断传输（与浏览器下载一致，完成后照常 toast），主动取消只走进度卡按钮
  const [zipDownloading, setZipDownloading] = useState<{
    loadedBytes: number;
    totalResources: number;
  } | null>(null);
  const zipAbortRef = useRef<AbortController | null>(null);
  // 批量“下载到本地”的提交进度：避免重复点击为同一批资源反复入队；
  // 大选择集按 BATCH_MIRROR_CHUNK_SIZE 分批提交，这里记录已完成/总批次数。
  const [batchMirroring, setBatchMirroring] = useState<{
    completed: number;
    total: number;
  } | null>(null);

  // 下拉选项
  const [categories, setCategories] = useState<CategoryTreeNode[]>([]);

  // 文件夹创建
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [editingFolder, setEditingFolder] = useState<CategoryTreeNode | null>(null);
  const [folderName, setFolderName] = useState('');
  const [folderParentId, setFolderParentId] = useState<string | null>(null);
  const [folderDeleteTarget, setFolderDeleteTarget] = useState<CategoryTreeNode | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);

  /**
   * 拉取列表。
   * silent=true 用于操作成功后的补偿刷新：保留当前列表、不切加载态。
   * 首次加载才用整块骨架；之后（搜索/筛选/翻页）保留旧列表 + refreshing 指示，
   * 避免每次操作都卸载 50 张卡片、把滚动位置弹回顶部。
   */
  const fetchResources = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      const requestId = ++requestIdRef.current;
      if (!silent) {
        if (loadedOnceRef.current) setRefreshing(true);
        else setLoading(true);
        setError(null);
      }
      try {
        // 筛选/排序条件由 buildFilterParams 统一产生，这里只补分页
        const params: Parameters<typeof listResources>[0] = {
          ...buildFilterParams(filterState),
          page,
          pageSize,
        };

        const data = await listResources(params);
        if (requestId !== requestIdRef.current) return; // 已被更新的请求取代，丢弃过期结果
        setResources(data.items);
        setTotal(data.total);
        loadedOnceRef.current = true;
        // 位置恢复：等这一页的数据落地并渲染后再滚，避免被后续布局变化打断。
        // 记忆键也要一致：筛选变了说明恢复目标已失效，直接丢弃，避免下次翻到同一页时误滚。
        if (restoreRef.current.pending) {
          const restore = restoreRef.current;
          if (restore.key !== viewMemoryKeyRef.current) {
            restoreRef.current.pending = false;
          } else if (restore.page === page) {
            restoreRef.current.pending = false;
            window.requestAnimationFrame(() => window.scrollTo(0, restore.scrollY));
          }
        }
      } catch (e) {
        if (requestId !== requestIdRef.current) return;
        // 静默刷新失败时保留上一份数据，不把列表替换成错误页
        if (!silent) setError(e instanceof Error ? e.message : '加载失败');
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [page, pageSize, filterState],
  );

  // 最近一次 fetchResources：批量任务可能持续数秒，期间用户可能翻页或改筛选。
  // 完成后的补偿刷新必须用当前视图，而不是提交时捕获的旧闭包。
  const fetchResourcesRef = useRef(fetchResources);
  useEffect(() => {
    fetchResourcesRef.current = fetchResources;
  }, [fetchResources]);

  // 初始加载选项
  useEffect(() => {
    listCategories()
      .then((d) => setCategories(d.items))
      .catch(() => {});
  }, []);

  // URL 是筛选状态的权威来源：?keyword=（顶栏全局搜索）、?resourceType=/?categoryId=/?scope=（仪表盘深链）。
  // 监听 searchParams：已在资源库页内时通过顶栏再次搜索也能即时应用；导航到不带参数的 URL 会重置本地筛选。
  // 由下方“状态→URL”effect 写入的 URL 已与本地状态一致，跳过应用，避免覆盖正在编辑的输入。
  useEffect(() => {
    searchParamsRef.current = searchParams.toString();
    // 仅当 URL 是本组件“刚写入、尚未落地”的自写 URL 时跳过。
    if (lastSyncedSearchRef.current === searchParams.toString()) return;

    // 这是一次外部导航（顶栏搜索、仪表盘深链、浏览器前进/后退等）：使 lastSyncedSearchRef 失效。
    // 否则前进/后退回到一个“此前曾写入过”的 URL 时，会被误判为自写而跳过应用，
    // 导致筛选状态停留在上一个视图、与 URL 不一致。
    lastSyncedSearchRef.current = null;
    // 外部导航后不再知道用户是从哪个文件夹进入收藏视图的，丢弃待还原的位置。
    favoriteReturnRef.current = null;

    // URL → 筛选状态（含 scope 推导）由 resource-filters 统一解释，
    // 详情页的相邻导航用的也是同一份规则。
    const filters = filtersFromSearchParams(searchParams);
    setKeyword(filters.keyword);
    // 关键词/作者来自 URL 跳转时立即同步防抖值，避免先发一次带旧值的请求。
    setDebouncedKeyword(filters.keyword);
    setDebouncedAuthor(filters.author);
    setAuthor(filters.author);
    setResourceType(filters.resourceType);
    setCategoryId(filters.categoryId);
    setCategoryScope(filters.categoryScope);
    setAcquisitionMode(filters.acquisitionMode);
    setFavoriteOnly(filters.favoriteOnly);
    setSortBy(filters.sortBy);
    setSortOrder(filters.sortOrder);
    setDateField(filters.dateField);
    setDateFrom(filters.dateFrom);
    setDateTo(filters.dateTo);
    setMinSizeMb(filters.minSizeMb);
    setMaxSizeMb(filters.maxSizeMb);

    // 带更多筛选条件的链接进来时直接展开面板，否则条件生效了却看不见入口。
    if (hasAdvancedFilters(filters)) setFiltersOpen(true);

    setUrlParamsApplied(true);
  }, [searchParams]);

  // 将筛选/排序状态同步回 URL，使刷新页面或分享链接能保留当前视图。
  // 以 searchParamsRef 为基底，仅更新受管理的参数并保留未知参数；仅当结果与当前 URL 不同才 router.replace。
  // 写入的查询串记录到 lastSyncedSearchRef，供上方监听 effect 识别为“自身写入”而跳过，避免循环。
  // 注意：不依赖 searchParams，只依赖筛选状态——外部导航时 URL 先变、state 尚未提交，
  // 若把 searchParams 放入依赖，会在同一提交里用旧筛选状态覆盖刚到达的新 URL。
  useEffect(() => {
    if (!urlParamsApplied) return;

    const params = new URLSearchParams(searchParamsRef.current);
    writeFilterParams(params, filterState);
    // 分页仍是本地状态，不从 URL 读取，同步时移除 page 参数避免链接里的页码与实际结果不一致。
    params.delete('page');

    const next = params.toString();
    if (next !== searchParamsRef.current) {
      lastSyncedSearchRef.current = next;
      router.replace(next ? `?${next}` : pathname, { scroll: false });
    }
  }, [urlParamsApplied, filterState, router, pathname]);

  // 上一次触发获取的筛选签名：用于区分“筛选变化”（需重置页码）与“页码变化”（直接获取）。
  const prevFiltersKeyRef = useRef('');
  // 筛选/排序签名：任一变化都会让 key 变化，从而触发重新获取。
  const filtersKey = filterSignature(filterState);

  // 首次获取等 URL 参数应用后再请求。筛选变化时先重置页码到第 1 页再获取，
  // 避免先按旧页码发一次请求；页码单独变化时直接获取。
  useEffect(() => {
    if (!urlParamsApplied) return;
    if (prevFiltersKeyRef.current !== filtersKey) {
      prevFiltersKeyRef.current = filtersKey;
      if (page !== 1) {
        setPage(1);
        return; // 页码重置后由下一次 effect 运行（page=1）触发获取
      }
    }
    fetchResources();
  }, [fetchResources, filtersKey, page, urlParamsApplied]);

  // 位置记忆的键：规范化后的筛选签名 + 每页条数（页码单独存，不参与键）。
  // 不能直接用 searchParams：同一组条件可能写作 ?resourceType=image，也可能写作
  // ?resourceType=image&scope=all；首帧 URL 尚未规范化时键不一致，会让一次性的
  // 恢复机会被白白用掉，页码与滚动位置都恢复不了。
  const viewMemoryKey = `${filtersKey}|${pageSize}`;
  // 渲染期同步到 ref：滚动/页码回调读最新键，避免键变化重建 effect 导致误写
  const viewMemoryKeyRef = useRef(viewMemoryKey);
  viewMemoryKeyRef.current = viewMemoryKey;

  // 滚动时记录位置（按帧节流 + 最小写入间隔）；离开页面时兜底保存
  useEffect(() => {
    let frame = 0;
    let lastWrite = 0;
    const now = () => window.performance?.now() ?? Date.now();
    const save = () => {
      writeViewMemory({
        query: viewMemoryKeyRef.current,
        page,
        scrollY: window.scrollY,
      });
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (now() - lastWrite < 150) return;
        lastWrite = now();
        save();
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
      save();
    };
  }, [page]);

  // 页码变化（非首屏）时记下当前页：避免“翻页后立刻点开详情”被记成上一页。
  // 首屏不写，否则会覆盖掉待恢复的位置。
  const savedPageRef = useRef<number | null>(null);
  useEffect(() => {
    if (savedPageRef.current === null || savedPageRef.current === page) {
      savedPageRef.current = page;
      return;
    }
    savedPageRef.current = page;
    // 正在等待位置恢复时不要用当前（顶部）位置覆盖记忆，否则慢网下会把原位置冲掉
    if (restoreRef.current.pending) return;
    writeViewMemory({ query: viewMemoryKeyRef.current, page, scrollY: window.scrollY });
  }, [page]);

  // 首次进入：同一筛选条件下恢复上次的页码与滚动位置（只在挂载后执行一次）
  const restoreTriedRef = useRef(false);
  useEffect(() => {
    if (!urlParamsApplied || restoreTriedRef.current) return;
    restoreTriedRef.current = true;
    const memory = readViewMemory();
    if (!memory || memory.query !== viewMemoryKey) return;
    restoreRef.current = {
      pending: true,
      page: memory.page,
      scrollY: memory.scrollY,
      key: memory.query,
    };
    if (memory.page !== page) setPage(memory.page);
  }, [urlParamsApplied, viewMemoryKey, page]);

  // 翻页或切换筛选后滚到列表顶部，而不是被加载态带回整页顶部
  const prevListKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${filtersKey}|${page}`;
    if (prevListKeyRef.current === null) {
      prevListKeyRef.current = key;
      return;
    }
    if (prevListKeyRef.current === key) return;
    prevListKeyRef.current = key;
    // 注意：这里不因“位置恢复待执行”而跳过——恢复要在数据回来后才能滚动，
    // 若在此return，一旦恢复目标失效（如随后切换筛选），pending 会永久为真并吞掉后续所有滚动定位。
    // 平滑滚动即便先发生，也会被后面的恢复 scrollTo 立即打断，最终落点仍然是恢复位置。
    const anchor = listAnchorRef.current;
    if (!anchor) return;
    window.scrollTo({
      top: anchor.getBoundingClientRect().top + window.scrollY - 72,
      behavior: 'smooth',
    });
  }, [filtersKey, page]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const paginationItems = useMemo<PaginationItem[]>(() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);

    const items: PaginationItem[] = [1];
    const start = Math.max(2, page - 1);
    const end = Math.min(totalPages - 1, page + 1);
    if (start > 2) items.push('start-ellipsis');
    for (let value = start; value <= end; value++) items.push(value);
    if (end < totalPages - 1) items.push('end-ellipsis');
    items.push(totalPages);
    return items;
  }, [page, totalPages]);

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  const goToPage = useCallback(
    (value: number) => {
      setPage(Math.min(Math.max(1, value), totalPages));
    },
    [totalPages],
  );

  const handlePageJump = useCallback(() => {
    const target = Number(pageInput);
    if (Number.isInteger(target)) {
      goToPage(target);
    } else {
      setPageInput(String(page));
    }
  }, [goToPage, page, pageInput]);

  const handlePageSizeChange = useCallback((value: string) => {
    const nextPageSize = Number(value);
    if (!PAGE_SIZE_OPTIONS.includes(nextPageSize as (typeof PAGE_SIZE_OPTIONS)[number])) return;

    setPageSize(nextPageSize);
    setPage(1);
    window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(nextPageSize));
  }, []);

  // 删除/移动/批量操作后 total 可能减少：若当前页码超出末页（例如删掉末页唯一资源后 total 掉到上一页），
  // 回退到末页，否则会停留在空页且分页栏（totalPages > 1）消失，用户无法返回。
  useEffect(() => {
    if (!urlParamsApplied) return;
    // total 为 0 时说明数据还没回来（例如恢复页码后首次请求在途），此时不能按末页夹取，
    // 否则会把刚恢复的页码打回第 1 页
    if (page > 1 && total > 0 && page > totalPages) {
      setPage(Math.max(1, totalPages));
    }
  }, [page, totalPages, total, urlParamsApplied]);
  const flatCategories = useMemo(() => flattenCategories(categories), [categories]);
  const currentCategory = useMemo(
    () => (categoryId ? findCategory(categories, categoryId) : null),
    [categories, categoryId],
  );
  const currentCategoryPath = useMemo(
    () => (categoryId ? getCategoryPath(categories, categoryId) : []),
    [categories, categoryId],
  );
  const visibleFolders = currentCategory?.children ?? categories;
  const hasActiveFilters = !!(
    filterState.keyword ||
    filterState.resourceType ||
    filterState.categoryId ||
    filterState.acquisitionMode ||
    filterState.favoriteOnly ||
    filterState.author ||
    filterState.dateFrom ||
    filterState.dateTo ||
    filterState.minSizeMb ||
    filterState.maxSizeMb
  );
  // “更多筛选”面板里的条件条目数（日期/大小各算一条，便于收起时提示还有几项生效）
  const advancedFilterCount =
    (filterState.author ? 1 : 0) +
    (filterState.dateFrom || filterState.dateTo ? 1 : 0) +
    (filterState.minSizeMb || filterState.maxSizeMb ? 1 : 0);
  // “只看收藏”且没有其他条件：空列表说明还没收藏过，提示引导收藏而不是让用户改搜索词
  const favoriteOnlyView =
    filterState.favoriteOnly &&
    filterState.categoryScope === 'all' &&
    !filterState.keyword &&
    !filterState.resourceType &&
    !filterState.categoryId &&
    !filterState.acquisitionMode &&
    advancedFilterCount === 0;

  // 详情页相邻导航的筛选/排序上下文：与下方 URL-sync 共用同一套序列化规则，
  // 使详情页 URL 查询串与当前视图（关键字/类型/分类/来源/更多筛选/排序）一致，
  // 左右箭头在相同视图内切换。默认根目录视图（scope 隐含）不产生任何参数，
  // 详情页按同样规则回退为根目录。
  const contextQuery = useMemo(() => {
    const params = new URLSearchParams();
    writeFilterParams(params, filterState);
    return params.toString();
  }, [filterState]);

  // 删除操作
  /** 删除后的「撤销」：批量恢复并静默刷新，列表不重建，滚动位置不变 */
  const handleUndoDelete = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      try {
        await Promise.all(ids.map((id) => restoreResource(id)));
        toast.success(ids.length > 1 ? `已恢复 ${ids.length} 个资源` : '已恢复资源');
        await fetchResources({ silent: true });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '撤销失败，请到回收站手动恢复');
      }
    },
    [fetchResources],
  );

  // 单条删除：不再二次确认，直接删除并给出可撤销的提示
  const deletingIdsRef = useRef<Set<string>>(new Set());
  const handleSingleDelete = useCallback(
    async (id: string) => {
      // 防抖：连点同一个垃圾桶时不重复发请求
      if (deletingIdsRef.current.has(id)) return;
      deletingIdsRef.current.add(id);
      try {
        await softDeleteResource(id);
        toast.success('已移到回收站', {
          action: { label: '撤销', onClick: () => void handleUndoDelete([id]) },
        });
        setSelectedIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        // 先本地移除再静默刷新：列表不卸载，滚动位置保持
        setResources((prev) => prev.filter((item) => item.id !== id));
        setTotal((prev) => Math.max(0, prev - 1));
        // 当前页只剩这一条且不在第一页时回退一页，避免停在空列表
        if (page > 1 && resources.length === 1) setPage(page - 1);
        await fetchResources({ silent: true });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '删除失败');
      } finally {
        deletingIdsRef.current.delete(id);
      }
    },
    [fetchResources, handleUndoDelete, page, resources.length],
  );

  const handleBatchDelete = useCallback(() => {
    if (selectedIds.size === 0) return;
    setBatchDeleteOpen(true);
  }, [selectedIds.size]);

  const navigateToResource = useCallback(
    (id: string) => {
      router.push(`/resources/${id}${contextQuery ? `?${contextQuery}` : ''}`);
    },
    [router, contextQuery],
  );

  const resourceKeyExtractor = useCallback((r: ResourceListItem) => r.id, []);

  /** 切换单个资源的选中状态 */
  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** 进入/退出批量编辑模式；退出时清空选择，避免残留意外选中 */
  const handleSelectionModeChange = useCallback((next: boolean) => {
    setSelectionMode(next);
    if (!next) setSelectedIds(new Set());
  }, []);

  // 用户可以先勾选复选框再开始批量操作。只要已有选择，也应使用与批量编辑相同的
  // 卡片交互，避免点击图片跳转详情或触发浏览器原生图片拖拽。
  const isSelectionActive = selectionMode || selectedIds.size > 0;

  // 当前页已选资源：用于判断“下载到本地”是否有意义。
  // 选择可能来自“全选当前目录”而跨页；不在当前页的 ID 无法判断类型，此时保守显示。
  const selectedResourcesOnPage = useMemo(
    () => resources.filter((resource) => selectedIds.has(resource.id)),
    [resources, selectedIds],
  );
  const showBatchMirror =
    selectedIds.size === 0 ||
    selectedResourcesOnPage.some((resource) => resource.acquisitionMode !== 'local_upload') ||
    selectedIds.size > selectedResourcesOnPage.length;

  const handleRowClick = useCallback(
    (resource: ResourceListItem) => {
      // 批量编辑模式下点击行是选中/取消选中，而不是打开详情
      if (isSelectionActive) {
        toggleSelection(resource.id);
        return;
      }
      navigateToResource(resource.id);
    },
    [isSelectionActive, navigateToResource, toggleSelection],
  );

  const handleSortChange = useCallback((value: string) => {
    const [field, order] = value.split(':');
    setSortBy(field);
    setSortOrder(order);
  }, []);

  const handleResourceTypeChange = useCallback((value: string) => {
    setResourceType(value === ALL_RESOURCE_TYPES_VALUE ? '' : (value as ResourceType));
  }, []);

  const handleCategoryChange = useCallback((value: string) => {
    // 用户显式选了分类：以当前选择为准，退出收藏视图时不要再还原到进入前的文件夹。
    favoriteReturnRef.current = null;
    if (value === ALL_CATEGORIES_VALUE) {
      setCategoryId('');
      setCategoryScope('all');
      return;
    }
    if (value === UNCATEGORIZED_CATEGORY_VALUE) {
      setCategoryId('');
      setCategoryScope('root');
      return;
    }
    setCategoryId(value);
    setCategoryScope('root');
  }, []);

  const toggleFavoriteOnly = useCallback(() => {
    if (favoriteOnly) {
      setFavoriteOnly(false);
      // 退出收藏视图时还原进入前的文件夹；期间用户若自己换过文件夹（categoryId 不再为空），
      // 或主动选了根目录，就以当前选择为准，不覆盖。
      const saved = favoriteReturnRef.current;
      favoriteReturnRef.current = null;
      if (saved && !categoryId && categoryScope === 'all') {
        setCategoryId(saved.categoryId);
        setCategoryScope(saved.categoryScope);
      }
      return;
    }
    // 收藏是跨文件夹的视角：开启时必须连 categoryId 一起清掉。
    // 只切 scope=all 不够——buildFilterParams 在 categoryId 非空时优先发 categoryId，
    // 请求会同时带 categoryId 与 isFavorite=true，只能看到当前文件夹里的收藏。
    favoriteReturnRef.current = { categoryId, categoryScope };
    setFavoriteOnly(true);
    setCategoryId('');
    setCategoryScope('all');
  }, [favoriteOnly, categoryId, categoryScope]);

  const clearAdvancedFilters = useCallback(() => {
    setAuthor('');
    setDebouncedAuthor('');
    setDateFrom('');
    setDateTo('');
    setMinSizeMb('');
    setMaxSizeMb('');
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const toggleSelectCurrentPage = useCallback(() => {
    if (resources.length === 0) return;

    setSelectedIds((current) => {
      const allSelected = resources.every((resource) => current.has(resource.id));
      const next = new Set(current);
      resources.forEach((resource) => {
        if (allSelected) next.delete(resource.id);
        else next.add(resource.id);
      });
      return next;
    });
  }, [resources]);

  const selectAllCurrentDirectory = useCallback(async () => {
    if (selectingAllDirectory) return;

    const requestId = ++selectAllRequestIdRef.current;
    const requestContextKey = selectionContextKey;
    setSelectingAllDirectory(true);
    try {
      // 服务端用同一套筛选条件一次返回全部 ID：以前要按 pageSize 上限逐页拉，
      // 几千个资源时得发几十次请求、按钮一直转圈。
      const { ids } = await listResourceIds(buildFilterParams(filterState));

      // 视图在请求期间变过就丢弃结果，避免把旧目录的选择集套到新视图上。
      if (
        requestId !== selectAllRequestIdRef.current ||
        requestContextKey !== selectionContextKeyRef.current
      ) {
        return;
      }

      const currentSelectedIds = selectedIdsRef.current;
      const allSelected = ids.length > 0 && ids.every((id) => currentSelectedIds.has(id));
      setSelectedIds(allSelected ? new Set() : new Set(ids));
    } catch (e) {
      if (
        requestId !== selectAllRequestIdRef.current ||
        requestContextKey !== selectionContextKeyRef.current
      ) {
        return;
      }
      toast.error(e instanceof Error ? e.message : '全选当前目录失败');
    } finally {
      setSelectingAllDirectory(false);
    }
  }, [selectingAllDirectory, filterState, selectionContextKey]);

  const openMoveResources = useCallback(() => {
    // 默认目标要安全，避免误点“移动”把所选资源移出原分类：
    // - 所选资源都来自当前页、分类一致、且该分类仍存在时，预设为该分类
    //   （最常见情形：等于当前浏览的文件夹；分类为“无”则预设为“不放入文件夹”）；
    // - 否则若正在浏览某个文件夹（categoryId 非空），预设为当前文件夹——该视图下展示的资源都归属它，跨页选中也安全；
    // - 否则（典型为“全部资源”视图下选中分属不同文件夹的资源）不预设目标，强制用户先明确选择。
    const selectedResources = resources.filter((r) => selectedIds.has(r.id));
    const allSelectedOnPage =
      selectedResources.length > 0 && selectedResources.length === selectedIds.size;
    const categoriesUniform =
      allSelectedOnPage &&
      selectedResources.every((r) => r.categoryId === selectedResources[0].categoryId);

    let defaultTarget: string;
    if (categoriesUniform) {
      const selectionCategoryId = selectedResources[0].categoryId;
      // 仅当该分类仍存在时才预设，避免资源数据滞后时指向已删除的文件夹
      const categoryStillExists =
        selectionCategoryId === null || flatCategories.some((c) => c.id === selectionCategoryId);
      defaultTarget = categoryStillExists ? (selectionCategoryId ?? NO_FOLDER_VALUE) : categoryId;
    } else {
      defaultTarget = categoryId;
    }

    setMoveTargetCategoryId(defaultTarget || '');
    setMoveDialogOpen(true);
  }, [resources, selectedIds, categoryId, flatCategories]);

  const openCreateFolder = useCallback(
    (parentId?: string | null) => {
      const parent = parentId === undefined ? (currentCategory?.id ?? null) : parentId;
      setEditingFolder(null);
      setFolderName('');
      setFolderParentId(parent);
      setFolderDialogOpen(true);
    },
    [currentCategory],
  );

  const openEditFolder = useCallback((folder: CategoryTreeNode) => {
    setEditingFolder(folder);
    setFolderName(folder.name);
    setFolderParentId(folder.parentId);
    setFolderDialogOpen(true);
  }, []);

  const reloadCategories = useCallback(async () => {
    const data = await listCategories();
    setCategories(data.items);
    return data.items;
  }, []);

  const moveResourcesToCategory = async (
    ids: string[],
    targetCategoryId: string,
  ): Promise<boolean> => {
    let result: {
      resourceIds: string[];
      categoryId: string | null;
      updated: number;
      failed: number;
    };
    try {
      result = await batchSetResourceCategory(ids, targetCategoryId || null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '移动失败');
      return false;
    }

    if (result.updated > 0 && result.failed === 0) {
      toast.success(`已移动 ${result.updated} 个资源`);
    } else if (result.updated > 0) {
      toast.success(`已移动 ${result.updated} 个资源，${result.failed} 个失败`);
    } else {
      // 全部失败：保留选中状态并让对话框保持打开，便于用户重试
      toast.error(`移动失败，${result.failed} 个资源未能移动`);
      return false;
    }

    setSelectedIds(new Set());
    // 移动已成功，刷新列表/文件夹树属于尽力而为的后置刷新；刷新失败不应让移动看起来失败
    await reloadCategories().catch(() => {});
    // 静默刷新：移动后列表就地更新，不打断当前滚动位置
    await fetchResources({ silent: true }).catch(() => {});
    return true;
  };

  const handleSaveFolder = async () => {
    const name = folderName.trim();
    if (!name) return;

    try {
      if (editingFolder) {
        await updateCategory(editingFolder.id, {
          name,
          parentId: folderParentId,
        });
        toast.success('文件夹已更新');
      } else {
        const created = await createCategory({
          name,
          parentId: folderParentId ?? undefined,
        });
        setCategoryId(created.id);
        setCategoryScope('root');
        toast.success('文件夹已创建');
      }
      setFolderDialogOpen(false);
      setEditingFolder(null);
      setFolderName('');
      setFolderParentId(null);
      await reloadCategories();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存文件夹失败');
    }
  };

  const handleDeleteFolder = async () => {
    if (!folderDeleteTarget) return;

    try {
      await deleteCategory(folderDeleteTarget.id);
      toast.success(`已删除文件夹 "${folderDeleteTarget.name}"`);
      if (
        categoryId === folderDeleteTarget.id ||
        getCategoryPath([folderDeleteTarget], categoryId).length > 0
      ) {
        setCategoryId(folderDeleteTarget.parentId ?? '');
        setCategoryScope('root');
      }
      setFolderDeleteTarget(null);
      await reloadCategories();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除文件夹失败');
    }
  };

  const handleMoveResources = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    // 未选择目标时不允许移动，防止误操作清空所选资源的分类
    if (!moveTargetCategoryId) return;

    const targetCategoryId = moveTargetCategoryId === NO_FOLDER_VALUE ? '' : moveTargetCategoryId;
    const moved = await moveResourcesToCategory(ids, targetCategoryId);
    if (moved) setMoveDialogOpen(false);
  };

  const handleBatchFavorite = async (isFavorite: boolean) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    try {
      const result = await batchSetResourceFavorite(ids, isFavorite);
      if (result.failed > 0) {
        toast.success(
          `${isFavorite ? '已收藏' : '已取消收藏'} ${result.updated} 个资源，${result.failed} 个失败`,
        );
      } else {
        toast.success(`${isFavorite ? '已收藏' : '已取消收藏'} ${result.updated} 个资源`);
      }
      setSelectedIds(new Set());
      await fetchResources({ silent: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '批量收藏操作失败');
    }
  };

  const handleBatchDownload = async () => {
    const ids = Array.from(selectedIds);
    // 同一时间只跑一次：重复点击会弹第二个保存对话框，两个流抢同一批资源
    if (ids.length === 0 || zipAbortRef.current) return;

    const controller = new AbortController();
    zipAbortRef.current = controller;
    // 只有流式写盘才有进度可看；原生下载一提交就交给浏览器，不显示进度
    if (canStreamZipToDisk()) setZipDownloading({ loadedBytes: 0, totalResources: ids.length });

    let lastProgressAt = 0;
    try {
      const result = await downloadResourcesZip(ids, {
        filename: `resources-${new Date().toISOString().slice(0, 10)}.zip`,
        signal: controller.signal,
        // 分片很小且很多，节流到 200ms 一次，避免每块都触发整页重渲染
        onProgress: ({ loadedBytes }) => {
          const now = Date.now();
          if (now - lastProgressAt < 200) return;
          lastProgressAt = now;
          setZipDownloading((prev) => (prev ? { ...prev, loadedBytes } : prev));
        },
      });

      if (result.mode === 'cancelled') {
        toast.info('已取消下载');
        return;
      }
      if (result.mode === 'browser') {
        // 原生下载读不到响应头，数量未知；进度与取消在浏览器的下载列表里
        toast.success(`已开始打包 ${ids.length} 个资源`, {
          description: '进度与取消请见浏览器下载列表；若始终没有开始，说明所选资源都没有本地原文件',
        });
        return;
      }

      if (result.missingResources === null) {
        // 响应头被代理剥离时数量未知；压缩包里的跳过清单仍然可信
        toast.success('打包完成', {
          description:
            '未能从响应头读取跳过数量；若需确认被跳过的资源，请查看压缩包内 _skipped-resources.txt（若有）',
        });
      } else if (result.missingResources > 0) {
        toast.warning(
          `已打包 ${result.foundResources} 个资源，${result.missingResources} 个已跳过`,
          {
            description:
              '链接资源、仅元数据资源没有本地原文件，需先下载到本地；跳过清单见压缩包内 _skipped-resources.txt',
          },
        );
      } else {
        toast.success(`已下载 ${result.foundResources} 个资源`);
      }
    } catch (e) {
      if (controller.signal.aborted) {
        toast.info('已取消下载');
        return;
      }
      toast.error(e instanceof Error ? e.message : '批量下载失败');
    } finally {
      zipAbortRef.current = null;
      setZipDownloading(null);
    }
  };

  const handleCancelZipDownload = () => {
    zipAbortRef.current?.abort();
  };

  /**
   * 批量下载到本地：为选中的远程资源逐个创建 download_file 任务。
   * 大选择集按分片提交，避免单个请求长时间占用连接；分片失败时保留已入队数量。
   */
  const handleBatchMirror = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0 || batchMirroring) return;

    const chunks = chunkIds(ids, BATCH_MIRROR_CHUNK_SIZE);
    setBatchMirroring({ completed: 0, total: chunks.length });

    let queued = 0;
    let skipped = 0;
    const skippedResources: Array<{
      id: string;
      reason: BatchMirrorSkipReason;
      message: string;
    }> = [];

    try {
      for (let i = 0; i < chunks.length; i += 1) {
        const result = await batchMirrorResources(chunks[i]);
        queued += result.queued;
        skipped += result.skipped;
        skippedResources.push(...result.skippedResources);
        setBatchMirroring({ completed: i + 1, total: chunks.length });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : '提交本地下载任务失败';
      // 分批提交时前面的批次可能已经入队：明确告知已成功的数量，避免用户误以为全部失败
      toast.error(
        queued > 0 ? `已加入下载队列 ${queued} 个资源，后续批次提交失败` : '提交本地下载任务失败',
        {
          description: `${
            skipped > 0 ? `${message}；已跳过 ${skipped} 个资源` : message
          }；任务状态可在任务页查看`,
        },
      );
      // 已成功的批次仍要反映到列表上（用最新视图，避免覆盖用户已切换的页码/筛选）
      await fetchResourcesRef.current({ silent: true });
      return;
    } finally {
      setBatchMirroring(null);
    }

    const skipSummary = describeBatchMirrorSkips(skippedResources);
    if (queued === 0) {
      toast.warning('没有资源加入下载队列', {
        description: skipSummary || undefined,
      });
    } else if (skipped > 0) {
      toast.success(`已加入下载队列 ${queued} 个资源，${skipped} 个被跳过`, {
        description: skipSummary,
      });
    } else {
      toast.success(`已加入下载队列 ${queued} 个资源`);
    }
    // 下载任务异步执行：刷新列表，让已经完成/失败的状态尽快反映出来
    await fetchResourcesRef.current({ silent: true });
  };

  const readDragPayload = (event: React.DragEvent): DragPayload | null => {
    const raw = event.dataTransfer.getData(DRAG_DATA_TYPE);
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as DragPayload;
      if (parsed.type === 'resources' && Array.isArray(parsed.ids)) return parsed;
      if (parsed.type === 'folder' && typeof parsed.id === 'string') return parsed;
    } catch {
      return null;
    }

    return null;
  };

  const handleResourceDragStart = useCallback(
    (resource: ResourceListItem, event: React.DragEvent) => {
      const ids = selectedIds.has(resource.id) ? Array.from(selectedIds) : [resource.id];
      const payload: DragPayload = { type: 'resources', ids };
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(DRAG_DATA_TYPE, JSON.stringify(payload));
      event.dataTransfer.setData(
        'text/plain',
        ids.length === 1 ? resource.title || resource.originalFilename : `${ids.length} 个资源`,
      );
    },
    [selectedIds],
  );

  const handleFolderDragStart = (folder: CategoryTreeNode, event: React.DragEvent) => {
    const payload: DragPayload = { type: 'folder', id: folder.id };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(DRAG_DATA_TYPE, JSON.stringify(payload));
    event.dataTransfer.setData('text/plain', folder.name);
  };

  const handleDropOnFolder = async (folder: CategoryTreeNode, event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOverFolderId(null);

    const payload = readDragPayload(event);
    if (!payload) return;

    if (payload.type === 'resources') {
      await moveResourcesToCategory(payload.ids, folder.id);
      return;
    }

    const draggedFolder = findCategory(categories, payload.id);
    if (!draggedFolder) return;
    if (draggedFolder.id === folder.id || containsCategory(draggedFolder.children, folder.id)) {
      toast.error('不能将文件夹移动到自己或子文件夹中');
      return;
    }

    try {
      await updateCategory(draggedFolder.id, { parentId: folder.id });
      toast.success(`已移动文件夹 "${draggedFolder.name}"`);
      await reloadCategories();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '移动文件夹失败');
    }
  };

  const isUnavailableFolderParent = (category: CategoryTreeNode) => {
    if (!editingFolder) return false;
    return (
      category.id === editingFolder.id || containsCategory(editingFolder.children, category.id)
    );
  };

  const confirmDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) {
      setBatchDeleteOpen(false);
      return;
    }
    try {
      const result = await batchDeleteResources(ids);
      if (result.deleted > 0 && result.failed === 0) {
        toast.success(`已将 ${result.deleted} 个资源移到回收站`, {
          action: { label: '撤销', onClick: () => void handleUndoDelete(ids) },
        });
      } else if (result.deleted > 0 && result.failed > 0) {
        // 部分失败时无法确定具体是哪几条，交给下面的静默刷新对齐
        toast.success(`已将 ${result.deleted} 个资源移到回收站，${result.failed} 个失败`);
      } else {
        toast.error(`删除失败，${result.failed} 个资源未能删除`);
      }
      setSelectedIds(new Set());

      // 全部成功时先本地移除，列表不卸载 → 滚动位置保持
      if (result.deleted > 0 && result.failed === 0) {
        const removed = new Set(ids);
        setResources((prev) => prev.filter((item) => !removed.has(item.id)));
        setTotal((prev) => Math.max(0, prev - removed.size));
        if (page > 1 && resources.every((item) => removed.has(item.id))) {
          setPage(page - 1);
        }
      }
      await fetchResources({ silent: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    } finally {
      setBatchDeleteOpen(false);
    }
  };

  const columns: Column<ResourceListItem>[] = useMemo(
    () => [
      {
        key: 'title',
        header: '资源名称',
        render: (r) => (
          <div className="flex items-center gap-2">
            {r.acquisitionMode === 'link_only' ? (
              <ExternalLink className="h-5 w-5 text-primary" />
            ) : r.acquisitionMode === 'metadata_only' ? (
              <Globe className="h-5 w-5 text-blue-500" />
            ) : (
              <ResourcePreview resource={r} variant="compact" className="h-9 w-12" />
            )}
            {/* 点击行为统一交给行级 onRowClick，避免 columns 依赖 isSelectionActive 而整表重建 */}
            <span className="font-medium">{r.title || r.originalFilename}</span>
          </div>
        ),
      },
      {
        key: 'isFavorite',
        header: '收藏',
        className: 'w-14 text-center',
        render: (r) =>
          r.isFavorite ? (
            <Heart className="mx-auto h-4 w-4 fill-rose-500 text-rose-500" aria-label="已收藏" />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        key: 'resourceType',
        header: '类型',
        className: 'w-24',
        render: (r) => <ResourceTypeBadge type={r.resourceType} />,
      },
      {
        key: 'sizeBytes',
        header: '大小',
        className: 'w-24 text-right',
        render: (r) => (
          <span
            className={r.downloadError ? 'text-destructive' : 'text-muted-foreground'}
            title={
              r.downloadError ??
              (r.acquisitionMode === 'metadata_only' ? '尚未下载到本地' : undefined)
            }
          >
            {r.acquisitionMode === 'link_only'
              ? '链接'
              : r.acquisitionMode === 'metadata_only'
                ? r.downloadError
                  ? '下载失败'
                  : '待下载'
                : formatByteString(r.sizeBytes)}
          </span>
        ),
      },
      {
        key: 'createdAt',
        header: '上传日期',
        className: 'w-28',
        render: (r) => <span className="text-muted-foreground">{formatDate(r.createdAt)}</span>,
      },
    ],
    [],
  );

  const rowActions = useCallback(
    (r: ResourceListItem) => (
      <div className="flex items-center justify-end gap-1">
        {isDesignMediaType(r) && !r.deletedAt && (
          <Link
            href={designMediaHref(r.id)}
            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
            title="用于设计"
            aria-label="用于设计"
          >
            <Wand2 className="h-4 w-4" />
          </Link>
        )}
        <button
          onClick={() => handleSingleDelete(r.id)}
          className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          title="删除"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    ),
    [handleSingleDelete],
  );

  return (
    <div>
      <PageHeader title="资源库" description="按文件夹、类型和来源浏览资源">
        <Button size="sm" className="gap-1" onClick={() => openCreateFolder(null)}>
          <FolderPlus className="h-4 w-4" />
          新建文件夹
        </Button>
      </PageHeader>

      {/* 搜索筛选栏 */}
      <div className="mb-4 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={keyword}
            onChange={setKeyword}
            placeholder="搜索资源名称、描述、内容..."
            className="w-64"
          />

          <Select
            value={resourceType || ALL_RESOURCE_TYPES_VALUE}
            onValueChange={handleResourceTypeChange}
          >
            <SelectTrigger className="w-28">
              <SelectValue placeholder="类型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_RESOURCE_TYPES_VALUE}>全部类型</SelectItem>
              {(Object.keys(RESOURCE_TYPE_LABELS) as ResourceType[]).map((t) => (
                <SelectItem key={t} value={t}>
                  {RESOURCE_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={
              categoryId ||
              (categoryScope === 'root' ? UNCATEGORIZED_CATEGORY_VALUE : ALL_CATEGORIES_VALUE)
            }
            onValueChange={handleCategoryChange}
          >
            <SelectTrigger className="w-32">
              <Folder className="mr-1 h-3 w-3" />
              <SelectValue placeholder="文件夹" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CATEGORIES_VALUE}>全部资源</SelectItem>
              <SelectItem value={UNCATEGORIZED_CATEGORY_VALUE}>根目录</SelectItem>
              {flatCategories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.parentId ? `- ${c.name}` : c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={acquisitionMode || ALL_ACQUISITION_MODES_VALUE}
            onValueChange={(value) =>
              setAcquisitionMode(value === ALL_ACQUISITION_MODES_VALUE ? '' : value)
            }
          >
            <SelectTrigger className="w-28">
              <SelectValue placeholder="来源" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_ACQUISITION_MODES_VALUE}>全部来源</SelectItem>
              <SelectItem value="local_upload">本地上传</SelectItem>
              <SelectItem value="link_only">链接导入</SelectItem>
              <SelectItem value="metadata_only">仅元数据</SelectItem>
            </SelectContent>
          </Select>

          <Button
            variant={favoriteOnly ? 'secondary' : 'outline'}
            size="sm"
            className="gap-1"
            aria-pressed={favoriteOnly}
            title={favoriteOnly ? '退出收藏视图' : '跨文件夹显示所有已收藏的资源'}
            onClick={toggleFavoriteOnly}
          >
            <Heart className={cn('h-4 w-4', favoriteOnly && 'fill-rose-500 text-rose-500')} />
            只看收藏
          </Button>

          <Select value={`${sortBy}:${sortOrder}`} onValueChange={handleSortChange}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="排序" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="createdAt:desc">最新优先</SelectItem>
              <SelectItem value="createdAt:asc">最早优先</SelectItem>
              <SelectItem value="title:asc">名称 A-Z</SelectItem>
              <SelectItem value="title:desc">名称 Z-A</SelectItem>
              <SelectItem value="sizeBytes:desc">最大优先</SelectItem>
              <SelectItem value="sizeBytes:asc">最小优先</SelectItem>
            </SelectContent>
          </Select>

          <Button
            variant={filtersOpen || advancedFilterCount > 0 ? 'secondary' : 'outline'}
            size="sm"
            className="gap-1"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <SlidersHorizontal className="h-4 w-4" />
            更多筛选
            {advancedFilterCount > 0 && (
              <Badge variant="outline" className="px-1 py-0 text-[10px] leading-4">
                {advancedFilterCount}
              </Badge>
            )}
          </Button>

          <div className="ml-auto flex items-center gap-1">
            <Button
              variant={isSelectionActive ? 'default' : 'outline'}
              size="sm"
              className="gap-1"
              onClick={() => handleSelectionModeChange(!isSelectionActive)}
              disabled={selectingAllDirectory}
            >
              <SquareCheck className="h-4 w-4" />
              {isSelectionActive ? '退出批量编辑' : '批量编辑'}
            </Button>
            <ResourceViewToggle />
          </div>
        </div>

        {/* 更多筛选：默认收起，避免筛选栏过挤；这里对应后端已有的作者/日期/大小筛选能力 */}
        {filtersOpen && (
          <div className="flex flex-wrap items-end gap-x-5 gap-y-3 rounded-lg border bg-muted/30 px-3 py-2.5">
            <div className="space-y-1">
              <Label htmlFor="resource-filter-author" className="text-xs text-muted-foreground">
                作者
              </Label>
              <Input
                id="resource-filter-author"
                value={author}
                onChange={(event) => setAuthor(event.target.value)}
                placeholder="按作者筛选"
                className="h-8 w-40"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">时间范围</Label>
              <div className="flex items-center gap-1.5">
                <Select
                  value={dateField}
                  onValueChange={(value) => setDateField(value as DateField)}
                >
                  <SelectTrigger className="h-8 w-32" aria-label="时间字段">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="createdAt">创建时间</SelectItem>
                    <SelectItem value="updatedAt">更新时间</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="date"
                  aria-label="起始日期"
                  value={dateFrom}
                  max={dateTo || undefined}
                  onChange={(event) => setDateFrom(event.target.value)}
                  className="h-8 w-40"
                />
                <span className="text-xs text-muted-foreground">至</span>
                <Input
                  type="date"
                  aria-label="结束日期"
                  value={dateTo}
                  min={dateFrom || undefined}
                  onChange={(event) => setDateTo(event.target.value)}
                  className="h-8 w-40"
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">文件大小（MB）</Label>
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  min={0}
                  step="any"
                  inputMode="decimal"
                  aria-label="最小文件大小（MB）"
                  value={minSizeMb}
                  onChange={(event) => setMinSizeMb(event.target.value)}
                  placeholder="最小"
                  className="h-8 w-24"
                />
                <span className="text-xs text-muted-foreground">至</span>
                <Input
                  type="number"
                  min={0}
                  step="any"
                  inputMode="decimal"
                  aria-label="最大文件大小（MB）"
                  value={maxSizeMb}
                  onChange={(event) => setMaxSizeMb(event.target.value)}
                  placeholder="最大"
                  className="h-8 w-24"
                />
              </div>
            </div>

            {advancedFilterCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1"
                onClick={clearAdvancedFilters}
              >
                <X className="h-3.5 w-3.5" />
                清除条件
              </Button>
            )}
          </div>
        )}
      </div>

      {/* 文件夹导航 */}
      <div className="mb-4 space-y-3">
        <div className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          <button
            className="rounded px-2 py-1 transition-colors hover:bg-accent hover:text-accent-foreground"
            onClick={() => {
              setCategoryId('');
              setCategoryScope('root');
            }}
          >
            根目录
          </button>
          {currentCategory && (
            <>
              {currentCategoryPath.map((category, index) => (
                <span key={category.id} className="flex items-center gap-1">
                  <ChevronRight className="h-4 w-4" />
                  {index === currentCategoryPath.length - 1 ? (
                    <span className="inline-flex items-center gap-1 rounded bg-accent px-2 py-1 font-medium text-accent-foreground">
                      <span>{category.name}</span>
                      <button
                        type="button"
                        className="ml-1 rounded p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                        title="重命名"
                        onClick={() => openEditFolder(category)}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                        title="删除"
                        onClick={() => setFolderDeleteTarget(category)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </span>
                  ) : (
                    <button
                      className="rounded px-2 py-1 transition-colors hover:bg-accent hover:text-accent-foreground"
                      onClick={() => {
                        setCategoryId(category.id);
                        setCategoryScope('root');
                      }}
                    >
                      {category.name}
                    </button>
                  )}
                </span>
              ))}
            </>
          )}
        </div>

        {(visibleFolders.length > 0 || currentCategory) && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {visibleFolders.map((folder) => (
              <div
                key={folder.id}
                draggable
                onDragStart={(event) => handleFolderDragStart(folder, event)}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  setDragOverFolderId(folder.id);
                }}
                onDragLeave={() => {
                  setDragOverFolderId((current) => (current === folder.id ? null : current));
                }}
                onDrop={(event) => {
                  void handleDropOnFolder(folder, event);
                }}
                className={`group relative min-h-20 rounded-lg border bg-card transition-colors hover:border-primary/40 hover:bg-accent ${
                  dragOverFolderId === folder.id
                    ? 'border-primary bg-accent ring-2 ring-primary/30'
                    : ''
                }`}
              >
                <button
                  type="button"
                  className="flex min-h-20 w-full items-center gap-3 p-3 pr-16 text-left"
                  onClick={() => {
                    setCategoryId(folder.id);
                    setCategoryScope('root');
                  }}
                >
                  <FolderOpen className="h-8 w-8 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{folder.name}</div>
                    <div className="mt-1 flex items-center gap-2">
                      <Badge variant="secondary" className="text-xs">
                        {folder.resourceCount}
                      </Badge>
                      <span className="text-xs text-muted-foreground">项资源</span>
                    </div>
                  </div>
                </button>
                <div className="hover-reveal absolute right-2 top-2 flex gap-1">
                  <button
                    type="button"
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                    title="重命名"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openEditFolder(folder);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    title="删除"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setFolderDeleteTarget(folder);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
            {currentCategory && (
              <button
                className="flex min-h-20 items-center gap-3 rounded-lg border border-dashed p-3 text-left text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-accent-foreground"
                onClick={() => openCreateFolder(currentCategory.id)}
              >
                <FolderPlus className="h-8 w-8" />
                <span className="text-sm font-medium">新建子文件夹</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* 批量操作工具栏 */}
      {isSelectionActive && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border bg-primary/5 px-4 py-2">
          {selectionMode && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleSelectionModeChange(false)}
              disabled={selectingAllDirectory}
            >
              <Check className="mr-1 h-3 w-3" />
              完成
            </Button>
          )}
          <span className="text-sm text-muted-foreground">
            已选 <span className="font-medium text-foreground">{selectedIds.size}</span> 项
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={toggleSelectCurrentPage}
            disabled={selectingAllDirectory}
            title="选择或取消选择当前页的资源"
          >
            <Check className="mr-1 h-3 w-3" />
            全选当前页
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={selectAllCurrentDirectory}
            disabled={selectingAllDirectory || total === 0}
            title="选择或取消选择当前目录下的全部资源"
          >
            <FolderOpen className="mr-1 h-3 w-3" />
            {selectingAllDirectory ? '正在全选...' : '全选当前目录'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={clearSelection}
            disabled={selectingAllDirectory || selectedIds.size === 0}
            title="清除所有已选择的资源"
          >
            <X className="mr-1 h-3 w-3" />
            清除选择
          </Button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleBatchDownload}
              disabled={selectedIds.size === 0 || zipDownloading !== null}
              title={zipDownloading ? '正在下载上一个压缩包，可先在右下角取消' : undefined}
            >
              <Download className="mr-1 h-4 w-4" />
              下载
            </Button>
            {showBatchMirror && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleBatchMirror}
                disabled={selectedIds.size === 0 || batchMirroring !== null}
                title="为选中的远程资源创建本地下载任务；没有下载地址或来源策略不允许的资源会被跳过"
              >
                <CloudDownload className="mr-1 h-4 w-4" />
                {batchMirroring
                  ? `正在提交 ${Math.min(batchMirroring.completed + 1, batchMirroring.total)}/${batchMirroring.total}`
                  : '下载到本地'}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={openMoveResources}
              disabled={selectedIds.size === 0}
            >
              <Folder className="mr-1 h-4 w-4" />
              移动到
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleBatchFavorite(true)}
              disabled={selectedIds.size === 0}
            >
              <Heart className="mr-1 h-4 w-4" />
              收藏
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleBatchFavorite(false)}
              disabled={selectedIds.size === 0}
            >
              <HeartOff className="mr-1 h-4 w-4" />
              取消收藏
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleBatchDelete}
              disabled={selectedIds.size === 0}
            >
              <Trash2 className="mr-1 h-4 w-4" />
              批量删除
            </Button>
          </div>
        </div>
      )}

      {/* 列表顶部锚点：翻页/换筛选后滚到这里 */}
      <div ref={listAnchorRef} aria-hidden="true" />

      {/* 首次加载用骨架；之后翻页/筛选保留旧列表，只在顶部给一条细进度条 */}
      {loading ? (
        <ResourceListSkeleton />
      ) : error && resources.length === 0 ? (
        <ErrorState message={error} onRetry={() => void fetchResources()} />
      ) : resources.length === 0 && refreshing ? (
        <ResourceListSkeleton />
      ) : resources.length === 0 ? (
        <EmptyState
          title="暂无资源"
          description={
            hasActiveFilters
              ? favoriteOnlyView
                ? '还没有收藏的资源：在全部资源里勾选后点“收藏”，就能在这里集中查看'
                : '没有匹配的资源，请调整搜索条件'
              : categoryScope === 'root'
                ? '根目录暂无资源，可切换到全部资源查看已放入文件夹的资源'
                : '上传文件以开始管理您的资源库'
          }
        />
      ) : (
        <div className="relative" aria-busy={refreshing}>
          {error && (
            <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              列表刷新失败：{error}
            </div>
          )}
          {/* 进度条绝对定位，避免刷新时把列表整体下推造成抖动 */}
          {refreshing && (
            <div
              className="pointer-events-none absolute -top-2 left-0 right-0 z-10 h-0.5 overflow-hidden rounded bg-primary/10"
              role="progressbar"
              aria-label="正在更新资源列表"
            >
              <div className="h-full w-1/3 animate-pulse rounded bg-primary/70" />
            </div>
          )}
          <ResourceViewPanels
            grid={
              <ResourceGrid
                resources={resources}
                selectedIds={selectedIds}
                onSelectionChange={setSelectedIds}
                onDelete={handleSingleDelete}
                onResourceDragStart={isSelectionActive ? undefined : handleResourceDragStart}
                selectMode={isSelectionActive}
                contextQuery={contextQuery}
              />
            }
            table={
              <DataTable
                columns={columns}
                data={resources}
                keyExtractor={resourceKeyExtractor}
                selectedIds={selectedIds}
                onSelectionChange={setSelectedIds}
                onRowClick={handleRowClick}
                rowActions={rowActions}
              />
            }
          />
        </div>
      )}

      {/* 分页 */}
      {total > 0 && !loading && (
        <div className="mt-4 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>每页</span>
            <Select value={String(pageSize)} onValueChange={handlePageSizeChange}>
              <SelectTrigger className="h-8 w-[76px]" aria-label="每页显示数量">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size} 条
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span>共 {total} 项</span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="outline"
              size="icon"
              title="首页"
              aria-label="首页"
              disabled={page === 1}
              onClick={() => goToPage(1)}
            >
              <ChevronsLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              title="上一页"
              aria-label="上一页"
              disabled={page === 1}
              onClick={() => goToPage(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {paginationItems.map((item) =>
              typeof item === 'number' ? (
                <Button
                  key={item}
                  variant={item === page ? 'default' : 'outline'}
                  size="icon"
                  aria-label={`第 ${item} 页`}
                  aria-current={item === page ? 'page' : undefined}
                  onClick={() => goToPage(item)}
                >
                  {item}
                </Button>
              ) : (
                <span
                  key={item}
                  className="flex h-8 w-5 items-center justify-center text-muted-foreground"
                >
                  ...
                </span>
              ),
            )}
            <Button
              variant="outline"
              size="icon"
              title="下一页"
              aria-label="下一页"
              disabled={page === totalPages}
              onClick={() => goToPage(page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              title="末页"
              aria-label="末页"
              disabled={page === totalPages}
              onClick={() => goToPage(totalPages)}
            >
              <ChevronsRight className="h-4 w-4" />
            </Button>
            <div className="ml-1 flex items-center gap-1 text-sm text-muted-foreground">
              <span>跳至</span>
              <Input
                className="h-8 w-14 px-2 text-center"
                type="number"
                min={1}
                max={totalPages}
                inputMode="numeric"
                aria-label="跳转页码"
                value={pageInput}
                onChange={(event) => setPageInput(event.target.value)}
                onBlur={handlePageJump}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
              <span>/ {totalPages}</span>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认 */}
      <ConfirmDialog
        open={batchDeleteOpen}
        onOpenChange={setBatchDeleteOpen}
        title="批量删除资源"
        description={`确定要将选中的 ${selectedIds.size} 个资源移到回收站吗？你可以从回收站恢复。`}
        variant="destructive"
        confirmLabel="删除"
        onConfirm={confirmDelete}
      />

      <Dialog
        open={folderDialogOpen}
        onOpenChange={(open) => {
          setFolderDialogOpen(open);
          if (!open) {
            setEditingFolder(null);
            setFolderName('');
            setFolderParentId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingFolder ? '编辑文件夹' : '新建文件夹'}</DialogTitle>
            {editingFolder && (
              <DialogDescription>修改名称，或调整上级文件夹来移动此文件夹。</DialogDescription>
            )}
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="folder-name">名称</Label>
              <Input
                id="folder-name"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                placeholder="文件夹名称"
                maxLength={100}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void handleSaveFolder();
                  }
                }}
              />
            </div>
            <div className="space-y-2">
              <Label>上级文件夹</Label>
              <Select
                value={folderParentId ?? ROOT_FOLDER_VALUE}
                onValueChange={(value) =>
                  setFolderParentId(value === ROOT_FOLDER_VALUE ? null : value)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="无（作为根文件夹）" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ROOT_FOLDER_VALUE}>无（作为根文件夹）</SelectItem>
                  {flatCategories.map((category) => (
                    <SelectItem
                      key={category.id}
                      value={category.id}
                      disabled={isUnavailableFolderParent(category)}
                    >
                      {category.parentId ? `- ${category.name}` : category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFolderDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSaveFolder} disabled={!folderName.trim()}>
              {editingFolder ? '保存' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!folderDeleteTarget}
        onOpenChange={(open) => {
          if (!open) setFolderDeleteTarget(null);
        }}
        title="删除文件夹"
        description={`确定要删除文件夹 "${folderDeleteTarget?.name}" 吗？子文件夹将变为根文件夹，关联的资源将移出该文件夹。`}
        variant="destructive"
        confirmLabel="删除"
        onConfirm={handleDeleteFolder}
      />

      <Dialog
        open={moveDialogOpen}
        onOpenChange={(open) => {
          setMoveDialogOpen(open);
          if (!open) {
            setMoveTargetCategoryId('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>移动资源</DialogTitle>
            <DialogDescription>
              将选中的 {selectedIds.size} 个资源移动到指定文件夹。
              {!moveTargetCategoryId && ' 请先选择目标文件夹，以免误将所选资源移出原分类。'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>目标文件夹</Label>
            <Select value={moveTargetCategoryId} onValueChange={setMoveTargetCategoryId}>
              <SelectTrigger>
                <SelectValue placeholder="选择目标文件夹" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_FOLDER_VALUE}>不放入文件夹</SelectItem>
                {flatCategories.map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.parentId ? `- ${category.name}` : category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveDialogOpen(false)}>
              取消
            </Button>
            <Button
              onClick={handleMoveResources}
              disabled={selectedIds.size === 0 || !moveTargetCategoryId}
            >
              移动
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 下载进度：非模态浮层，下载期间页面照常可用；压缩包边生成边写盘，所以只有已写入字节数 */}
      {zipDownloading && (
        <div className="fixed bottom-4 right-4 z-50 w-72 rounded-lg border bg-background/95 p-3 shadow-lg backdrop-blur">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            {/* role=status：卡片出现时播报一次；里面的字节数在变，不能给它加 aria-live 否则会刷屏 */}
            <span role="status" className="text-sm font-medium">
              正在打包下载
            </span>
            <span className="text-xs text-muted-foreground">
              已写入 {formatBytes(zipDownloading.loadedBytes)}
            </span>
          </div>
          {/* 压缩流没有 Content-Length，进度只报已写入字节数，条形保持不定长 */}
          <div
            role="progressbar"
            aria-label="批量下载进度"
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full w-1/3 animate-pulse rounded bg-primary" />
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {zipDownloading.totalResources} 个资源 · 边生成边写入磁盘
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={handleCancelZipDownload}
            >
              取消下载
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
