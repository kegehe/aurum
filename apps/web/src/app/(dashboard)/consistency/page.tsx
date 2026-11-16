'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Copy,
  Database,
  FileQuestion,
  FileWarning,
  HardDrive,
  RefreshCw,
} from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { ErrorState } from '@/components/shared/error-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { getConsistencyReport } from '@/lib/api/consistency';
import { formatDateTime, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { StorageConsistencyReport } from '@/lib/types';

/** 单个分区最多渲染的路径数，避免上万条孤儿文件把页面撑爆 */
const MAX_VISIBLE_PATHS = 200;

export default function ConsistencyPage() {
  const [report, setReport] = useState<StorageConsistencyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 连续点击「重新检查」时只接受最后一次请求的结果 */
  const requestIdRef = useRef(0);

  const runCheck = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await getConsistencyReport();
      if (requestId !== requestIdRef.current) return;
      setReport(result);
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      setError(e instanceof Error ? e.message : '检查失败');
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="存储一致性"
        description="比对数据库记录与磁盘文件，报告缺失文件、孤儿文件和过期临时文件。只做检查，不会删除任何内容。"
      >
        <div className="flex items-center gap-3">
          {report && (
            <span className="hidden text-xs text-muted-foreground sm:inline">
              上次检查 {formatDateTime(report.checkedAt)}
            </span>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => void runCheck()}
            disabled={loading}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            {loading ? '检查中…' : '重新检查'}
          </Button>
        </div>
      </PageHeader>

      {loading && !report ? (
        <LoadingSkeleton />
      ) : error && !report ? (
        <ErrorState message={error} onRetry={() => void runCheck()} />
      ) : report ? (
        <>
          {error && (
            <Card className="mb-4 border-destructive/40">
              <CardContent className="flex flex-wrap items-center gap-3 py-4 text-sm">
                <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
                <span className="min-w-0 flex-1 text-destructive">重新检查失败：{error}</span>
                <Button variant="outline" size="sm" onClick={() => void runCheck()}>
                  重试
                </Button>
              </CardContent>
            </Card>
          )}
          <ReportContent report={report} stale={loading} />
        </>
      ) : null}
    </div>
  );
}

function ReportContent({ report, stale }: { report: StorageConsistencyReport; stale: boolean }) {
  const missing = report.missingStorageFiles;
  const orphan = report.orphanStorageFiles;
  const expired = report.expiredTempFiles;
  const issueCount = missing.length + orphan.length + expired.length;

  const metrics = [
    {
      label: '数据库记录',
      value: report.databaseFileCount,
      hint: 'resourceFile 表中的文件数',
      icon: Database,
      tone: 'bg-blue-100 text-blue-600',
    },
    {
      label: '存储文件',
      value: report.storageFileCount,
      hint: '含临时文件与设计渲染产物',
      icon: HardDrive,
      tone: 'bg-indigo-100 text-indigo-600',
    },
    {
      label: '文件缺失',
      value: missing.length,
      hint: '有记录但找不到文件',
      icon: FileQuestion,
      tone: issueCountTone(missing.length, 'bg-red-100 text-red-600'),
    },
    {
      label: '孤儿文件',
      value: orphan.length,
      hint: '有文件但找不到记录',
      icon: FileWarning,
      tone: issueCountTone(orphan.length, 'bg-amber-100 text-amber-600'),
    },
    {
      label: '过期临时文件',
      value: expired.length,
      hint: 'temp/ 下超过 TTL 的中转文件',
      icon: Clock,
      tone: issueCountTone(expired.length, 'bg-slate-100 text-slate-600'),
    },
  ];

  return (
    <div className={cn('transition-opacity', stale && 'pointer-events-none opacity-60')}>
      <StatusBanner report={report} issueCount={issueCount} />

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <Card key={metric.label}>
              <CardContent className="p-4">
                <div
                  className={cn('flex h-9 w-9 items-center justify-center rounded-lg', metric.tone)}
                >
                  <Icon className="h-4 w-4" />
                </div>
                <p className="mt-3 text-2xl font-bold tabular-nums">{formatNumber(metric.value)}</p>
                <p className="text-sm text-muted-foreground">{metric.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground/80">{metric.hint}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {issueCount === 0 ? (
        <Card className="mt-6 border-success/30">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/15 text-success">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <div>
              <p className="text-base font-semibold">没有发现不一致</p>
              <p className="mt-1 text-sm text-muted-foreground">
                数据库中的 {formatNumber(report.databaseFileCount)} 条文件记录都能在存储中找到
                对应文件，也没有多余的孤儿文件或过期临时文件。
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="mt-6 space-y-4">
          <IssueSection
            title="文件缺失"
            description="数据库有记录，但存储中找不到对应文件，资源可能无法下载或预览。"
            items={missing}
            icon={FileQuestion}
            badgeVariant="destructive"
            emptyHint="所有数据库记录都能在存储中找到对应文件。"
          />
          <IssueSection
            title="孤儿文件"
            description="存储中存在文件，但数据库没有对应记录。已排除 temp/ 与设计渲染产物。"
            items={orphan}
            icon={FileWarning}
            badgeVariant="warning"
            emptyHint="没有发现无人认领的文件。"
          />
          <IssueSection
            title="过期临时文件"
            description="上传中转目录中超过 TTL 的文件，通常由临时文件清理任务回收。"
            items={expired}
            icon={Clock}
            badgeVariant="secondary"
            emptyHint="没有超过 TTL 的临时文件。"
          />
        </div>
      )}
    </div>
  );
}

