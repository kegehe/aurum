'use client';

import { memo } from 'react';
import { cn } from '@/lib/utils';
import { LoadingState } from './loading-state';
import { ErrorState } from './error-state';
import { EmptyState } from './empty-state';

export interface Column<T> {
  key: string;
  header: string;
  className?: string;
  render?: (item: T) => React.ReactNode;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
  keyExtractor: (item: T) => string;
  onRowClick?: (item: T) => void;
  selectedIds?: Set<string>;
  onSelectionChange?: (ids: Set<string>) => void;
  rowActions?: (item: T) => React.ReactNode;
}

function DataTableComponent<T>({
  columns,
  data,
  loading,
  error,
  onRetry,
  emptyTitle = '暂无数据',
  emptyDescription,
  keyExtractor,
  onRowClick,
  selectedIds,
  onSelectionChange,
  rowActions,
}: DataTableProps<T>) {
  if (loading) return <LoadingState variant="table" count={5} />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (data.length === 0) return <EmptyState title={emptyTitle} description={emptyDescription} />;

  const allSelected = selectedIds && data.length > 0 && data.every((item) => selectedIds.has(keyExtractor(item)));

  const toggleAll = () => {
    if (!onSelectionChange) return;
    if (allSelected) {
      onSelectionChange(new Set());
    } else {
      onSelectionChange(new Set(data.map(keyExtractor)));
    }
  };

  const toggleOne = (id: string) => {
    if (!onSelectionChange || !selectedIds) return;
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectionChange(next);
  };

  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            {onSelectionChange && (
              <th className="w-10 px-3 py-3 text-left">
                <input
                  type="checkbox"
                  checked={allSelected ?? false}
                  onChange={toggleAll}
                  className="h-4 w-4 rounded border-gray-300"
                />
              </th>
            )}
            {columns.map((col) => (
              <th
                key={col.key}
                className={cn(
                  'px-4 py-3 text-left font-medium text-muted-foreground',
                  col.className,
                )}
              >
                {col.header}
              </th>
            ))}
            {rowActions && (
              <th className="w-16 px-3 py-3 text-right font-medium text-muted-foreground">
                操作
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {data.map((item) => {
            const id = keyExtractor(item);
            const isSelected = selectedIds?.has(id);
            return (
              <tr
                key={id}
                onClick={() => onRowClick?.(item)}
                className={cn(
                  'border-b transition-colors',
                  onRowClick && 'cursor-pointer hover:bg-muted/50',
                  isSelected && 'bg-primary/5',
                )}
              >
                {onSelectionChange && (
                  <td className="w-10 px-3 py-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isSelected ?? false}
                      onChange={() => toggleOne(id)}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                  </td>
                )}
                {columns.map((col) => (
                  <td key={col.key} className={cn('px-4 py-3', col.className)}>
                    {col.render ? col.render(item) : String((item as Record<string, unknown>)[col.key] ?? '')}
                  </td>
                ))}
                {rowActions && (
                  <td className="px-3 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    {rowActions(item)}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export const DataTable = memo(DataTableComponent) as typeof DataTableComponent;
