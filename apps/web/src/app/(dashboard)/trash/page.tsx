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
import { Button } from '@/components/ui/button';
import {
  emptyTrash,
  listResources,
  permanentDeleteResource,
  restoreResource,
  batchRestoreResources,
} from '@/lib/api/resources';
import type { ResourceListItem } from '@/lib/types';

const PAGE_SIZE = 100;

export default function TrashPage() {
  const [resources, setResources] = useState<ResourceListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [restoring, setRestoring] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ResourceListItem | null>(null);
  const [emptyConfirmOpen, setEmptyConfirmOpen] = useState(false);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);

  /** 请求序号：用于丢弃过期响应，避免快速翻页/操作后旧数据覆盖新数据 */
  const requestSeqRef = useRef(0);

  const fetchTrash = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    let redirecting = false;
    try {
      const data = await listResources({ deletedOnly: true, page, pageSize: PAGE_SIZE });
      if (seq !== requestSeqRef.current) return;
      // 当前页越界（如删除了最后一页的唯一一项）时回退到最后一页
      if (data.items.length === 0 && data.total > 0 && page > data.totalPages) {
        redirecting = true;
        setPage(data.totalPages);
        return;
      }
      setResources(data.items);
      setTotal(data.total);
      setTotalPages(data.totalPages);
    } catch (e) {
      if (seq !== requestSeqRef.current) return;
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      // 正在回退页码时不结束 loading，避免旧页数据一闪而过；由回退后的新请求负责收尾
      if (!redirecting && seq === requestSeqRef.current) setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    fetchTrash();
  }, [fetchTrash]);

  const handleRestore = async (id: string) => {
    try {
      await restoreResource(id);
      toast.success('资源已恢复');
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await fetchTrash();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '恢复失败');
    }
  };

  const handlePermanentDelete = async () => {
    if (!deleteTarget) return;
    try {
      const result = await permanentDeleteResource(deleteTarget.id);
      toast.success(`已彻底删除资源，清理 ${result.deletedFiles} 个文件`);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(deleteTarget.id);
        return next;
      });
      setDeleteTarget(null);
      await fetchTrash();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '彻底删除失败');
    }
  };

  const handleEmptyTrash = async () => {
    try {
      const result = await emptyTrash();
      toast.success(`已清空回收站，删除 ${result.deletedResources} 个资源`);
      setSelectedIds(new Set());
      setEmptyConfirmOpen(false);
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
              disabled={restoring}
            >
              <RotateCcw className="h-4 w-4" />
              {restoring ? '恢复中…' : `批量恢复 (${selectedIds.size})`}
            </Button>
          )}
          {resources.length > 0 && (
            <Button
              variant="destructive"
              size="sm"
              className="gap-1"
              onClick={() => setEmptyConfirmOpen(true)}
            >
              <Trash2 className="h-4 w-4" />
              清空回收站
            </Button>
          )}
        </div>
      </PageHeader>

      {/* 加载/错误/列表：回收站的已删除资源不可再跳转详情，故固定为卡片视图。
          点击卡片仅用于多选，右上角提供“恢复 / 彻底删除”操作。 */}
      {loading ? (
        <LoadingState variant="card" count={8} />
      ) : error ? (
        <ErrorState message={error} onRetry={fetchTrash} />
      ) : resources.length === 0 ? (
        <EmptyState title="回收站为空" description="删除的资源将在这里显示" />
      ) : (
        <ResourceGrid
          resources={resources}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          selectMode
          onRestore={handleRestore}
          onDelete={(id) => {
            const target = resources.find((r) => r.id === id);
            if (target) setDeleteTarget(target);
          }}
        />
      )}

      {/* 分页：回收站数量超过一页时可翻页访问全部记录 */}
      {totalPages > 1 && !loading && !error && (
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
        description="确定要彻底删除回收站中的所有资源吗？此操作不可撤销。"
        variant="destructive"
        confirmLabel="清空回收站"
        onConfirm={handleEmptyTrash}
      />
    </div>
  );
}
