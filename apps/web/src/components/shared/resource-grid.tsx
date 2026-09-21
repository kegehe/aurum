'use client';

import { memo, useRef } from 'react';
import { cn } from '@/lib/utils';
import type { ResourceListItem } from '@/lib/types';
import { ResourceCard } from './resource-card';

interface ResourceGridProps {
  resources: ResourceListItem[];
  selectedIds?: Set<string>;
  onSelectionChange?: (ids: Set<string>) => void;
  onDelete?: (id: string) => void;
  onRestore?: (id: string) => void;
  onResourceDragStart?: (resource: ResourceListItem, event: React.DragEvent) => void;
  /** 批量编辑模式：点击卡片选中/取消选中，按住鼠标拖拽扫过的卡片批量选中 */
  selectMode?: boolean;
  /** 来源资源库的筛选/排序上下文查询串，透传给卡片详情链接，供详情页相邻导航使用 */
  contextQuery?: string;
}

/** 触发“拖拽扫选”的最小位移（px），小于该位移视为普通点击 */
const DRAG_THRESHOLD_PX = 6;

/** 从事件目标向上查找资源卡片，返回其 resource id；不是卡片则返回 null */
function findResourceId(target: Element | null): string | null {
  const el = target?.closest?.('[data-resource-id]') as HTMLElement | null;
  return el?.dataset.resourceId ?? null;
}

interface SweepState {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startId: string;
  /** 手势开始时的选择快照；扫选期间持续累积，避免快速 pointermove 被异步渲染状态覆盖。 */
  selection: Set<string>;
  /** 本次手势已扫过的卡片；同一张卡片只切换一次，避免来回经过时反复切换。 */
  sweptIds: Set<string>;
  /** 是否已越过阈值开始扫选（区别于普通点击） */
  dragged: boolean;
}

function segmentIntersectsRect(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  rect: DOMRect,
): boolean {
  const dx = endX - startX;
  const dy = endY - startY;
  let start = 0;
  let end = 1;

  // Liang-Barsky clipping determines whether the pointer path crosses the card bounds.
  for (const [p, q] of [
    [-dx, startX - rect.left],
    [dx, rect.right - startX],
    [-dy, startY - rect.top],
    [dy, rect.bottom - startY],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }

    const ratio = q / p;
    if (p < 0) {
      if (ratio > end) return false;
      start = Math.max(start, ratio);
    } else {
      if (ratio < start) return false;
      end = Math.min(end, ratio);
    }
  }

  return true;
}

function toggleCardsAlongSegment(
  grid: HTMLDivElement,
  sweep: SweepState,
  endX: number,
  endY: number,
): boolean {
  let changed = false;

  grid.querySelectorAll<HTMLElement>('[data-resource-id]').forEach((card) => {
    const id = card.dataset.resourceId;
    if (
      id &&
      segmentIntersectsRect(sweep.lastX, sweep.lastY, endX, endY, card.getBoundingClientRect()) &&
      !sweep.sweptIds.has(id)
    ) {
      sweep.sweptIds.add(id);
      if (sweep.selection.has(id)) sweep.selection.delete(id);
      else sweep.selection.add(id);
      changed = true;
    }
  });

  sweep.lastX = endX;
  sweep.lastY = endY;
  return changed;
}

function ResourceGridComponent({
  resources,
  selectedIds,
  onSelectionChange,
  onDelete,
  onRestore,
  onResourceDragStart,
  selectMode = false,
  contextQuery = '',
}: ResourceGridProps) {
  // 批量编辑模式下“按住拖动扫选”的手势状态：
  // pointerdown 记录起点，位移超过阈值后进入扫选，光标扫过的卡片逐一加入选择；
  // 未拖动的普通点击在 pointerup 时切换该卡片的选择状态。
  const sweepRef = useRef<SweepState | null>(null);

  const commitSweepSelection = (sweep: SweepState) => {
    // 不能直接传递并继续修改同一个 Set：React state 需要一个稳定快照。
    onSelectionChange?.(new Set(sweep.selection));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!selectMode || !onSelectionChange) return;
    // 仅响应鼠标左键；触摸滑动等手势交给浏览器默认行为（如滚动），不触发扫选
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    // 不拦截卡片上的删除按钮等交互元素，让它们正常工作
    if ((e.target as HTMLElement).closest('button, input, a, [role="button"]')) return;

    const startId = findResourceId(e.target as HTMLElement);
    if (!startId) return;

    sweepRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      startId,
      selection: new Set(selectedIds ?? []),
      sweptIds: new Set(),
      dragged: false,
    };
    // 捕获指针，确保拖出网格后仍能收到 move/up 事件
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const sweep = sweepRef.current;
    // 扫选过程中退出批量模式时（selectMode 变为 false），忽略剩余的手势事件
    if (!sweep || e.pointerId !== sweep.pointerId || !selectMode) return;

    // 尚未越过阈值：视为点击，仅记录
    if (!sweep.dragged) {
      if (Math.hypot(e.clientX - sweep.startX, e.clientY - sweep.startY) < DRAG_THRESHOLD_PX) return;
      sweep.dragged = true;
      // 检查整段轨迹，避免快速移动时只切换事件终点而漏掉中间卡片。
      if (toggleCardsAlongSegment(e.currentTarget, sweep, e.clientX, e.clientY)) {
        commitSweepSelection(sweep);
      }
      return;
    }

    // 扫选进行中：切换本次轨迹穿过的全部卡片。
    if (toggleCardsAlongSegment(e.currentTarget, sweep, e.clientX, e.clientY)) {
      commitSweepSelection(sweep);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const sweep = sweepRef.current;
    if (!sweep || e.pointerId !== sweep.pointerId) return;
    sweepRef.current = null;
    // 防止扫选途中退出批量模式后，残留的 gesture 误触发选中切换
    if (!selectMode) return;

    // 未拖动的普通点击：切换该卡片的选择状态
    if (!sweep.dragged) {
      if (sweep.selection.has(sweep.startId)) sweep.selection.delete(sweep.startId);
      else sweep.selection.add(sweep.startId);
      commitSweepSelection(sweep);
    }
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    const sweep = sweepRef.current;
    if (sweep && e.pointerId === sweep.pointerId) {
      sweepRef.current = null;
    }
  };

  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5',
        selectMode && 'select-none',
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      {resources.map((resource) => (
        <ResourceCard
          key={resource.id}
          resource={resource}
          selected={selectedIds?.has(resource.id)}
          contextQuery={contextQuery}
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
          onRestore={onRestore}
          onDragStart={
            selectMode
              ? undefined
              : onResourceDragStart
                ? (event) => onResourceDragStart(resource, event)
                : undefined
          }
          selectMode={selectMode}
        />
      ))}
    </div>
  );
}

export const ResourceGrid = memo(ResourceGridComponent);
