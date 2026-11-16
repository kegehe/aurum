'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
} from 'lucide-react';
import { IngestionJobStatus, IngestionJobType } from '@aurum/shared-types';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { DataTable, type Column } from '@/components/shared/data-table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  cancelIngestionJob,
  clearIngestionJobs,
  deleteIngestionJob,
  getIngestionJobStats,
  listIngestionJobs,
  retryIngestionJob,
} from '@/lib/api/ingestion';
import { formatDateTime } from '@/lib/format';
import type { IngestionJobItem, IngestionJobStats } from '@/lib/types';

const STATUS_LABELS: Record<IngestionJobStatus, string> = {
  pending: '待处理',
  processing: '处理中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
};
const TYPE_LABELS: Record<IngestionJobType, string> = {
  import_url: '链接导入',
  sync_source: '来源同步',
  download_file: '文件下载',
  check_locator: '链接检查',
  capture_page: '页面快照',
};
const statusVariant = (status: IngestionJobStatus) =>
  status === 'completed'
    ? 'success'
    : status === 'failed'
      ? 'destructive'
      : status === 'processing'
        ? 'warning'
        : 'secondary';

function getDetail(job: IngestionJobItem) {
  if (job.resource)
    return (
      <Link className="text-primary hover:underline" href={`/resources/${job.resource.id}`}>
        {job.resource.title || job.resource.id.slice(0, 8)}
      </Link>
    );
  try {
    const request = JSON.parse(job.request) as { url?: string };
    return request.url ? (
      <span className="line-clamp-1 font-mono text-xs text-muted-foreground" title={request.url}>
        {request.url}
      </span>
    ) : (
      '-'
    );
  } catch {
    return '-';
  }
}

