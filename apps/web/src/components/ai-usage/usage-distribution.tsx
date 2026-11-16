'use client';

import { formatCompactNumber } from '@/lib/format';

export interface DistributionItem {
  key: string;
  label: string;
  requests: number;
  failed: number;
  canceled: number;
  tokens: number;
}

interface UsageDistributionProps {
  items: DistributionItem[];
  emptyLabel?: string;
}

/**
 * 横向分布条：按请求次数降序展示占比，右侧补充 Token 用量。
 * 用于「按功能」「按模型」两块，避免为两种维度写两套图表。
 *
 * 组件内部重新排序：后端按 Token 总量排序，而条形长度表达的是请求次数，
 * 若沿用后端顺序会出现「第一条比第二条短」的视觉矛盾。
 */
export function UsageDistribution({ items, emptyLabel = '暂无数据' }: UsageDistributionProps) {
  if (items.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }

  const sorted = [...items].sort((a, b) => b.requests - a.requests || b.tokens - a.tokens);
  const max = Math.max(1, ...sorted.map((item) => item.requests));

  return (
    <div className="space-y-4">
      {sorted.map((item) => (
        <div key={item.key}>
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-sm font-medium" title={item.label}>
              {item.label}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {formatCompactNumber(item.requests)} 次 · {formatCompactNumber(item.tokens)} tokens
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${(item.requests / max) * 100}%` }}
            />
          </div>
          {item.failed > 0 && (
            <p className="mt-1 text-[11px] text-destructive">{item.failed} 次失败</p>
          )}
          {item.canceled > 0 && (
            <p className="mt-1 text-[11px] text-muted-foreground">{item.canceled} 次取消</p>
          )}
        </div>
      ))}
    </div>
  );
}
