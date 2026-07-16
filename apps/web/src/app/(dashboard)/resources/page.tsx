'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Archive,
  ChevronRight,
  Download,
  ExternalLink,
  Folder,
  FolderOpen,
  FolderPlus,
  Grid3X3,
  Heart,
  HeartOff,
  List,
  Pencil,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { ResourceGrid } from '@/components/shared/resource-grid';
import { DataTable, type Column } from '@/components/shared/data-table';
import { LoadingState } from '@/components/shared/loading-state';
import { ErrorState } from '@/components/shared/error-state';
import { EmptyState } from '@/components/shared/empty-state';
import { ResourceTypeIcon } from '@/components/shared/resource-type-icon';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDebounce } from '@/hooks/use-debounce';
import {
  batchAddTagsToResources,
  batchDeleteResources,
  batchRemoveTagsFromResources,
  batchSetResourceCategory,
  batchSetResourceFavorite,
  downloadResourcesZip,
  listResources,
  softDeleteResource,
} from '@/lib/api/resources';
import { listTags } from '@/lib/api/tags';
import { createCategory, deleteCategory, listCategories, updateCategory } from '@/lib/api/categories';
import { batchAddToCollection, listCollections } from '@/lib/api/collections';
import { formatBytes, formatDate } from '@/lib/format';
import { RESOURCE_TYPE_LABELS } from '@/lib/constants';
import type { ResourceListItem, TagWithUsage, CategoryTreeNode, CollectionItem } from '@/lib/types';
import type { ResourceType } from '@resource-service/shared-types';

const PAGE_SIZE = 20;
type ViewMode = 'grid' | 'table';
const ALL_RESOURCE_TYPES_VALUE = '__all_resource_types__';
const ALL_CATEGORIES_VALUE = '__all_categories__';
const UNCATEGORIZED_CATEGORY_VALUE = '__uncategorized__';
const ALL_TAGS_VALUE = '__all_tags__';
const ALL_ACQUISITION_MODES_VALUE = '__all_acquisition_modes__';
const ROOT_FOLDER_VALUE = '__root_folder__';
const NO_FOLDER_VALUE = '__no_folder__';
const DRAG_DATA_TYPE = 'application/x-resource-service';

type DragPayload =
  | { type: 'resources'; ids: string[] }
  | { type: 'folder'; id: string };

function isResourceType(value: string | null): value is ResourceType {
  return !!value && value in RESOURCE_TYPE_LABELS;
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
  return categories.some((category) => category.id === id || containsCategory(category.children, id));
}

