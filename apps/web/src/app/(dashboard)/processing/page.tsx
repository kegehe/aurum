'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, Clock, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { JobStatus, JobType } from '@resource-service/shared-types';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { getProcessingStats, listProcessingJobs, retryJob } from '@/lib/api/processing';
import { formatDateTime } from '@/lib/format';
import type { ProcessingJobItem, ProcessingJobStats } from '@/lib/types';

const STATUS_LABELS: Record<JobStatus, string> = {
  [JobStatus.pending]: '待处理',
  [JobStatus.processing]: '处理中',
  [JobStatus.completed]: '已完成',
  [JobStatus.failed]: '失败',
  [JobStatus.canceled]: '已取消',
};

const JOB_TYPE_LABELS: Record<JobType, string> = {
  [JobType.detect_metadata]: '识别元数据',
  [JobType.generate_thumbnail]: '生成缩略图',
  [JobType.generate_video_cover]: '生成视频封面',
  [JobType.extract_text]: '提取文本',
  [JobType.detect_duplicate]: '检测重复',
  [JobType.cleanup_files]: '清理文件',
  [JobType.cleanup_temp]: '清理临时文件',
};

function statusVariant(status: JobStatus) {
  if (status === JobStatus.completed) return 'success';
  if (status === JobStatus.failed) return 'destructive';
  if (status === JobStatus.processing) return 'warning';
  return 'secondary';
}

export default function ProcessingPage() {
  const searchParams = useSearchParams();
  const statusFromUrl = useMemo(() => {
    const value = searchParams.get('status');
    return Object.values(JobStatus).includes(value as JobStatus) ? (value as JobStatus) : 'all';
  }, [searchParams]);
  const [jobs, setJobs] = useState<ProcessingJobItem[]>([]);
  const [stats, setStats] = useState<ProcessingJobStats | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatus | 'all'>(statusFromUrl);
  const [jobType, setJobType] = useState<JobType | 'all'>('all');
  const pageSize = 20;

  useEffect(() => {
    setStatus(statusFromUrl);
    setPage(1);
  }, [statusFromUrl]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [jobData, statsData] = await Promise.all([
        listProcessingJobs({
          page,
          pageSize,
          status: status === 'all' ? undefined : status,
          jobType: jobType === 'all' ? undefined : jobType,
        }),
        getProcessingStats(),
      ]);
      setJobs(jobData.items);
      setTotal(jobData.total);
      setStats(statsData);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [jobType, page, status]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const handleRetry = async (job: ProcessingJobItem) => {
    try {
      await retryJob(job.id);
      toast.success('任务已重新排队');
      await fetchData();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '重试失败');
    }
  };

  const statCards = useMemo(
    () => [
      { label: '待处理', value: stats?.pending ?? 0, icon: Clock, className: 'text-amber-600 bg-amber-100' },
      { label: '处理中', value: stats?.processing ?? 0, icon: Loader2, className: 'text-blue-600 bg-blue-100' },
      { label: '失败', value: stats?.failed ?? 0, icon: AlertTriangle, className: 'text-red-600 bg-red-100' },
      { label: '已完成', value: stats?.completed ?? 0, icon: CheckCircle2, className: 'text-green-600 bg-green-100' },
    ],
    [stats],
  );

  const columns: Column<ProcessingJobItem>[] = [
    {
      key: 'jobType',
      header: '任务类型',
      render: (job) => <span className="font-medium">{JOB_TYPE_LABELS[job.jobType] ?? job.jobType}</span>,
    },
    {
      key: 'status',
      header: '状态',
      className: 'w-28',
      render: (job) => (
        <Badge variant={statusVariant(job.status)}>{STATUS_LABELS[job.status] ?? job.status}</Badge>
      ),
    },
    {
      key: 'retryCount',
      header: '重试',
      className: 'w-20 text-right',
      render: (job) => <span className="text-muted-foreground">{job.retryCount}</span>,
    },
    {
      key: 'resourceId',
      header: '资源',
      className: 'w-44',
      render: (job) => (
        <Link className="font-mono text-xs text-primary hover:underline" href={`/resources/${job.resourceId}`}>
          {job.resourceId.slice(0, 8)}
        </Link>
      ),
    },
    {
      key: 'errorMessage',
      header: '错误',
      render: (job) => (
        <span className="line-clamp-1 text-muted-foreground">{job.errorMessage || '-'}</span>
      ),
    },
    {
      key: 'updatedAt',
      header: '更新时间',
      className: 'w-44',
      render: (job) => <span className="text-muted-foreground">{formatDateTime(job.updatedAt)}</span>,
    },
    {
      key: 'actions',
      header: '操作',
      className: 'w-20 text-right',
      render: (job) =>
        job.status === JobStatus.failed || job.status === JobStatus.canceled ? (
          <Button variant="ghost" size="sm" onClick={() => handleRetry(job)}>
            <RotateCcw className="h-4 w-4" />
          </Button>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader title="处理任务" description="查看异步处理任务状态">
        <Button variant="outline" size="sm" className="gap-1" onClick={fetchData}>
          <RefreshCw className="h-4 w-4" />
          刷新
        </Button>
      </PageHeader>

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {statCards.map((card) => {
          const Icon = card.icon;
          return (
            <Card key={card.label}>
              <CardContent className="flex items-center gap-4 pt-6">
                <div className={`flex h-11 w-11 items-center justify-center rounded-lg ${card.className}`}>
                  <Icon className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{card.value}</p>
                  <p className="text-sm text-muted-foreground">{card.label}</p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={status} onValueChange={(value) => { setStatus(value as JobStatus | 'all'); setPage(1); }}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="任务状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            {Object.values(JobStatus).map((item) => (
              <SelectItem key={item} value={item}>{STATUS_LABELS[item]}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={jobType} onValueChange={(value) => { setJobType(value as JobType | 'all'); setPage(1); }}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="任务类型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类型</SelectItem>
            {Object.values(JobType).map((item) => (
              <SelectItem key={item} value={item}>{JOB_TYPE_LABELS[item]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        data={jobs}
        loading={loading}
        error={error ?? undefined}
        onRetry={fetchData}
        emptyTitle="暂无处理任务"
        emptyDescription="上传文件后，处理任务将在这里显示"
        keyExtractor={(job) => job.id}
      />

      {total > 0 && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
          <span>共 {total} 个任务</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              上一页
            </Button>
            <span>{page} / {totalPages}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
