'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  FolderOpen,
  Upload,
  AlertTriangle,
  ArrowRight,
  Database,
  ExternalLink,
  Globe,
  Clock,
  RotateCcw,
} from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { LoadingState } from '@/components/shared/loading-state';
import { ErrorState } from '@/components/shared/error-state';
import { ResourceTypeIcon } from '@/components/shared/resource-type-icon';
import { ResourceTypeBadge } from '@/components/shared/resource-type-badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { listResources } from '@/lib/api/resources';
import { retryJob } from '@/lib/api/processing';
import { getDashboardOverview } from '@/lib/api/stats';
import { formatByteString, formatDateTime } from '@/lib/format';
import { RESOURCE_TYPE_LABELS } from '@/lib/constants';
import type { DashboardOverview, ResourceListItem } from '@/lib/types';

export default function DashboardPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resources, setResources] = useState<ResourceListItem[]>([]);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [resData, dashboardOverview] = await Promise.all([
        listResources({ pageSize: 5, sortBy: 'createdAt', sortOrder: 'desc' }),
        getDashboardOverview(),
      ]);
      setResources(resData.items);
      setOverview(dashboardOverview);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
      toast.error('仪表盘数据加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  if (loading) {
    return (
      <div>
        <PageHeader title="仪表盘" description="资源库概览" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardContent className="flex items-center gap-4 pt-6">
                <Skeleton className="h-12 w-12 rounded-lg" />
                <div className="flex-1">
                  <Skeleton className="h-8 w-12 mb-1" />
                  <Skeleton className="h-5 w-16" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        <LoadingState variant="table" count={5} />
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <PageHeader title="仪表盘" description="资源库概览" />
        <ErrorState message={error} onRetry={fetchData} />
      </div>
    );
  }

  const visibleTypeStats =
    overview?.resourceTypes.filter((item) => item.count > 0).slice(0, 6) ?? [];
  const recentFailedJobs = overview?.recentFailedJobs ?? [];
  const trashStorageBytes = overview?.trashStorageBytes ?? '0';
  // trashStorageBytes 是可释放量：回收站里的文件若仍被正常资源共用则为 0，此时不展示
  const hasReclaimableTrash = trashStorageBytes !== '0';

  const handleRetryJob = async (jobId: string) => {
    try {
      await retryJob(jobId);
      toast.success('任务已重新排队');
      await fetchData();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '重试失败');
    }
  };

  return (
    <div>
      <PageHeader title="仪表盘" description="资源库概览">
        <Button asChild size="sm" className="gap-1">
          <Link href="/upload">
            <Upload className="h-4 w-4" />
            上传资源
          </Link>
        </Button>
      </PageHeader>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="flex items-center gap-4 pt-6">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-blue-100">
              <FolderOpen className="h-6 w-6 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{overview?.resourceTotal ?? 0}</p>
              <p className="text-sm text-muted-foreground">资源总数</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-4 pt-6">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-amber-100">
              <Database className="h-6 w-6 text-amber-600" />
            </div>
            <div title="按已登记的资源文件去重统计，包含回收站中尚未清理的文件">
              <p className="text-2xl font-bold">
                {formatByteString(overview?.totalStorageBytes ?? '0')}
              </p>
              <p className="text-sm text-muted-foreground">存储占用</p>
              {hasReclaimableTrash && (
                <p className="text-xs text-muted-foreground">
                  其中回收站可释放 {formatByteString(trashStorageBytes)}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-4 pt-6">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-violet-100">
              <Clock className="h-6 w-6 text-violet-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">
                {(overview?.processingStats.pending ?? 0) +
                  (overview?.processingStats.processing ?? 0)}
              </p>
              <p className="text-sm text-muted-foreground">进行中任务</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-4 pt-6">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-red-100">
              <AlertTriangle className="h-6 w-6 text-red-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{overview?.processingStats.failed ?? 0}</p>
              <p className="text-sm text-muted-foreground">处理失败</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          {/* 最近上传 */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">最近上传</CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/resources?scope=all" className="gap-1">
                  查看全部
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              {resources.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  暂无资源，开始上传您的第一个文件
                </p>
              ) : (
                <div className="space-y-2">
                  {resources.map((r) => (
                    <Link
                      key={r.id}
                      href={`/resources/${r.id}`}
                      className="flex items-center gap-3 rounded-md px-3 py-2 transition-colors hover:bg-muted"
                    >
                      {r.acquisitionMode === 'link_only' ? (
                        <ExternalLink className="h-8 w-8 text-primary" />
                      ) : r.acquisitionMode === 'metadata_only' ? (
                        <Globe className="h-8 w-8 text-blue-500" />
                      ) : (
                        <ResourceTypeIcon
                          type={r.resourceType}
                          className="h-8 w-8 text-muted-foreground"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {r.title || r.originalFilename}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {r.acquisitionMode === 'link_only' ? (
                            '链接'
                          ) : r.acquisitionMode === 'metadata_only' ? (
                            <span
                              className={r.downloadError ? 'text-destructive' : undefined}
                              title={r.downloadError ?? '尚未下载到本地'}
                            >
                              {r.downloadError ? '下载失败' : '待下载'}
                            </span>
                          ) : (
                            formatByteString(r.sizeBytes)
                          )}{' '}
                          · {formatDateTime(r.createdAt)}
                        </p>
                      </div>
                      <ResourceTypeBadge type={r.resourceType} />
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">最近失败任务</CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/imports?tab=processing&status=failed" className="gap-1">
                  查看全部
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              {recentFailedJobs.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">暂无失败任务</p>
              ) : (
                <div className="space-y-2">
                  {recentFailedJobs.map((job) => (
                    <div
                      key={job.id}
                      className="flex items-center gap-3 rounded-md px-3 py-2 transition-colors hover:bg-muted"
                    >
                      <AlertTriangle className="h-5 w-5 shrink-0 text-red-600" />
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/resources/${job.resourceId}`}
                          className="truncate text-sm font-medium hover:text-primary"
                        >
                          {job.resource.title || job.resource.originalFilename}
                        </Link>
                        <p className="truncate text-xs text-muted-foreground">
                          {job.jobType} · {job.errorMessage || '未记录错误'} ·{' '}
                          {formatDateTime(job.updatedAt)}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1"
                        onClick={() => handleRetryJob(job.id)}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        重试
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          {/* 资源类型概览 */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">资源类型概览</CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/resources?scope=all" className="gap-1">
                  筛选
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              {visibleTypeStats.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">暂无资源类型数据</p>
              ) : (
                <div className="space-y-4">
                  {visibleTypeStats.map((item) => (
                    <Link
                      key={item.type}
                      href={`/resources?scope=all&resourceType=${item.type}`}
                      className="block rounded-md transition-colors hover:bg-muted/70"
                    >
                      <div className="space-y-2 px-2 py-1.5">
                        <div className="flex items-center gap-3">
                          <ResourceTypeIcon
                            type={item.type}
                            className="h-5 w-5 shrink-0 text-muted-foreground"
                          />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {RESOURCE_TYPE_LABELS[item.type] ?? item.type}
                          </span>
                          <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                            {item.count} · {item.percentage}%
                          </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${item.percentage}%` }}
                          />
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
