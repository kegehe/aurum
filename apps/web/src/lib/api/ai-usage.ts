import { get } from '../api-client';
import type { AiUsageOverview } from '../types';

/**
 * AI 用量概览
 * @param days 统计天数（后端会限制在 1-365）
 */
export function getAiUsageOverview(days = 30): Promise<AiUsageOverview> {
  return get('/ai-usage/overview', { days });
}