function StatusBanner({
  report,
  issueCount,
}: {
  report: StorageConsistencyReport;
  issueCount: number;
}) {
  const healthy = issueCount === 0;
  return (
    <Card className={cn('overflow-hidden', healthy ? 'border-success/30' : 'border-warning/30')}>
      <CardContent className="relative p-0">
        <div
          className={cn(
            'absolute inset-0',
            healthy
              ? 'bg-gradient-to-r from-success/10 via-transparent to-transparent'
              : 'bg-gradient-to-r from-warning/10 via-transparent to-transparent',
          )}
        />
        <div className="relative flex flex-wrap items-start gap-3.5 p-5">
          <div
            className={cn(
              'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl',
              healthy ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning',
            )}
          >
            {healthy ? <CheckCircle2 className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-base font-semibold">
                {healthy ? '未发现不一致' : `发现 ${formatNumber(issueCount)} 个待处理文件`}
              </p>
              <Badge variant={healthy ? 'success' : 'warning'} className="rounded-full px-2">
                {healthy ? '正常' : '需关注'}
              </Badge>
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              检查时间 {formatDateTime(report.checkedAt)} · 本次检查只读，未修改数据库或存储
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function IssueSection({
  title,
  description,
  items,
  icon: Icon,
  badgeVariant,
  emptyHint,
}: {
  title: string;
  description: string;
  items: string[];
  icon: React.ComponentType<{ className?: string }>;
  badgeVariant: 'destructive' | 'warning' | 'secondary';
  emptyHint: string;
}) {
  const visible = items.slice(0, MAX_VISIBLE_PATHS);
  const hiddenCount = items.length - visible.length;

  const copyPaths = async () => {
    try {
      await navigator.clipboard.writeText(items.join('\n'));
      toast.success(`已复制 ${formatNumber(items.length)} 条路径`);
    } catch {
      toast.error('复制失败，请手动选择路径');
    }
  };

  return (
    <Card>
      <CardHeader className="gap-1 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Icon className="h-4 w-4 text-muted-foreground" />
            {title}
            <Badge variant={badgeVariant} className="rounded-full px-2 text-xs tabular-nums">
              {formatNumber(items.length)}
            </Badge>
          </CardTitle>
          {items.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
              onClick={() => void copyPaths()}
            >
              <Copy className="h-3.5 w-3.5" />
              复制全部
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent className="p-0">
        {items.length === 0 ? (
          <p className="border-t px-6 py-5 text-sm text-muted-foreground">{emptyHint}</p>
        ) : (
          <>
            <ul className="max-h-80 divide-y overflow-y-auto border-t">
              {/* 同一物理文件可能被多条资源记录引用，storagePath 不保证唯一 */}
              {visible.map((path, index) => (
                <li
                  key={`${path}-${index}`}
                  className="break-all px-6 py-2 font-mono text-xs text-foreground/90"
                >
                  {path}
                </li>
              ))}
            </ul>
            {hiddenCount > 0 && (
              <p className="border-t bg-muted/40 px-6 py-2 text-xs text-muted-foreground">
                仅显示前 {MAX_VISIBLE_PATHS} 项，另有 {formatNumber(hiddenCount)} 项未显示。
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function LoadingSkeleton() {
  return (
    <div>
      <Skeleton className="h-24 w-full rounded-xl" />
      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <Card key={index}>
            <CardContent className="space-y-2 p-4">
              <Skeleton className="h-9 w-9 rounded-lg" />
              <Skeleton className="h-7 w-16" />
              <Skeleton className="h-4 w-20" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card className="mt-6">
        <CardContent className="space-y-3 p-6">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-4 w-2/3" />
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-6 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function issueCountTone(count: number, tone: string): string {
  return count > 0 ? tone : 'bg-muted text-muted-foreground';
}
