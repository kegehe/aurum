'use client';

import { cn } from '@/lib/utils';

export interface UsageBarSeries {
  key: string;
  label: string;
  /** Tailwind 背景色类（需以字面量出现在源码中，便于 Tailwind 扫描） */
  className: string;
}

export interface UsageBarDatum {
  key: string;
  /** X 轴标签（MM-DD） */
  label: string;
  /** 悬浮提示文本 */
  tooltip: string;
  values: Record<string, number>;
}

interface UsageBarChartProps {
  data: UsageBarDatum[];
  series: UsageBarSeries[];
  formatValue: (value: number) => string;
  emptyLabel?: string;
}

/**
 * 轻量堆叠柱状图（纯 CSS，不引入图表库）
 *
 * 选择自绘而不是 recharts / echarts：本项目只用到「按天堆叠 + 悬浮查看」，
 * 引入图表库会增加包体积与 React 19 兼容风险，而纯 flex 柱状图足够表达，
 * 且天然响应式、跟随主题色。
 */
export function UsageBarChart({
  data,
  series,
  formatValue,
  emptyLabel = '暂无数据',
}: UsageBarChartProps) {
  const totals = data.map((item) =>
    series.reduce((sum, entry) => sum + (item.values[entry.key] ?? 0), 0),
  );
  const max = Math.max(1, ...totals);
  const hasData = totals.some((value) => value > 0);
  if (!hasData) {
    return (
      <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }

  // 最多显示 6 个 X 轴标签，避免 90 天时文字挤在一起
  const labelStep = Math.max(1, Math.ceil(data.length / 6));
  // 请求数很小时 0.25/0.5/0.75 取整后会重复（如 1,1,1,0,0），只保留上下限
  const tickFractions = max < 4 ? [1, 0] : [1, 0.75, 0.5, 0.25, 0];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        {series.map((entry) => (
          <span key={entry.key} className="inline-flex items-center gap-1.5">
            <span className={cn('h-2.5 w-2.5 rounded-sm', entry.className)} />
            {entry.label}
          </span>
        ))}
      </div>

      {/* 90 天在窄屏上柱子会细到不可见，给一个最小宽度并允许横向滚动 */}
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <div
          className="grid grid-cols-[44px_minmax(0,1fr)] gap-2"
          style={{ minWidth: data.length > 30 ? 520 : undefined }}
        >
          <div className="flex h-56 flex-col justify-between pr-1 text-right text-[11px] tabular-nums text-muted-foreground">
            {tickFractions.map((fraction) => (
              <span key={fraction}>{formatValue(max * fraction)}</span>
            ))}
          </div>

          <div>
            <div className="flex h-56 items-end gap-[2px]">
              {data.map((item) => (
                <div
                  key={item.key}
                  className="flex h-full flex-1 flex-col justify-end"
                  title={item.tooltip}
                >
                  {/* 反转渲染顺序：输入在下、输出在上，符合堆叠柱的阅读习惯 */}
                  {[...series].reverse().map((entry) => {
                    const value = item.values[entry.key] ?? 0;
                    if (value <= 0) return null;
                    return (
                      <div
                        key={entry.key}
                        className={cn(
                          'w-full shrink-0 transition-opacity hover:opacity-80',
                          entry.className,
                        )}
                        style={{ height: `${(value / max) * 100}%` }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="mt-2 flex gap-[2px]">
              {data.map((item, index) => (
                <div
                  key={item.key}
                  className="min-w-0 flex-1 text-center text-[10px] text-muted-foreground"
                >
                  {index % labelStep === 0 || index === data.length - 1 ? item.label : ''}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
