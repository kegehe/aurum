'use client';

import { memo, useCallback } from 'react';
import Link from 'next/link';
import { ExternalLink, Globe, Heart, RotateCcw, Trash2, Wand2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { ResourcePreview } from './resource-preview';
import { ResourceTypeBadge } from './resource-type-badge';
import { PROCESSING_STATUS_LABELS } from '@/lib/constants';
import {
  designMediaHref,
  isDesignMediaType,
  isLinkResource,
  isRemoteResource,
} from '@/lib/resource';
import { cn } from '@/lib/utils';
import type { ResourceListItem } from '@/lib/types';
import { formatByteString, formatDate } from '@/lib/format';

interface ResourceCardProps {
  resource: ResourceListItem;
  selected?: boolean;
  /**
   * 传 id 而不是闭包：卡片在列表里是 memo 的，父级每次渲染都新建
   * `() => toggle(id)` 会让 50 张卡的 memo 全部失效（实测单次选中 230–900ms）。
   */
  onToggleId?: (id: string) => void;
  onDelete?: (id: string) => void;
  /**
   * 回收站场景：在卡片右上角额外渲染一个“恢复”按钮（与彻底删除并列）。
   * 提供该回调时，“删除”按钮的语义为彻底删除。
   */
  onRestore?: (id: string) => void;
  onDragStart?: (resource: ResourceListItem, event: React.DragEvent) => void;
  /**
   * 批量编辑模式：点击卡片切换选中状态（由 ResourceGrid 统一处理点击/扫选），
   * 缩略图与标题渲染为普通元素而非跳转链接，并禁用原生拖拽以避免与扫选冲突。
   */
  selectMode?: boolean;
  /**
   * 来源资源库的筛选/排序上下文查询串（如 keyword=...&categoryId=...）。
   * 追加到详情页链接上，使详情页右上角的上一个/下一个箭头在当前筛选视图内导航。
   */
  contextQuery?: string;
}

function ResourceCardComponent({
  resource,
  selected,
  onToggleId,
  onDelete,
  onRestore,
  onDragStart,
  selectMode = false,
  contextQuery = '',
}: ResourceCardProps) {
  const isLink = isLinkResource(resource);
  const isRemote = isRemoteResource(resource);
  const remoteStatus = isRemote ? (resource.downloadError ? '下载失败' : '待下载') : null;
  // 详情页链接：在资源库上下文内导航时携带当前筛选/排序查询串，供详情页左右箭头定位相邻资源
  const detailHref = `/resources/${resource.id}${contextQuery ? `?${contextQuery}` : ''}`;

  const handleDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onDelete?.(resource.id);
  };

  const handleRestore = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onRestore?.(resource.id);
  };

  // 回调在卡片内绑定 id，保证父级重复渲染时引用不变，memo 才能真正生效。
  const handleToggle = useCallback(() => {
    onToggleId?.(resource.id);
  }, [onToggleId, resource.id]);

  const handleDragStart = useCallback(
    (event: React.DragEvent) => {
      onDragStart?.(resource, event);
    },
    [onDragStart, resource],
  );

  const title = resource.title || resource.originalFilename;
  const designable = isDesignMediaType(resource) && !resource.deletedAt;

  return (
    <Card
      draggable={!selectMode && !!onDragStart}
      onDragStart={handleDragStart}
      data-resource-id={resource.id}
      className={cn(
        'group relative overflow-hidden transition-shadow hover:shadow-md',
        selected ? 'ring-2 ring-primary' : '',
        selectMode && 'cursor-pointer',
      )}
    >
      {onToggleId && (
        <div className={`absolute left-2 top-2 z-10 ${selectMode ? 'pointer-events-none' : ''}`}>
          <input
            type="checkbox"
            checked={selected ?? false}
            onChange={handleToggle}
            onClick={(e) => e.stopPropagation()}
            className="h-4 w-4 rounded border-gray-300"
          />
        </div>
      )}

      {(designable || onRestore || onDelete) && (
        <div className="hover-reveal absolute right-2 top-2 z-10 flex items-center gap-1">
          {designable && (
            <Link
              href={designMediaHref(resource.id)}
              onClick={(event) => event.stopPropagation()}
              className="rounded-md bg-background/80 p-1.5 text-muted-foreground shadow-sm transition-colors hover:bg-primary/10 hover:text-primary"
              title="用于设计"
              aria-label="用于设计"
            >
              <Wand2 className="h-4 w-4" />
            </Link>
          )}
          {onRestore && (
            <button
              onClick={handleRestore}
              className="rounded-md bg-background/80 p-1.5 text-muted-foreground shadow-sm transition-colors hover:bg-primary/10 hover:text-primary"
              title="恢复"
              aria-label="恢复"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
          )}
          {onDelete && (
            <button
              onClick={handleDelete}
              className="rounded-md bg-background/80 p-1.5 text-muted-foreground shadow-sm transition-colors hover:bg-destructive/10 hover:text-destructive"
              title={onRestore ? '彻底删除' : '删除'}
              aria-label={onRestore ? '彻底删除' : '删除'}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

      {selectMode ? (
        <ResourcePreview resource={resource} selectMode />
      ) : (
        <Link href={detailHref}>
          <ResourcePreview resource={resource} />
        </Link>
      )}

      {/* 来源角标是纯装饰，pointer-events-none 让点击穿透给下面的详情页链接 */}
      {(isLink || isRemote) && (
        <div
          className={`pointer-events-none absolute left-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-background/80 shadow-sm ${
            onToggleId ? 'top-8' : 'top-2'
          }`}
        >
          {isLink ? (
            <ExternalLink className="h-3 w-3 text-muted-foreground" />
          ) : (
            <Globe className="h-3 w-3 text-blue-500" />
          )}
        </div>
      )}

      <CardContent className="space-y-1.5 p-3">
        {selectMode ? (
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 line-clamp-1 text-sm font-medium">{title}</span>
            {resource.isFavorite && <FavoriteMark />}
          </div>
        ) : (
          <Link
            href={detailHref}
            className="flex items-center gap-1.5 text-sm font-medium hover:text-primary"
          >
            <span className="min-w-0 flex-1 line-clamp-1">{title}</span>
            {resource.isFavorite && <FavoriteMark />}
          </Link>
        )}
        <div className="flex items-center gap-2">
          <ResourceTypeBadge type={resource.resourceType} />
          {isLink && <span className="text-xs text-muted-foreground">链接</span>}
          {isRemote && (
            <span
              className={`text-xs ${resource.downloadError ? 'text-destructive' : 'text-muted-foreground'}`}
              title={resource.downloadError ?? undefined}
            >
              {remoteStatus}
            </span>
          )}
          {resource.processingStatus === 'failed' && (
            <span className="text-xs text-destructive">{PROCESSING_STATUS_LABELS.failed}</span>
          )}
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{isLink ? '链接' : isRemote ? '—' : formatByteString(resource.sizeBytes)}</span>
          <span>{formatDate(resource.createdAt)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

/** 已收藏标记：常驻显示（不靠悬停），让用户扫一眼就能认出收藏过的资源 */
function FavoriteMark() {
  return (
    <Heart
      className="h-3.5 w-3.5 shrink-0 fill-rose-500 text-rose-500"
      role="img"
      aria-label="已收藏"
    />
  );
}

export const ResourceCard = memo(ResourceCardComponent);
