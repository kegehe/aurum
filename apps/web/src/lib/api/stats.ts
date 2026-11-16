import { get } from '../api-client';
import type { DashboardOverview } from '../types';

/** 仪表盘统计汇总 */
export function getDashboardOverview(): Promise<DashboardOverview> {
  return get('/stats/overview');
}
