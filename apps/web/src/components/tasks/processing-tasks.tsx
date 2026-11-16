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
  Trash2,
  XCircle,
} from 'lucide-react';
import { JobStatus, JobType } from '@aurum/shared-types';
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
  cancelProcessingJob,
  clearProcessingJobs,
  deleteProcessingJob,
  getProcessingStats,
  listProcessingJobs,
  retryJob,
} from '@/lib/api/processing';
import { formatDateTime } from '@/lib/format';
import type { ProcessingJobItem, ProcessingJobStats } from '@/lib/types';

const STATUS_LABELS: Record<JobStatus, string> = {
  pending: '待处理',
  processing: '处理中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
};
const TYPE_LABELS: Record<JobType, string> = {
  detect_metadata: '识别元数据',
  generate_thumbnail: '生成缩略图',
  generate_video_cover: '生成视频封面',
  extract_text: '提取文本',
  detect_duplicate: '检测重复',
  cleanup_files: '清理文件',
  cleanup_temp: '清理临时文件',
};
const statusVariant = (status: JobStatus) =>
  status === 'completed'
    ? 'success'
    : status === 'failed'
      ? 'destructive'
      : status === 'processing'
        ? 'warning'
        : 'secondary';

export default function ProcessingTasks({ active = true }: { active?: boolean }) {
  const searchParams = useSearchParams();
  const statusFromUrl = useMemo(() => {
    const value = searchParams.get('status');
    return Object.values(JobStatus).includes(value as JobStatus) ? (value as JobStatus) : 'all';
  }, [searchParams]);
  const [jobs, setJobs] = useState<ProcessingJobItem[]>([]);
  const [stats, setStats] = useState<ProcessingJobStats | null>(null);
  const [status, setStatus] = useState<JobStatus | 'all'>(statusFromUrl);
  const [jobType, setJobType] = useState<JobType | 'all'>('all');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<ProcessingJobItem | null>(null);
  const [cancelTarget, setCancelTarget] = useState<ProcessingJobItem | null>(null);
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
          listProcessingJobs({
            page,
            pageSize,
            status: status === 'all' ? undefined : status,
            jobType: jobType === 'all' ? undefined : jobType,
          }),
          getProcessingStats(),
        ]);
        // 清空/删除让总数变少后，当前页码可能越界：这一页会查不到任何数据，
        // 若 total 同时归零，分页栏也会一起消失，界面就卡在一个假的空页上。
        // 先回到最后一个有效页，由 page 变化触发的 effect 重新拉取。
        setTotal(result.total);
        setStats(nextStats);
        setError(undefined);
        const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
        if (page > lastPage) {
          // 保持 loading，避免在重新拉取前闪一帧刚被删掉的旧数据
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
      hasActiveJobs ? 1000 : 15000,
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
    async (job: ProcessingJobItem) => {
      try {
        await retryJob(job.id);
        toast.success('任务已重新排队');
        await fetchData();
      } catch (reason) {
        toast.error(reason instanceof Error ? reason.message : '重试失败');
      }
    },
    [fetchData],
  );
  const remove = async (job: ProcessingJobItem) => {
    try {
      await deleteProcessingJob(job.id);
      toast.success('任务记录已删除');
      setDeleteTarget(null);
      await fetchData();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '删除任务记录失败');
    }
  };
  const cancel = useCallback(
    async (job: ProcessingJobItem) => {
      try {
        await cancelProcessingJob(job.id);
        toast.success('任务已取消，可重新排队或删除');
        setCancelTarget(null);
        await fetchData();
      } catch (reason) {
        toast.error(reason instanceof Error ? reason.message : '取消任务失败');
      }
    },
    [fetchData],
  );
  const clear = async () => {
    try {
      const result = await clearProcessingJobs();
      toast.success(`已清空 ${result.deleted} 条已结束的任务记录`);
      setClearConfirmOpen(false);
      await fetchData();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '清空任务记录失败');
    }
  };
  // columns 必须稳定：否则 tab 切换/轮询时 DataTable 的行级 memo 全部失效
  const columns: Column<ProcessingJobItem>[] = useMemo(
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
          <Badge variant={statusVariant(job.status)} className="gap-1">
            {job.status === 'processing' && <Loader2 className="h-3 w-3 animate-spin" />}
            {STATUS_LABELS[job.status]}
          </Badge>
        ),
      },
      {
        key: 'retryCount',
        header: '重试',
        className: 'w-20 text-right',
        render: (job) => job.retryCount,
      },
      {
        key: 'resource',
        header: '资源',
        className: 'w-44',
        render: (job) => (
          <Link
            className="font-mono text-xs text-primary hover:underline"
            href={`/resources/${job.resourceId}`}
          >
            {job.resourceId.slice(0, 8)}
          </Link>
        ),
      },
      {
        key: 'error',
        header: '错误',
        render: (job) => (
          <span className="line-clamp-1 text-muted-foreground">{job.errorMessage || '-'}</span>
        ),
      },
      {
        key: 'updatedAt',
        header: '更新时间',
        className: 'w-44',
        render: (job) => (
          <span className="text-muted-foreground">{formatDateTime(job.updatedAt)}</span>
        ),
      },
      {
        key: 'actions',
        header: '操作',
        className: 'w-40 text-right',
        render: (job) => (
          <div className="flex justify-end gap-1">
            {job.status === 'pending' || job.status === 'processing' ? (
              <Button
                variant="ghost"
                size="sm"
                title="取消任务（卡住时可从这里恢复）"
                onClick={() => setCancelTarget(job)}
              >
                <XCircle className="h-4 w-4" />
              </Button>
            ) : null}
            {job.status === 'failed' || job.status === 'canceled' ? (
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
            setStatus(value as JobStatus | 'all');
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="任务状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            {Object.values(JobStatus).map((value) => (
              <SelectItem key={value} value={value}>
                {STATUS_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={jobType}
          onValueChange={(value) => {
            setJobType(value as JobType | 'all');
            setPage(1);
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="任务类型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类型</SelectItem>
            {Object.values(JobType).map((value) => (
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
        emptyTitle="暂无处理任务"
        emptyDescription="上传文件后，处理任务将在这里显示"
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
        open={!!cancelTarget}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null);
        }}
        title="取消任务"
        description={`确定要取消这条"${cancelTarget ? TYPE_LABELS[cancelTarget.jobType] : ''}"任务吗？任务会标记为已取消，之后可以重新排队或删除记录。`}
        variant="destructive"
        confirmLabel="确认取消"
        onConfirm={() => {
          if (cancelTarget) void cancel(cancelTarget);
        }}
      />
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
