'use client';

import { memo, useCallback, useRef } from 'react';
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

interface TableRowProps<T> {
  item: T;
  id: string;
  columns: Column<T>[];
  selected: boolean;
  showSelection: boolean;
  onRowClick?: (item: T) => void;
  onToggle?: (id: string) => void;
  rowActions?: (item: T) => React.ReactNode;
}

/**
 * 单行单独 memo：选中一行只会重渲染这一行。
 * 之前整张表在 selectedIds 变化时重渲染全部行，50 行一页时单次勾选实测 500–900ms。
 */
function TableRowInner<T>({
  item,
  id,
  columns,
  selected,
  showSelection,
  onRowClick,
  onToggle,
  rowActions,
}: TableRowProps<T>) {
  return (
    <tr
      onClick={onRowClick ? () => onRowClick(item) : undefined}
      className={cn(
        'border-b transition-colors',
        onRowClick && 'cursor-pointer hover:bg-muted/50',
        selected && 'bg-primary/5',
      )}
    >
      {showSelection && (
        <td className="w-10 px-3 py-3" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggle?.(id)}
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
}

const TableRow = memo(TableRowInner) as typeof TableRowInner;

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
  // 用 ref 读最新集合，让 toggleOne 引用保持稳定，行级 memo 才不会被闭包击穿。
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;

  const toggleOne = useCallback(
    (id: string) => {
      if (!onSelectionChange) return;
      const next = new Set(selectedIdsRef.current ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onSelectionChange(next);
    },
    [onSelectionChange],
  );

  if (loading) return <LoadingState variant="table" count={5} />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (data.length === 0) return <EmptyState title={emptyTitle} description={emptyDescription} />;

  const showSelection = Boolean(onSelectionChange);
  const allSelected =
    showSelection && data.length > 0 && data.every((item) => selectedIds?.has(keyExtractor(item)));

  const toggleAll = () => {
    if (!onSelectionChange) return;
    // 与网格视图一致：只增删当前页的 ID，保留其他页已勾选的资源。
    const next = new Set(selectedIdsRef.current ?? []);
    data.forEach((item) => {
      const id = keyExtractor(item);
      if (allSelected) next.delete(id);
      else next.add(id);
    });
    onSelectionChange(next);
  };

  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            {showSelection && (
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
              <th className="w-16 px-3 py-3 text-right font-medium text-muted-foreground">操作</th>
            )}
          </tr>
        </thead>
        <tbody>
          {data.map((item) => {
            const id = keyExtractor(item);
            return (
              <TableRow
                key={id}
                item={item}
                id={id}
                columns={columns}
                selected={selectedIds?.has(id) ?? false}
                showSelection={showSelection}
                onRowClick={onRowClick}
                onToggle={showSelection ? toggleOne : undefined}
                rowActions={rowActions}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export const DataTable = memo(DataTableComponent) as typeof DataTableComponent;
