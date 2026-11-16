'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { Trash2, RotateCcw } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { ResourceGrid } from '@/components/shared/resource-grid';
import { LoadingState } from '@/components/shared/loading-state';
import { ErrorState } from '@/components/shared/error-state';
import { EmptyState } from '@/components/shared/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  emptyTrashStream,
  getTrashStats,
  listResources,
  permanentDeleteResource,
  restoreResource,
  batchRestoreResources,
} from '@/lib/api/resources';
import { formatByteString, formatNumber } from '@/lib/format';
import type { EmptyTrashProgress, ResourceListItem, TrashStats } from '@/lib/types';

const PAGE_SIZE = 100;

export default function TrashPage() {
  const [resources, setResources] = useState<ResourceListItem[]>([]);
  const [stats, setStats] = useState<TrashStats | null>(null);
  const [loading, setLoading] = useState(true);
  // 翻页时保留旧列表，避免整块骨架卸载导致滚动位置丢失
  const [refreshing, setRefreshing] = useState(false);
  const loadedOnceRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [restoring, setRestoring] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ResourceListItem | null>(null);
  const [emptyConfirmOpen, setEmptyConfirmOpen] = useState(false);
  const [emptying, setEmptying] = useState(false);
  const [emptyProgress, setEmptyProgress] = useState<EmptyTrashProgress | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);

  /** 请求序号：用于丢弃过期响应，避免快速翻页/操作后旧数据覆盖新数据 */
  const requestSeqRef = useRef(0);

  /** 清空进行中的同步标记：state 更新是异步的，双击可能在重渲染前发出第二个请求 */
  const emptyingRef = useRef(false);

  /** 进度更新节流时间戳：服务端按资源逐条推送（回收站可能有上千条），每条都 setState 会带动整页重渲染 */
  const lastProgressAtRef = useRef(0);

  /** silent=true：操作成功后的补偿刷新，保留当前列表，避免列表卸载导致滚动位置回到顶部 */
  const fetchTrash = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      const seq = ++requestSeqRef.current;
      if (!silent) {
        if (loadedOnceRef.current) setRefreshing(true);
        else setLoading(true);
        setError(null);
      }
      let redirecting = false;
      try {
        // 统计与列表并行拉取：统计失败不影响列表展示，仅保留旧值
        const [data, statsData] = await Promise.all([
          listResources({ deletedOnly: true, page, pageSize: PAGE_SIZE }),
          getTrashStats().catch(() => null),
        ]);
        if (seq !== requestSeqRef.current) return;
        if (statsData) setStats(statsData);
        // 当前页越界（如删除了最后一页的唯一一项）时回退到最后一页
        if (data.items.length === 0 && data.total > 0 && page > data.totalPages) {
          redirecting = true;
          setPage(data.totalPages);
          return;
        }
        setResources(data.items);
        setTotal(data.total);
        setTotalPages(data.totalPages);
        loadedOnceRef.current = true;
      } catch (e) {
        if (seq !== requestSeqRef.current) return;
        if (!silent) setError(e instanceof Error ? e.message : '加载失败');
      } finally {
        // 正在回退页码时不结束 loading，避免旧页数据一闪而过；由回退后的新请求负责收尾
        if (!redirecting && seq === requestSeqRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [page],
  );

  useEffect(() => {
    fetchTrash();
  }, [fetchTrash]);

  const handleRestore = useCallback(
    async (id: string) => {
      try {
        await restoreResource(id);
        toast.success('资源已恢复');
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        // 先本地移除再静默刷新，滚动位置不丢
        setResources((prev) => prev.filter((item) => item.id !== id));
        setTotal((prev) => Math.max(0, prev - 1));
        await fetchTrash({ silent: true });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '恢复失败');
      }
    },
    [fetchTrash],
  );

  // 传给卡片的回调必须稳定，否则 selectedIds 一变 100 张卡片全部重渲染。
  const handleCardDelete = useCallback(
    (id: string) => {
      const target = resources.find((item) => item.id === id);
      if (target) setDeleteTarget(target);
    },
    [resources],
  );

  const handlePermanentDelete = async () => {
    if (!deleteTarget) return;
    try {
      const result = await permanentDeleteResource(deleteTarget.id);
      if (result.deleted) {
        toast.success(`已彻底删除资源，清理 ${result.deletedFiles} 个文件`);
      } else {
        // 并发恢复 / 已被另一个请求删除：没有动它的磁盘文件
        toast.info('该资源已被恢复或删除，无需再次清理');
      }
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(deleteTarget.id);
        return next;
      });
      setResources((prev) => prev.filter((item) => item.id !== deleteTarget.id));
      setTotal((prev) => Math.max(0, prev - 1));
      setDeleteTarget(null);
      await fetchTrash({ silent: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '彻底删除失败');
    }
  };

  /**
   * 进度事件节流：最多约 8 帧/秒。
   * 列表与卡片虽然 memo 过，但回调 props 每次渲染都是新引用，
   * 因此每条进度都 setState 会让整页（最多 100 张卡片）跟着重渲染。
   */
  const handleProgress = (progress: EmptyTrashProgress) => {
    const now = Date.now();
    const isFinal = progress.processedResources >= progress.totalResources;
    if (!isFinal && now - lastProgressAtRef.current < 120) return;
    lastProgressAtRef.current = now;
    setEmptyProgress(progress);
  };

  /**
   * 清空回收站：通过 SSE 逐条接收进度，期间展示进度弹窗。
   * 删除不可撤销，弹窗不可关闭；结束后统一提示资源/文件数量。
   */
  const handleEmptyTrash = async () => {
    if (emptyingRef.current) return;
    emptyingRef.current = true;
    setEmptyConfirmOpen(false);
    setSelectedIds(new Set());
    setEmptyProgress(null);
    lastProgressAtRef.current = 0;
    setEmptying(true);
    try {
      const result = await emptyTrashStream({ onProgress: handleProgress });
      const parts = [`${result.deletedResources} 个资源`, `${result.deletedFiles} 个文件`];
      if (result.skippedResources > 0) {
        parts.push(`${result.skippedResources} 个资源已被恢复或删除`);
      }
      toast.success(`已清空回收站：删除 ${parts.join('、')}`);
      setStats({ resourceCount: 0, fileCount: 0, totalSizeBytes: '0' });
      // 使在途请求失效并直接置空列表，避免旧分页数据覆盖空结果；page 回到第 1 页（若已在第 1 页则无需重新拉取）。
      // 必须同时结束 loading：被失效的在途请求会在 finally 中跳过 setLoading(false)，而 page 未变化时不会有新请求接手。
      requestSeqRef.current++;
      setLoading(false);
      setPage(1);
      setResources([]);
      setTotal(0);
      setTotalPages(0);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '清空回收站失败');
      // 可能已删除部分资源：静默刷新列表与统计，保证页面与磁盘一致
      await fetchTrash({ silent: true });
    } finally {
      emptyingRef.current = false;
      setEmptying(false);
      setEmptyProgress(null);
    }
  };

  const handleBatchRestore = async () => {
    // 防止快速双击/重复点击：第二次请求会因资源已被恢复而误报"恢复失败"
    if (restoring) return;
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setRestoring(true);
    try {
      const result = await batchRestoreResources(ids);
      // 恢复成功的从选中中移除；失败项保留选中，便于用户定位/重试
      const failedSet = new Set(result.failedResourceIds);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) {
          if (!failedSet.has(id)) next.delete(id);
        }
        return next;
      });
      if (result.failed > 0) {
        if (result.restored === 0) {
          toast.error(`批量恢复失败：${result.failed} 个资源未恢复（已保留选中）`);
        } else {
          toast.warning(
            `已恢复 ${result.restored} 个资源，${result.failed} 个恢复失败（已保留选中）`,
          );
        }
      } else {
        toast.success(`已恢复 ${result.restored} 个资源`);
      }
      await fetchTrash();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '批量恢复失败');
    } finally {
      setRestoring(false);
    }
  };

  const emptyPercent =
    emptyProgress && emptyProgress.totalResources > 0
      ? Math.min(
          100,
          Math.round((emptyProgress.processedResources / emptyProgress.totalResources) * 100),
        )
      : 0;

  const emptyConfirmDescription = stats
    ? `将彻底删除 ${stats.resourceCount} 个资源、${stats.fileCount} 个文件（可释放 ${formatByteString(
        stats.totalSizeBytes,
      )}），此操作不可撤销。`
    : '确定要彻底删除回收站中的所有资源吗？此操作不可撤销。';

  return (
    <div>
      <PageHeader title="回收站" description="已删除的资源">
        <div className="flex flex-wrap gap-2">
          {selectedIds.size > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={handleBatchRestore}
              disabled={restoring || emptying}
            >
              <RotateCcw className="h-4 w-4" />
              {restoring ? '恢复中…' : `批量恢复 (${selectedIds.size})`}
            </Button>
          )}
          {(stats?.resourceCount ?? total) > 0 && (
            <Button
              variant="destructive"
              size="sm"
              className="gap-1"
              onClick={() => setEmptyConfirmOpen(true)}
              disabled={emptying}
            >
              <Trash2 className="h-4 w-4" />
              清空回收站
            </Button>
          )}
        </div>
      </PageHeader>

      {/* 回收站统计：可回收文件已按磁盘文件去重，仍被正常资源引用的不计入 */}
      {stats && stats.resourceCount > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          <span>
            共{' '}
            <span className="font-medium text-foreground">{formatNumber(stats.resourceCount)}</span>{' '}
            个资源
          </span>
          <span>
            <span className="font-medium text-foreground">{formatNumber(stats.fileCount)}</span>{' '}
            个可回收文件
          </span>
          <span>
            可释放{' '}
            <span className="font-medium text-foreground">
              {formatByteString(stats.totalSizeBytes)}
            </span>
          </span>
        </div>
      )}

      {/* 加载/错误/列表：回收站的已删除资源不可再跳转详情，故固定为卡片视图。
          点击卡片仅用于多选，右上角提供"恢复 / 彻底删除"操作。 */}
      {loading ? (
        <LoadingState variant="card" count={8} />
      ) : error && resources.length === 0 ? (
        <ErrorState message={error} onRetry={() => void fetchTrash()} />
      ) : resources.length === 0 && refreshing ? (
        <LoadingState variant="card" count={8} />
      ) : resources.length === 0 ? (
        <EmptyState title="回收站为空" description="删除的资源将在这里显示" />
      ) : (
        <div className="relative" aria-busy={refreshing}>
          {error && (
            <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              回收站刷新失败：{error}
            </div>
          )}
          {/* 进度条绝对定位，避免刷新时把列表整体下推造成抖动 */}
          {refreshing && (
            <div
              className="pointer-events-none absolute -top-2 left-0 right-0 z-10 h-0.5 overflow-hidden rounded bg-primary/10"
              role="progressbar"
              aria-label="正在更新回收站列表"
            >
              <div className="h-full w-1/3 animate-pulse rounded bg-primary/70" />
            </div>
          )}
          <ResourceGrid
            resources={resources}
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
            selectMode
            onRestore={handleRestore}
            onDelete={handleCardDelete}
          />
        </div>
      )}

      {/* 分页：回收站数量超过一页时可翻页访问全部记录 */}
      {totalPages > 1 && !loading && (
        <div className="mt-4 flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            上一页
          </Button>
          <span className="text-sm text-muted-foreground">
            {page} / {totalPages}（共 {total} 项）
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null);
        }}
        title="彻底删除"
        description={`确定要彻底删除 "${deleteTarget?.title || deleteTarget?.originalFilename}" 吗？此操作不可撤销。`}
        variant="destructive"
        confirmLabel="彻底删除"
        onConfirm={handlePermanentDelete}
      />

      <ConfirmDialog
        open={emptyConfirmOpen}
        onOpenChange={setEmptyConfirmOpen}
        title="清空回收站"
        description={emptyConfirmDescription}
        variant="destructive"
        confirmLabel="清空回收站"
        onConfirm={handleEmptyTrash}
      />

      {/* 清空进度：删除期间不可关闭，避免用户误以为操作已中止 */}
      <Dialog open={emptying}>
        <DialogContent
          className="[&>button]:hidden"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>正在清空回收站</DialogTitle>
            <DialogDescription>正在删除资源与磁盘文件，请勿关闭页面。</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                role="progressbar"
                aria-label="清空回收站进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={emptyPercent}
                className="h-full bg-destructive transition-[width] duration-200"
                style={{ width: `${emptyPercent}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {emptyProgress
                  ? `已处理 ${emptyProgress.processedResources} / ${emptyProgress.totalResources} 个资源`
                  : '正在统计待删除资源…'}
              </span>
              <span>{emptyPercent}%</span>
            </div>
            <p className="text-sm text-muted-foreground">
              {emptyProgress
                ? `已删除 ${emptyProgress.deletedResources} 个资源、${emptyProgress.deletedFiles} 个文件`
                : `共 ${stats?.resourceCount ?? 0} 个资源、${stats?.fileCount ?? 0} 个文件等待清理`}
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