export default function ResourcesPage() {
  const router = useRouter();

  // 数据
  const [resources, setResources] = useState<ResourceListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  // 搜索/筛选
  const [keyword, setKeyword] = useState('');
  const debouncedKeyword = useDebounce(keyword, 300);
  const [resourceType, setResourceType] = useState<ResourceType | ''>('');
  const [categoryId, setCategoryId] = useState('');
  const [categoryScope, setCategoryScope] = useState<'root' | 'all'>('root');
  const [tagId, setTagId] = useState('');
  const [acquisitionMode, setAcquisitionMode] = useState('');
  const [sortBy, setSortBy] = useState<string>('createdAt');
  const [sortOrder, setSortOrder] = useState<string>('desc');

  // 视图
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [mountedViewModes, setMountedViewModes] = useState<Set<ViewMode>>(() => new Set(['grid']));

  // 多选
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [moveTargetCategoryId, setMoveTargetCategoryId] = useState(NO_FOLDER_VALUE);
  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  const [tagAction, setTagAction] = useState<'add' | 'remove'>('add');
  const [batchTagId, setBatchTagId] = useState('');
  const [collectionDialogOpen, setCollectionDialogOpen] = useState(false);
  const [batchCollectionId, setBatchCollectionId] = useState('');

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<{ type: 'single' | 'batch'; id?: string } | null>(null);

  // 下拉选项
  const [tags, setTags] = useState<TagWithUsage[]>([]);
  const [categories, setCategories] = useState<CategoryTreeNode[]>([]);
  const [collections, setCollections] = useState<CollectionItem[]>([]);

  // 文件夹创建
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [editingFolder, setEditingFolder] = useState<CategoryTreeNode | null>(null);
  const [folderName, setFolderName] = useState('');
  const [folderParentId, setFolderParentId] = useState<string | null>(null);
  const [folderDeleteTarget, setFolderDeleteTarget] = useState<CategoryTreeNode | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);

  const fetchResources = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, unknown> = {
        page,
        pageSize: PAGE_SIZE,
        sortBy,
        sortOrder,
      };
      if (debouncedKeyword) params.keyword = debouncedKeyword;
      if (resourceType) params.resourceType = resourceType;
      if (categoryId) params.categoryId = categoryId;
      else if (categoryScope === 'root') params.uncategorized = true;
      if (tagId) params.tagId = tagId;
      if (acquisitionMode) params.acquisitionMode = acquisitionMode;

      const data = await listResources(params as Parameters<typeof listResources>[0]);
      setResources(data.items);
      setTotal(data.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [page, sortBy, sortOrder, debouncedKeyword, resourceType, categoryId, categoryScope, tagId, acquisitionMode]);

  // 初始加载选项
  useEffect(() => {
    listTags().then((d) => setTags(d.items)).catch(() => {});
    listCategories().then((d) => setCategories(d.items)).catch(() => {});
    listCollections().then((d) => setCollections(d.items)).catch(() => {});
  }, []);

  // 支持从仪表盘概览或分类入口跳转到指定筛选。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const type = params.get('resourceType');
    if (isResourceType(type)) {
      setResourceType(type);
    }
    const initialCategoryId = params.get('categoryId');
    if (initialCategoryId) {
      setCategoryId(initialCategoryId);
      setCategoryScope('root');
    } else if (params.get('scope') === 'all' || isResourceType(type)) {
      setCategoryScope('all');
    }
  }, []);

  // 搜索/筛选变化时：重置页码 + 重新获取（合并为一个 effect 避免竞态）
  useEffect(() => {
    setPage(1);
  }, [debouncedKeyword, resourceType, categoryId, categoryScope, tagId, acquisitionMode, sortBy, sortOrder]);

  useEffect(() => {
    fetchResources();
  }, [fetchResources]);

  const totalPages = Math.ceil(total / PAGE_SIZE);
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
  const hasActiveFilters = !!(debouncedKeyword || resourceType || categoryId || tagId || acquisitionMode);

  // 删除操作
  const handleSingleDelete = useCallback((id: string) => {
    setDeleteTarget({ type: 'single', id });
  }, []);

  const handleBatchDelete = useCallback(() => {
    if (selectedIds.size === 0) return;
    setDeleteTarget({ type: 'batch' });
  }, [selectedIds.size]);

  const handleViewModeChange = useCallback((value: string) => {
    const nextViewMode = value as ViewMode;
    setViewMode(nextViewMode);
    setMountedViewModes((prev) => {
      if (prev.has(nextViewMode)) return prev;
      const next = new Set(prev);
      next.add(nextViewMode);
      return next;
    });
  }, []);

  const navigateToResource = useCallback((id: string) => {
    router.push(`/resources/${id}`);
  }, [router]);

  const resourceKeyExtractor = useCallback((r: ResourceListItem) => r.id, []);

  const handleRowClick = useCallback((resource: ResourceListItem) => {
    navigateToResource(resource.id);
  }, [navigateToResource]);

  const handleSortChange = useCallback((value: string) => {
    const [field, order] = value.split(':');
    setSortBy(field);
    setSortOrder(order);
  }, []);

  const handleResourceTypeChange = useCallback((value: string) => {
    setResourceType(value === ALL_RESOURCE_TYPES_VALUE ? '' : (value as ResourceType));
  }, []);

  const handleCategoryChange = useCallback((value: string) => {
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

  const handleTagChange = useCallback((value: string) => {
    setTagId(value === ALL_TAGS_VALUE ? '' : value);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const toggleSelectCurrentPage = useCallback(() => {
    const allSelected = resources.length > 0 && resources.every((resource) => selectedIds.has(resource.id));
    setSelectedIds(allSelected ? new Set() : new Set(resources.map((resource) => resource.id)));
  }, [resources, selectedIds]);

  const openMoveResources = useCallback(() => {
    setMoveTargetCategoryId(categoryId || NO_FOLDER_VALUE);
    setMoveDialogOpen(true);
  }, [categoryId]);

  const openTagResources = useCallback((action: 'add' | 'remove') => {
    setTagAction(action);
    setBatchTagId('');
    setTagDialogOpen(true);
  }, []);

  const openAddToCollection = useCallback(() => {
    setBatchCollectionId('');
    setCollectionDialogOpen(true);
  }, []);

  const openCreateFolder = useCallback((parentId?: string | null) => {
    const parent = parentId === undefined ? (currentCategory?.id ?? null) : parentId;
    setEditingFolder(null);
    setFolderName('');
    setFolderParentId(parent);
    setFolderDialogOpen(true);
  }, [currentCategory]);

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

  const moveResourcesToCategory = async (ids: string[], targetCategoryId: string) => {
    const result = await batchSetResourceCategory(ids, targetCategoryId || null);

    if (result.updated > 0 && result.failed === 0) {
      toast.success(`已移动 ${result.updated} 个资源`);
    } else if (result.updated > 0) {
      toast.success(`已移动 ${result.updated} 个资源，${result.failed} 个失败`);
    } else {
      toast.error(`移动失败，${result.failed} 个资源未能移动`);
    }

    setSelectedIds(new Set());
    await reloadCategories();
    await fetchResources();
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
      if (categoryId === folderDeleteTarget.id || getCategoryPath([folderDeleteTarget], categoryId).length > 0) {
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

    const targetCategoryId = moveTargetCategoryId === NO_FOLDER_VALUE ? '' : moveTargetCategoryId;
    setMoveDialogOpen(false);
    await moveResourcesToCategory(ids, targetCategoryId);
  };

  const handleBatchTags = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0 || !batchTagId) return;

    try {
      if (tagAction === 'add') {
        const result = await batchAddTagsToResources(ids, [batchTagId]);
        toast.success(`已添加 ${result.added} 个标签关联`);
      } else {
        const result = await batchRemoveTagsFromResources(ids, [batchTagId]);
        toast.success(`已移除 ${result.removed} 个标签关联`);
      }
      setTagDialogOpen(false);
      setSelectedIds(new Set());
      await listTags().then((d) => setTags(d.items));
      await fetchResources();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '批量标签操作失败');
    }
  };

  const handleBatchAddToCollection = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0 || !batchCollectionId) return;

    try {
      const result = await batchAddToCollection(batchCollectionId, ids);
      toast.success(`已加入集合，新增 ${result.added} 个资源`);
      setCollectionDialogOpen(false);
      setSelectedIds(new Set());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加入集合失败');
    }
  };

  const handleBatchFavorite = async (isFavorite: boolean) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    try {
      const result = await batchSetResourceFavorite(ids, isFavorite);
      if (result.failed > 0) {
        toast.success(`${isFavorite ? '已收藏' : '已取消收藏'} ${result.updated} 个资源，${result.failed} 个失败`);
      } else {
        toast.success(`${isFavorite ? '已收藏' : '已取消收藏'} ${result.updated} 个资源`);
      }
      setSelectedIds(new Set());
      await fetchResources();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '批量收藏操作失败');
    }
  };

  const handleBatchDownload = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    try {
      const blob = await downloadResourcesZip(ids);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `resources-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success(`已开始下载 ${ids.length} 个资源`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '批量下载失败');
    }
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

  const handleResourceDragStart = useCallback((resource: ResourceListItem, event: React.DragEvent) => {
    const ids = selectedIds.has(resource.id) ? Array.from(selectedIds) : [resource.id];
    const payload: DragPayload = { type: 'resources', ids };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(DRAG_DATA_TYPE, JSON.stringify(payload));
    event.dataTransfer.setData('text/plain', ids.length === 1 ? resource.title || resource.originalFilename : `${ids.length} 个资源`);
  }, [selectedIds]);

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
    return category.id === editingFolder.id || containsCategory(editingFolder.children, category.id);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.type === 'single' && deleteTarget.id) {
        await softDeleteResource(deleteTarget.id);
        toast.success('已移到回收站');
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(deleteTarget.id!);
          return next;
        });
      } else {
        const ids = Array.from(selectedIds);
        const result = await batchDeleteResources(ids);
        if (result.deleted > 0 && result.failed === 0) {
          toast.success(`已将 ${result.deleted} 个资源移到回收站`);
        } else if (result.deleted > 0 && result.failed > 0) {
          toast.success(`已将 ${result.deleted} 个资源移到回收站，${result.failed} 个失败`);
        } else {
          toast.error(`删除失败，${result.failed} 个资源未能删除`);
        }
        setSelectedIds(new Set());
      }
      await fetchResources();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    } finally {
      setDeleteTarget(null);
    }
  };

  const columns: Column<ResourceListItem>[] = useMemo(() => [
    {
      key: 'title',
      header: '资源名称',
      render: (r) => (
        <div className="flex items-center gap-2">
          {r.acquisitionMode === 'link_only' ? (
            <ExternalLink className="h-5 w-5 text-primary" />
          ) : (
            <ResourceTypeIcon type={r.resourceType} className="h-5 w-5 text-muted-foreground" />
          )}
          <span
            className="cursor-pointer font-medium hover:text-primary"
            onClick={(event) => {
              event.stopPropagation();
              navigateToResource(r.id);
            }}
          >
            {r.title || r.originalFilename}
          </span>
        </div>
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
        <span className="text-muted-foreground">
          {r.acquisitionMode === 'link_only' ? r.originalFilename : formatBytes(parseInt(r.sizeBytes, 10))}
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: '上传日期',
      className: 'w-28',
      render: (r) => <span className="text-muted-foreground">{formatDate(r.createdAt)}</span>,
    },
  ], [navigateToResource]);

  const rowActions = useCallback((r: ResourceListItem) => (
    <button
      onClick={() => handleSingleDelete(r.id)}
      className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
      title="删除"
    >
      <Trash2 className="h-4 w-4" />
    </button>
  ), [handleSingleDelete]);

  return (
    <div>
      <PageHeader title="资源库" description="按文件夹、类型和标签浏览资源">
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
                <SelectItem key={t} value={t}>{RESOURCE_TYPE_LABELS[t]}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={categoryId || (categoryScope === 'root' ? UNCATEGORIZED_CATEGORY_VALUE : ALL_CATEGORIES_VALUE)}
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
            value={tagId || ALL_TAGS_VALUE}
            onValueChange={handleTagChange}
          >
            <SelectTrigger className="w-28">
              <Tag className="mr-1 h-3 w-3" />
              <SelectValue placeholder="标签" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_TAGS_VALUE}>全部标签</SelectItem>
              {tags.map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={acquisitionMode || ALL_ACQUISITION_MODES_VALUE}
            onValueChange={(value) => setAcquisitionMode(value === ALL_ACQUISITION_MODES_VALUE ? '' : value)}
          >
            <SelectTrigger className="w-28">
              <SelectValue placeholder="来源" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_ACQUISITION_MODES_VALUE}>全部来源</SelectItem>
              <SelectItem value="local_upload">本地上传</SelectItem>
              <SelectItem value="link_only">链接导入</SelectItem>
            </SelectContent>
          </Select>

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

          <div className="ml-auto flex items-center gap-1">
            <Tabs value={viewMode} onValueChange={handleViewModeChange}>
              <TabsList>
                <TabsTrigger value="grid" className="px-2">
                  <Grid3X3 className="h-4 w-4" />
                </TabsTrigger>
                <TabsTrigger value="table" className="px-2">
                  <List className="h-4 w-4" />
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>
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
                  dragOverFolderId === folder.id ? 'border-primary bg-accent ring-2 ring-primary/30' : ''
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
                      <Badge variant="secondary" className="text-xs">{folder.resourceCount}</Badge>
                      <span className="text-xs text-muted-foreground">项资源</span>
                    </div>
                  </div>
                </button>
                <div className="absolute right-2 top-2 flex gap-1 opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100">
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
      {selectedIds.size > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border bg-primary/5 px-4 py-2">
          <span className="text-sm text-muted-foreground">
            已选 <span className="font-medium text-foreground">{selectedIds.size}</span> 项
          </span>
          <Button variant="ghost" size="sm" onClick={toggleSelectCurrentPage}>
            全选当前页
          </Button>
          <Button variant="ghost" size="sm" onClick={clearSelection}>
            <X className="mr-1 h-3 w-3" />清除选择
          </Button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleBatchDownload}>
              <Download className="mr-1 h-4 w-4" />下载
            </Button>
            <Button variant="outline" size="sm" onClick={() => openTagResources('add')}>
              <Tag className="mr-1 h-4 w-4" />添加标签
            </Button>
            <Button variant="outline" size="sm" onClick={() => openTagResources('remove')}>
              <X className="mr-1 h-4 w-4" />移除标签
            </Button>
            <Button variant="outline" size="sm" onClick={openAddToCollection}>
              <Archive className="mr-1 h-4 w-4" />加入集合
            </Button>
            <Button variant="outline" size="sm" onClick={openMoveResources}>
              <Folder className="mr-1 h-4 w-4" />移动到
            </Button>
            <Button variant="outline" size="sm" onClick={() => handleBatchFavorite(true)}>
              <Heart className="mr-1 h-4 w-4" />收藏
            </Button>
            <Button variant="outline" size="sm" onClick={() => handleBatchFavorite(false)}>
              <HeartOff className="mr-1 h-4 w-4" />取消收藏
            </Button>
            <Button variant="destructive" size="sm" onClick={handleBatchDelete}>
              <Trash2 className="mr-1 h-4 w-4" />批量删除
            </Button>
          </div>
        </div>
      )}

      {/* 加载/错误/列表 */}
      {loading ? (
        <LoadingState variant={viewMode === 'grid' ? 'card' : 'table'} count={8} />
      ) : error ? (
        <ErrorState message={error} onRetry={fetchResources} />
      ) : resources.length === 0 ? (
        <EmptyState
          title="暂无资源"
          description={hasActiveFilters
            ? '没有匹配的资源，请调整搜索条件'
            : categoryScope === 'root'
              ? '根目录暂无资源，可切换到全部资源查看已放入文件夹的资源'
            : '上传文件以开始管理您的资源库'}
        />
      ) : (
        <div>
          <div hidden={viewMode !== 'grid'}>
            <ResourceGrid
              resources={resources}
              selectedIds={selectedIds}
              onSelectionChange={setSelectedIds}
              onDelete={handleSingleDelete}
              onResourceDragStart={handleResourceDragStart}
            />
          </div>
          {mountedViewModes.has('table') && (
            <div hidden={viewMode !== 'table'}>
              <DataTable
                columns={columns}
                data={resources}
                keyExtractor={resourceKeyExtractor}
                selectedIds={selectedIds}
                onSelectionChange={setSelectedIds}
                onRowClick={handleRowClick}
                rowActions={rowActions}
              />
            </div>
          )}
        </div>
      )}

      {/* 分页 */}
      {totalPages > 1 && !loading && !error && (
        <div className="mt-4 flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            上一页
          </Button>
          <span className="text-sm text-muted-foreground">
            {page} / {totalPages}（共 {total} 项）
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </Button>
        </div>
      )}

      {/* 删除确认 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={deleteTarget?.type === 'batch' ? '批量删除资源' : '删除资源'}
        description={
          deleteTarget?.type === 'batch'
            ? `确定要将选中的 ${selectedIds.size} 个资源移到回收站吗？你可以从回收站恢复。`
            : '确定要将此资源移到回收站吗？你可以从回收站恢复。'
        }
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
              <DialogDescription>
                修改名称，或调整上级文件夹来移动此文件夹。
              </DialogDescription>
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
                onValueChange={(value) => setFolderParentId(value === ROOT_FOLDER_VALUE ? null : value)}
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
            <Button variant="outline" onClick={() => setFolderDialogOpen(false)}>取消</Button>
            <Button onClick={handleSaveFolder} disabled={!folderName.trim()}>
              {editingFolder ? '保存' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!folderDeleteTarget}
        onOpenChange={(open) => { if (!open) setFolderDeleteTarget(null); }}
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
            setMoveTargetCategoryId(NO_FOLDER_VALUE);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>移动资源</DialogTitle>
            <DialogDescription>
              将选中的 {selectedIds.size} 个资源移动到指定文件夹。
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
            <Button variant="outline" onClick={() => setMoveDialogOpen(false)}>取消</Button>
            <Button onClick={handleMoveResources} disabled={selectedIds.size === 0}>移动</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={tagDialogOpen}
        onOpenChange={(open) => {
          setTagDialogOpen(open);
          if (!open) setBatchTagId('');
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tagAction === 'add' ? '批量添加标签' : '批量移除标签'}</DialogTitle>
            <DialogDescription>
              将对选中的 {selectedIds.size} 个资源执行标签操作。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>标签</Label>
            <Select value={batchTagId} onValueChange={setBatchTagId}>
              <SelectTrigger>
                <SelectValue placeholder="选择标签" />
              </SelectTrigger>
              <SelectContent>
                {tags.map((tag) => (
                  <SelectItem key={tag.id} value={tag.id}>{tag.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTagDialogOpen(false)}>取消</Button>
            <Button onClick={handleBatchTags} disabled={selectedIds.size === 0 || !batchTagId}>
              {tagAction === 'add' ? '添加' : '移除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={collectionDialogOpen}
        onOpenChange={(open) => {
          setCollectionDialogOpen(open);
          if (!open) setBatchCollectionId('');
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>加入集合</DialogTitle>
            <DialogDescription>
              将选中的 {selectedIds.size} 个资源加入指定集合。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>集合</Label>
            <Select value={batchCollectionId} onValueChange={setBatchCollectionId}>
              <SelectTrigger>
                <SelectValue placeholder="选择集合" />
              </SelectTrigger>
              <SelectContent>
                {collections.map((collection) => (
                  <SelectItem key={collection.id} value={collection.id}>{collection.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCollectionDialogOpen(false)}>取消</Button>
            <Button
              onClick={handleBatchAddToCollection}
              disabled={selectedIds.size === 0 || !batchCollectionId}
            >
              加入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
