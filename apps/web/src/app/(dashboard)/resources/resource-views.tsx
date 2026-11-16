'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Grid3X3, List } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LoadingState } from '@/components/shared/loading-state';
import { setResourceViewMode, useResourceViewMode } from '@/lib/resource-view-mode';

/**
 * 视图切换按钮：只订阅视图模式，不触发页面主体重渲染。
 * 之前这个 Tabs 的 value 提升在 resources/page.tsx 里，一次切换就要重算整页
 * 的筛选栏、文件夹、分页与弹窗，实测 dev 下 100ms 脚本时间 / 120ms 长任务。
 */
export function ResourceViewToggle() {
  const viewMode = useResourceViewMode();

  return (
    <Tabs
      value={viewMode}
      onValueChange={(value) => setResourceViewMode(value === 'table' ? 'table' : 'grid')}
    >
      <TabsList>
        <TabsTrigger value="grid" className="px-2" aria-label="网格视图">
          <Grid3X3 className="h-4 w-4" />
        </TabsTrigger>
        <TabsTrigger value="table" className="px-2" aria-label="表格视图">
          <List className="h-4 w-4" />
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

/**
 * 两个视图面板的容器：切换时只改 hidden 属性，grid / table 元素引用不变，
 * React 会直接跳过它们的重渲染（纯 DOM 切换实测 0ms 脚本）。
 * 表格首次切换才挂载，之后常驻，切回来不重挂、不重新请求缩略图。
 */
export function ResourceViewPanels({ grid, table }: { grid: ReactNode; table: ReactNode }) {
  const viewMode = useResourceViewMode();
  // 表格首次切到才挂载，之后常驻（切回来不重挂、不重新解码缩略图）。
  // 用 || 而不是只靠 effect：刷新后若记忆是表格视图，首个客户端渲染就要挂上，
  // 否则会出现一帧两个面板都隐藏的空白。
  const [tableMounted, setTableMounted] = useState(false);
  const shouldMountTable = tableMounted || viewMode === 'table';

  useEffect(() => {
    if (viewMode === 'table') setTableMounted(true);
  }, [viewMode]);

  return (
    <>
      <div hidden={viewMode !== 'grid'}>{grid}</div>
      {shouldMountTable && <div hidden={viewMode !== 'table'}>{table}</div>}
    </>
  );
}

/** 骨架屏跟随当前视图，但同样不让页面主体订阅视图状态 */
export function ResourceListSkeleton() {
  const viewMode = useResourceViewMode();
  return <LoadingState variant={viewMode === 'grid' ? 'card' : 'table'} count={8} />;
}
