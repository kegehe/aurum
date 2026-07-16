'use client';

import { memo } from 'react';
import type { ResourceListItem } from '@/lib/types';
import { ResourceCard } from './resource-card';

interface ResourceGridProps {
  resources: ResourceListItem[];
  selectedIds?: Set<string>;
  onSelectionChange?: (ids: Set<string>) => void;
  onDelete?: (id: string) => void;
  onResourceDragStart?: (resource: ResourceListItem, event: React.DragEvent) => void;
}

function ResourceGridComponent({
  resources,
  selectedIds,
  onSelectionChange,
  onDelete,
  onResourceDragStart,
}: ResourceGridProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
      {resources.map((resource) => (
        <ResourceCard
          key={resource.id}
          resource={resource}
          selected={selectedIds?.has(resource.id)}
          onToggle={
            onSelectionChange
              ? () => {
                  const next = new Set<string>(selectedIds ?? new Set());
                  if (next.has(resource.id)) next.delete(resource.id);
                  else next.add(resource.id);
                  onSelectionChange(next);
                }
              : undefined
          }
          onDelete={onDelete}
          onDragStart={
            onResourceDragStart
              ? (event) => onResourceDragStart(resource, event)
              : undefined
          }
        />
      ))}
    </div>
  );
}

export const ResourceGrid = memo(ResourceGridComponent);
