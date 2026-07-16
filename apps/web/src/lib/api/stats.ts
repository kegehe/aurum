import { get } from '../api-client';
import type { DashboardOverview, ResourceTypeStatsItem } from '../types';

/** 仪表盘统计汇总 */
export function getDashboardOverview(): Promise<DashboardOverview> {
  return get('/stats/overview');
}

/** 资源类型分布统计 */
export function getResourceTypeStats(): Promise<ResourceTypeStatsItem[]> {
  return get('/stats/resource-types');
}
