'use client';

import { memo, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, Trash2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { ResourceTypeBadge } from './resource-type-badge';
import { ResourceTypeIcon } from './resource-type-icon';
import { PROCESSING_STATUS_LABELS } from '@/lib/constants';
import { getResourceThumbnailUrl } from '@/lib/api/resources';
import type { ResourceListItem } from '@/lib/types';
import { formatBytes } from '@/lib/format';

/** 格式化文件大小 */
function formatSize(bytesStr: string): string {
  const bytes = parseInt(bytesStr, 10);
  if (isNaN(bytes)) return bytesStr;
  return formatBytes(bytes);
}

/** 格式化日期 */
function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/** 判断是否为外部链接资源 */
function isLinkResource(resource: ResourceListItem): boolean {
  return resource.acquisitionMode === 'link_only';
}

interface ResourceCardProps {
  resource: ResourceListItem;
  selected?: boolean;
  onToggle?: () => void;
  onDelete?: (id: string) => void;
  onDragStart?: (event: React.DragEvent) => void;
}

function ResourceCardComponent({ resource, selected, onToggle, onDelete, onDragStart }: ResourceCardProps) {
  const [thumbError, setThumbError] = useState(false);
  const isLink = isLinkResource(resource);

  const handleDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onDelete?.(resource.id);
  };

  return (
    <Card
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      className={`group relative overflow-hidden transition-shadow hover:shadow-md ${selected ? 'ring-2 ring-primary' : ''}`}
    >
      {onToggle && (
        <div className="absolute left-2 top-2 z-10">
          <input
            type="checkbox"
            checked={selected ?? false}
            onChange={onToggle}
            onClick={(e) => e.stopPropagation()}
            className="h-4 w-4 rounded border-gray-300"
          />
        </div>
      )}

      {onDelete && (
        <button
          onClick={handleDelete}
          className="absolute right-2 top-2 z-10 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
          title="删除"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}

      <Link href={`/resources/${resource.id}`}>
        <div className="flex h-32 items-center justify-center bg-muted">
          {!thumbError && (resource.resourceType === 'image' || resource.resourceType === 'video') ? (
            <img
              src={getResourceThumbnailUrl(resource.id)}
              alt={resource.title || resource.originalFilename}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
              onError={() => setThumbError(true)}
            />
          ) : (
            <ResourceTypeIcon type={resource.resourceType} className="h-12 w-12 text-muted-foreground" />
          )}
          {isLink && (
            <div className={`absolute left-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-background/80 shadow-sm ${onToggle ? 'top-8' : 'top-2'}`}>
              <ExternalLink className="h-3 w-3 text-muted-foreground" />
            </div>
          )}
        </div>
      </Link>

      <CardContent className="space-y-1.5 p-3">
        <Link href={`/resources/${resource.id}`} className="line-clamp-1 text-sm font-medium hover:text-primary">
          {resource.title || resource.originalFilename}
        </Link>
        <div className="flex items-center gap-2">
          <ResourceTypeBadge type={resource.resourceType} />
          {isLink && (
            <span className="text-xs text-muted-foreground">链接</span>
          )}
          {resource.processingStatus === 'failed' && (
            <span className="text-xs text-destructive">
              {PROCESSING_STATUS_LABELS.failed}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{isLink ? resource.originalFilename : formatSize(resource.sizeBytes)}</span>
          <span>{formatDate(resource.createdAt)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

export const ResourceCard = memo(ResourceCardComponent);
