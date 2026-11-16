/**
 * 资源库视图模式（网格 / 表格）的外部存储。
 *
 * 为什么不放在 resources/page.tsx 的 state 里：那是一个 1800 行的组件，
 * 切换视图会让整棵树重渲染（实测 dev 下单次 120ms 长任务，纯 DOM 切换则接近 0）。
 * 状态放到模块级 store 后，只有订阅它的「切换按钮」和「面板容器」重渲染，
 * 页面主体、筛选栏、分页、弹窗都不参与，切换成本降到一次属性更新。
 */
import { useSyncExternalStore } from 'react';

export type ResourceViewMode = 'grid' | 'table';

const STORAGE_KEY = 'aurum.resources.view-mode';
const listeners = new Set<() => void>();

function readStoredMode(): ResourceViewMode {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'table' ? 'table' : 'grid';
  } catch {
    // 隐私模式/配额受限时按默认视图走
    return 'grid';
  }
}

// 模块求值时（客户端 chunk 加载后、hydration 前）读一次即可：
// getSnapshot 每次返回同一个值，避免在渲染期读 localStorage。
let mode: ResourceViewMode = typeof window === 'undefined' ? 'grid' : readStoredMode();

export function getResourceViewMode(): ResourceViewMode {
  return mode;
}

export function setResourceViewMode(next: ResourceViewMode): void {
  if (next === mode) return;
  mode = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // 视图记忆属于增强能力，写入失败不影响本次切换
  }
  for (const listener of listeners) listener();
}

function subscribeResourceViewMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getServerViewMode = (): ResourceViewMode => 'grid';

/** 订阅视图模式：只有调用它的组件会在切换时重渲染 */
export function useResourceViewMode(): ResourceViewMode {
  return useSyncExternalStore(subscribeResourceViewMode, getResourceViewMode, getServerViewMode);
}
