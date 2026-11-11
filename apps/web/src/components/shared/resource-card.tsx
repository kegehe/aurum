'use client';

import { memo, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, Globe, RotateCcw, Trash2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { ResourceTypeBadge } from './resource-type-badge';
import { ResourceTypeIcon } from './resource-type-icon';
import { PROCESSING_STATUS_LABELS } from '@/lib/constants';
import { getResourceThumbnailUrl } from '@/lib/api/resources';
import { isLinkResource, isRemoteResource, hasLocalThumbnail } from '@/lib/resource';
import { cn } from '@/lib/utils';
import type { ResourceListItem } from '@/lib/types';
import { formatByteString } from '@/lib/format';

/** 格式化日期 */
function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

interface ResourceCardProps {
  resource: ResourceListItem;
  selected?: boolean;
  onToggle?: () => void;
  onDelete?: (id: string) => void;
  /**
   * 回收站场景：在卡片右上角额外渲染一个“恢复”按钮（与彻底删除并列）。
   * 提供该回调时，“删除”按钮的语义为彻底删除。
   */
  onRestore?: (id: string) => void;
  onDragStart?: (event: React.DragEvent) => void;
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
  onToggle,
  onDelete,
  onRestore,
  onDragStart,
  selectMode = false,
  contextQuery = '',
}: ResourceCardProps) {
  const [thumbError, setThumbError] = useState(false);
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

  const thumbnail = (
    <div className="flex h-32 items-center justify-center bg-muted">
      {!thumbError &&
      (resource.resourceType === 'image' || resource.resourceType === 'video') &&
      (hasLocalThumbnail(resource) || (resource.resourceType === 'image' && !!resource.previewUrl)) ? (
        <img
          src={hasLocalThumbnail(resource) ? getResourceThumbnailUrl(resource.id) : resource.previewUrl!}
          alt={resource.title || resource.originalFilename}
          loading="lazy"
          decoding="async"
          referrerPolicy={isRemote ? 'no-referrer' : undefined}
          draggable={selectMode ? false : undefined}
          className="h-full w-full object-cover"
          onError={() => setThumbError(true)}
        />
      ) : (
        <ResourceTypeIcon
          type={resource.resourceType}
          className="h-12 w-12 text-muted-foreground"
        />
      )}
      {(isLink || isRemote) && (
        <div
          className={`absolute left-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-background/80 shadow-sm ${onToggle ? 'top-8' : 'top-2'}`}
        >
          {isLink ? (
            <ExternalLink className="h-3 w-3 text-muted-foreground" />
          ) : (
            <Globe className="h-3 w-3 text-blue-500" />
          )}
        </div>
      )}
    </div>
  );

  const title = resource.title || resource.originalFilename;

  return (
    <Card
      draggable={!selectMode && !!onDragStart}
      onDragStart={onDragStart}
      data-resource-id={resource.id}
      className={cn(
        'group relative overflow-hidden transition-shadow hover:shadow-md',
        selected ? 'ring-2 ring-primary' : '',
        selectMode && 'cursor-pointer',
      )}
    >
      {onToggle && (
        <div
          className={`absolute left-2 top-2 z-10 ${selectMode ? 'pointer-events-none' : ''}`}
        >
          <input
            type="checkbox"
            checked={selected ?? false}
            onChange={onToggle}
            onClick={(e) => e.stopPropagation()}
            className="h-4 w-4 rounded border-gray-300"
          />
        </div>
      )}

      {onRestore && (
        <button
          onClick={handleRestore}
          className="absolute right-2 top-2 z-10 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-primary/10 hover:text-primary group-hover:opacity-100"
          title="恢复"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
      )}

      {onDelete && (
        <button
          onClick={handleDelete}
          className={`absolute top-2 z-10 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 ${
            onRestore ? 'right-9' : 'right-2'
          }`}
          title={onRestore ? '彻底删除' : '删除'}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}

      {selectMode ? (
        thumbnail
      ) : (
        <Link href={detailHref}>{thumbnail}</Link>
      )}

      <CardContent className="space-y-1.5 p-3">
        {selectMode ? (
          <div className="line-clamp-1 text-sm font-medium">{title}</div>
        ) : (
          <Link
            href={detailHref}
            className="line-clamp-1 text-sm font-medium hover:text-primary"
          >
            {title}
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

export const ResourceCard = memo(ResourceCardComponent);
