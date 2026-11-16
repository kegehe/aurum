'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  Clock,
  Coins,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { ErrorState } from '@/components/shared/error-state';
import { UsageBarChart } from '@/components/ai-usage/usage-bar-chart';
import { UsageDistribution } from '@/components/ai-usage/usage-distribution';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { getAiUsageOverview } from '@/lib/api/ai-usage';
import { AI_ERROR_KIND_LABELS, AI_FEATURE_LABELS } from '@/lib/constants';
import {
  formatCompactNumber,
  formatDateTimeCompact,
  formatDurationMs,
  formatNumber,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AiUsageOverview } from '@/lib/types';

const RANGE_OPTIONS = [7, 30, 90] as const;

export default function AiUsagePage() {
  const [days, setDays] = useState<number>(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AiUsageOverview | null>(null);
  /** 快速切换 7/30/90 天时，只接受最后一次请求的结果，避免旧响应覆盖新区间 */
  const requestIdRef = useRef(0);

  const fetchData = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await getAiUsageOverview(days);
      if (requestId !== requestIdRef.current) return;
      setData(result);
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      const message = e instanceof Error ? e.message : '加载失败';
      setError(message);
      toast.error('AI 用量加载失败');
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return (
    <div>
      <PageHeader title="AI 用量" description="按上游请求统计的 AI 调用次数、Token 消耗与响应耗时">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="inline-flex items-center rounded-md border bg-background p-0.5">
            {RANGE_OPTIONS.map((option) => (
              <Button
                key={option}
                type="button"
                size="sm"
                variant={option === days ? 'secondary' : 'ghost'}
                className="h-7 px-2.5 text-xs"
                onClick={() => setDays(option)}
              >
                {option} 天
              </Button>
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => void fetchData()}
            disabled={loading}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            刷新
          </Button>
        </div>
      </PageHeader>

      {loading && !data ? (
        <LoadingSkeleton />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void fetchData()} />
      ) : data ? (
        <div className={cn('transition-opacity', loading && 'pointer-events-none opacity-60')}>
          <AiUsageContent data={data} />
        </div>
      ) : null}
    </div>
  );
}

function AiUsageContent({ data }: { data: AiUsageOverview }) {
  const totals = data.totals;

  const metrics = [
    {
      label: '请求次数',
      value: formatNumber(totals.requests),
      hint:
        `成功 ${formatNumber(totals.success)} · 失败 ${formatNumber(totals.failed)}` +
        (totals.canceled > 0 ? ` · 取消 ${formatNumber(totals.canceled)}` : ''),
      icon: Activity,
      tone: 'bg-blue-100 text-blue-600',
    },
    {
      label: '请求成功率',
      value: `${totals.successRate}%`,
      hint:
        totals.requests === 0
          ? '暂无调用'
          : `${formatNumber(totals.failed)} 次失败` +
            (totals.canceled > 0 ? ` · ${formatNumber(totals.canceled)} 次取消` : ''),
      icon: CheckCircle2,
      tone: 'bg-emerald-100 text-emerald-600',
    },
    {
      label: '输入 Tokens',
      value: formatCompactNumber(totals.inputTokens),
      hint: `缓存读取 ${formatCompactNumber(totals.cacheReadTokens)} · 写入 ${formatCompactNumber(totals.cacheCreationTokens)}`,
      icon: ArrowDownToLine,
      tone: 'bg-indigo-100 text-indigo-600',
    },
    {
      label: '输出 Tokens',
      value: formatCompactNumber(totals.outputTokens),
      hint: `占总量的 ${percentage(totals.outputTokens, totals.totalTokens)}%`,
      icon: ArrowUpFromLine,
      tone: 'bg-violet-100 text-violet-600',
    },
    {
      label: '总 Tokens',
      value: formatCompactNumber(totals.totalTokens),
      hint: '输入 + 输出，缓存另计',
      icon: Coins,
      tone: 'bg-amber-100 text-amber-600',
    },
    {
      label: '平均耗时',
      value: formatDurationMs(totals.avgLatencyMs),
      hint: `基于 ${formatNumber(totals.requests)} 次请求`,
      icon: Clock,
      tone: 'bg-rose-100 text-rose-600',
    },
  ];

  const tokenChartData = data.series.map((point) => ({
    key: point.date,
    label: point.date.slice(5),
    tooltip: `${point.date}\n输入 ${formatNumber(point.inputTokens)} tokens\n输出 ${formatNumber(point.outputTokens)} tokens\n请求 ${point.requests} 次`,
    values: { input: point.inputTokens, output: point.outputTokens },
  }));

  const requestChartData = data.series.map((point) => ({
    key: point.date,
    label: point.date.slice(5),
    tooltip: `${point.date}\n请求 ${point.requests} 次\n失败 ${point.failed} 次\n取消 ${point.canceled} 次`,
    values: {
      success: Math.max(0, point.requests - point.failed - point.canceled),
      failed: point.failed,
      canceled: point.canceled,
    },
  }));

  const featureItems = data.features.map((item) => ({
    key: item.feature,
    label: AI_FEATURE_LABELS[item.feature] ?? item.feature,
    requests: item.requests,
    failed: item.failed,
    canceled: item.canceled,
    tokens: item.totalTokens,
  }));

  const modelItems = data.models.map((item) => ({
    key: item.model,
    label: item.model,
    requests: item.requests,
    failed: item.failed,
    canceled: item.canceled,
    tokens: item.totalTokens,
  }));

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <Card key={metric.label}>
              <CardContent className="flex items-center gap-4 pt-6">
                <div
                  className={cn(
                    'flex h-12 w-12 shrink-0 items-center justify-center rounded-lg',
                    metric.tone,
                  )}
                >
                  <Icon className="h-6 w-6" />
                </div>
                <div className="min-w-0">
                  <p className="text-2xl font-bold tabular-nums">{metric.value}</p>
                  <p className="text-sm text-muted-foreground">{metric.label}</p>
                  <p
                    className="mt-0.5 truncate text-xs text-muted-foreground/80"
                    title={metric.hint}
                  >
                    {metric.hint}
                  </p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {totals.requests === 0 && (
        <Card className="mt-6 border-dashed">
          <CardContent className="flex items-center gap-3 py-5 text-sm text-muted-foreground">
            <Sparkles className="h-5 w-5 shrink-0 text-primary" />
            <span>
              还没有 AI 调用记录。去
              <Link href="/style-lab" className="font-medium underline underline-offset-2">
                「样式实验室」
              </Link>
              分析一张图片，或在
              <Link href="/design-library" className="font-medium underline underline-offset-2">
                「设计运营台」
              </Link>
              让 AI 生成方案，这里会自动记录每次请求的 Token 与耗时。
            </span>
          </CardContent>
        </Card>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Token 消耗趋势</CardTitle>
          </CardHeader>
          <CardContent>
            <UsageBarChart
              data={tokenChartData}
              series={[
                { key: 'input', label: '输入 Tokens', className: 'bg-blue-500' },
                { key: 'output', label: '输出 Tokens', className: 'bg-emerald-500' },
              ]}
              formatValue={(value) => formatCompactNumber(Math.round(value))}
              emptyLabel="所选区间内没有 Token 记录"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">按功能分布</CardTitle>
          </CardHeader>
          <CardContent>
            <UsageDistribution items={featureItems} emptyLabel="暂无功能调用数据" />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">请求次数趋势</CardTitle>
          </CardHeader>
          <CardContent>
            <UsageBarChart
              data={requestChartData}
              series={[
                { key: 'success', label: '成功', className: 'bg-primary' },
                { key: 'failed', label: '失败', className: 'bg-red-500' },
                { key: 'canceled', label: '取消', className: 'bg-slate-400' },
              ]}
              formatValue={(value) => formatCompactNumber(Math.round(value))}
              emptyLabel="所选区间内没有请求记录"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">按模型分布</CardTitle>
          </CardHeader>
          <CardContent>
            <UsageDistribution items={modelItems} emptyLabel="暂无模型调用数据" />
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">最近请求</CardTitle>
          <span className="text-xs text-muted-foreground">
            所选区间内最近 {data.recent.length} 条
          </span>
        </CardHeader>
        <CardContent className="p-0">
          {data.recent.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-muted-foreground">暂无请求记录</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead className="border-y bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">时间</th>
                    <th className="px-4 py-2 font-medium">来源</th>
                    <th className="px-4 py-2 font-medium">模型</th>
                    <th className="px-4 py-2 font-medium">状态</th>
                    <th className="px-4 py-2 text-right font-medium">输入</th>
                    <th className="px-4 py-2 text-right font-medium">输出</th>
                    <th className="px-4 py-2 text-right font-medium" title="缓存读取 + 缓存写入">
                      缓存
                    </th>
                    <th className="px-4 py-2 text-right font-medium">耗时</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.recent.map((row) => {
                    const cacheTokens = row.cacheReadTokens + row.cacheCreationTokens;
                    const canceled = row.status !== 'success' && row.errorKind === 'canceled';
                    const failed = row.status !== 'success' && !canceled;
                    return (
                      <tr key={row.id} className="transition-colors hover:bg-muted/40">
                        <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">
                          {formatDateTimeCompact(row.createdAt)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5">
                          {AI_FEATURE_LABELS[row.feature] ?? row.feature}
                        </td>
                        <td className="max-w-[220px] truncate px-4 py-2.5 font-mono text-xs">
                          {row.model}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5">
                          <Badge
                            variant={canceled ? 'secondary' : failed ? 'destructive' : 'success'}
                            title={row.errorMessage ?? undefined}
                          >
                            {canceled
                              ? '已取消'
                              : failed
                                ? `请求失败 · ${AI_ERROR_KIND_LABELS[row.errorKind ?? 'unknown'] ?? '未知'}`
                                : '请求成功'}
                          </Badge>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {formatNumber(row.inputTokens)}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {formatNumber(row.outputTokens)}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                          {cacheTokens > 0 ? formatNumber(cacheTokens) : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                          {formatDurationMs(row.latencyMs)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function LoadingSkeleton() {
  return (
    <div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Card key={index}>
            <CardContent className="flex items-center gap-4 pt-6">
              <Skeleton className="h-12 w-12 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-6 w-20" />
                <Skeleton className="h-4 w-16" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="pt-6">
            <Skeleton className="h-64 w-full" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-4 pt-6">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function percentage(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}