export default function IngestionTasks({ active = true }: { active?: boolean }) {
  const searchParams = useSearchParams();
  const statusFromUrl = useMemo(() => {
    const value = searchParams.get('status');
    return Object.values(IngestionJobStatus).includes(value as IngestionJobStatus)
      ? (value as IngestionJobStatus)
      : 'all';
  }, [searchParams]);
  const [jobs, setJobs] = useState<IngestionJobItem[]>([]);
  const [stats, setStats] = useState<IngestionJobStats | null>(null);
  const [status, setStatus] = useState<IngestionJobStatus | 'all'>(statusFromUrl);
  const [jobType, setJobType] = useState<IngestionJobType | 'all'>('all');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<IngestionJobItem | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const fetching = useRef(false);
  const pageSize = 20;

  useEffect(() => {
    setStatus(statusFromUrl);
    setPage(1);
  }, [statusFromUrl]);

  const fetchData = useCallback(
    async (quiet = false) => {
      if (quiet && fetching.current) return;
      fetching.current = true;
      if (!quiet) setLoading(true);
      let refetching = false;
      try {
        const [result, nextStats] = await Promise.all([
          listIngestionJobs({
            page,
            pageSize,
            status: status === 'all' ? undefined : status,
            jobType: jobType === 'all' ? undefined : jobType,
          }),
          getIngestionJobStats(),
        ]);
        // 与处理任务一致：清空/删除后当前页可能越界，先收敛回最后一个有效页再重新拉取
        setTotal(result.total);
        setStats(nextStats);
        setError(undefined);
        const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
        if (page > lastPage) {
          refetching = true;
          setPage(lastPage);
          return;
        }
        setJobs(result.items);
      } catch (reason) {
        if (!quiet) setError(reason instanceof Error ? reason.message : '加载失败');
      } finally {
        fetching.current = false;
        if (!quiet && !refetching) setLoading(false);
      }
    },
    [jobType, page, status],
  );

  useEffect(() => {
    void fetchData();
  }, [fetchData]);
  const hasActiveJobs = (stats?.pending ?? 0) + (stats?.processing ?? 0) > 0;
  useEffect(() => {
    // 隐藏的 tab 不轮询：两个面板都常驻挂载后，后台白跑请求会变成持续抖动
    if (!active) return;
    const timer = window.setInterval(
      () => {
        if (!document.hidden) void fetchData(true);
      },
      hasActiveJobs ? 3000 : 15000,
    );
    return () => window.clearInterval(timer);
  }, [active, hasActiveJobs, fetchData]);

  // 从另一个 tab 切回来时补一次静默刷新，不闪骨架
  const prevActiveRef = useRef(active);
  useEffect(() => {
    const wasActive = prevActiveRef.current;
    prevActiveRef.current = active;
    if (active && !wasActive) void fetchData(true);
  }, [active, fetchData]);

  const retry = useCallback(
    async (job: IngestionJobItem) => {
      try {
        await retryIngestionJob(job.id);
        toast.success('任务已重新排队');
        await fetchData();
      } catch (reason) {
        toast.error(reason instanceof Error ? reason.message : '重试失败');
      }
    },
    [fetchData],
  );
  const cancel = useCallback(
    async (job: IngestionJobItem) => {
      const queued = job.status === 'pending';
      try {
        await cancelIngestionJob(job.id);
        toast.success(queued ? '已取消排队' : '任务已停止');
        await fetchData();
      } catch (reason) {
        toast.error(
          reason instanceof Error ? reason.message : queued ? '取消任务失败' : '停止任务失败',
        );
      }
    },
    [fetchData],
  );
  const remove = async (job: IngestionJobItem) => {
    try {
      await deleteIngestionJob(job.id);
      toast.success('任务记录已删除');
      setDeleteTarget(null);
      await fetchData();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '删除任务记录失败');
    }
  };
  const clear = async () => {
    try {
      const result = await clearIngestionJobs();
      toast.success(`已清空 ${result.deleted} 条已结束的任务记录`);
      setClearConfirmOpen(false);
      await fetchData();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '清空任务记录失败');
    }
  };
  // columns 必须稳定：否则 tab 切换/轮询时 DataTable 的行级 memo 全部失效
  const columns: Column<IngestionJobItem>[] = useMemo(
    () => [
      {
        key: 'jobType',
        header: '任务类型',
        render: (job) => <span className="font-medium">{TYPE_LABELS[job.jobType]}</span>,
      },
      {
        key: 'status',
        header: '状态',
        className: 'w-28',
        render: (job) => (
          <Badge variant={statusVariant(job.status)}>{STATUS_LABELS[job.status]}</Badge>
        ),
      },
      {
        key: 'source',
        header: '来源',
        className: 'w-36',
        render: (job) =>
          job.source ? (
            <Link className="text-primary hover:underline" href="/sources">
              {job.source.name}
            </Link>
          ) : (
            '-'
          ),
      },
      { key: 'detail', header: '详情', render: getDetail },
      {
        key: 'error',
        header: '失败原因',
        render: (job) => (
          <span className="line-clamp-1 text-destructive">{job.errorMessage || '-'}</span>
        ),
      },
      {
        key: 'createdAt',
        header: '创建时间',
        className: 'w-40',
        render: (job) => (
          <span className="text-muted-foreground">{formatDateTime(job.createdAt)}</span>
        ),
      },
      {
        key: 'actions',
        header: '操作',
        className: 'w-40 text-right',
        render: (job) => (
          <div className="flex justify-end gap-1">
            {job.status === 'processing' || job.status === 'pending' ? (
              <Button
                variant="ghost"
                size="sm"
                title={job.status === 'pending' ? '取消排队' : '停止任务'}
                onClick={() => cancel(job)}
              >
                <Square className="h-4 w-4" />
              </Button>
            ) : job.status === 'failed' || job.status === 'canceled' ? (
              <Button variant="ghost" size="sm" title="重新排队" onClick={() => retry(job)}>
                <RotateCcw className="h-4 w-4" />
              </Button>
            ) : null}
            {job.status === 'completed' || job.status === 'failed' || job.status === 'canceled' ? (
              <Button
                variant="ghost"
                size="sm"
                title="删除记录"
                onClick={() => setDeleteTarget(job)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            ) : null}
          </div>
        ),
      },
    ],
    [cancel, retry],
  );
  const cards = useMemo(
    () =>
      [
        ['待处理', stats?.pending ?? 0, Clock, 'text-amber-600 bg-amber-100'],
        ['处理中', stats?.processing ?? 0, Loader2, 'text-blue-600 bg-blue-100'],
        ['失败', stats?.failed ?? 0, AlertTriangle, 'text-red-600 bg-red-100'],
        ['已完成', stats?.completed ?? 0, CheckCircle2, 'text-green-600 bg-green-100'],
      ] as const,
    [stats],
  );
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <>
      <div className="mb-6 flex justify-end">
        <Button
          variant="outline"
          size="sm"
          className="gap-1"
          onClick={() => setClearConfirmOpen(true)}
        >
          <Trash2 className="h-4 w-4" />
          清空已结束任务
        </Button>
        <Button variant="outline" size="sm" className="ml-2 gap-1" onClick={() => fetchData()}>
          <RefreshCw className="h-4 w-4" />
          刷新
        </Button>
      </div>
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {cards.map(([label, value, Icon, color]) => (
          <Card key={label}>
            <CardContent className="flex items-center gap-4 pt-6">
              <div className={`flex h-11 w-11 items-center justify-center rounded-lg ${color}`}>
                <Icon className="h-5 w-5" />
              </div>
              <div>
                <p className="text-2xl font-bold">{value}</p>
                <p className="text-sm text-muted-foreground">{label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="mb-4 flex flex-wrap gap-3">
        <Select
          value={status}
          onValueChange={(value) => {
            setStatus(value as IngestionJobStatus | 'all');
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="任务状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            {Object.values(IngestionJobStatus).map((value) => (
              <SelectItem key={value} value={value}>
                {STATUS_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={jobType}
          onValueChange={(value) => {
            setJobType(value as IngestionJobType | 'all');
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="任务类型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类型</SelectItem>
            {Object.values(IngestionJobType).map((value) => (
              <SelectItem key={value} value={value}>
                {TYPE_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <DataTable
        columns={columns}
        data={jobs}
        loading={loading}
        error={error}
        onRetry={() => void fetchData()}
        emptyTitle="暂无导入任务"
        emptyDescription="添加链接或同步来源后，后台任务将在这里显示"
        keyExtractor={(job) => job.id}
      />
      {total > 0 && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
          <span>共 {total} 个任务</span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1}
              onClick={() => setPage((value) => value - 1)}
            >
              上一页
            </Button>
            <span>
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page === totalPages}
              onClick={() => setPage((value) => value + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="删除任务记录"
        description={`确定要删除这条"${deleteTarget ? TYPE_LABELS[deleteTarget.jobType] : ''}"任务记录吗？此操作不可撤销。`}
        variant="destructive"
        confirmLabel="删除"
        onConfirm={() => {
          if (deleteTarget) void remove(deleteTarget);
        }}
      />
      <ConfirmDialog
        open={clearConfirmOpen}
        onOpenChange={setClearConfirmOpen}
        title="清空已结束任务"
        description="确定要删除所有已结束（已完成 / 失败 / 已取消）的任务记录吗？处理中和待处理的任务不受影响。此操作不可撤销。"
        variant="destructive"
        confirmLabel="清空"
        onConfirm={clear}
      />
    </>
  );
}
