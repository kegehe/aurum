'use client';

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Undo2, Trash2, RotateCcw, ExternalLink } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { ResourceTypeIcon } from '@/components/shared/resource-type-icon';
import { ResourceTypeBadge } from '@/components/shared/resource-type-badge';
import { Button } from '@/components/ui/button';
import { emptyTrash, listResources, permanentDeleteResource, restoreResource } from '@/lib/api/resources';
import { formatByteString, formatDateTime } from '@/lib/format';
import type { ResourceListItem } from '@/lib/types';

export default function TrashPage() {
  const [resources, setResources] = useState<ResourceListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<ResourceListItem | null>(null);
  const [emptyConfirmOpen, setEmptyConfirmOpen] = useState(false);

  const fetchTrash = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listResources({ includeDeleted: true, pageSize: 100 });
      const trashedResources = data.items.filter((r) => r.deletedAt !== null);
      const trashedIds = new Set(trashedResources.map((resource) => resource.id));
      setResources(trashedResources);
      setSelectedIds((prev) => new Set([...prev].filter((id) => trashedIds.has(id))));
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTrash(); }, [fetchTrash]);

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
      await fetchTrash();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '清空回收站失败');
    }
  };

  const handleBatchRestore = async () => {
    let count = 0;
    for (const id of selectedIds) {
      try {
        await restoreResource(id);
        count++;
      } catch { /* skip failures */ }
    }
    toast.success(`已恢复 ${count} 个资源`);
    setSelectedIds(new Set());
    await fetchTrash();
  };

  const columns: Column<ResourceListItem>[] = [
    {
      key: 'title',
      header: '资源名称',
      render: (r) => (
        <div className="flex items-center gap-2">
          {r.acquisitionMode === 'link_only' ? (
            <ExternalLink className="h-5 w-5 text-primary" />
          ) : (
            <ResourceTypeIcon type={r.resourceType} className="h-5 w-5 text-muted-foreground" />
          )}
          <span className="font-medium">{r.title || r.originalFilename}</span>
        </div>
      ),
    },
    {
      key: 'resourceType',
      header: '类型',
      className: 'w-24',
      render: (r) => <ResourceTypeBadge type={r.resourceType} />,
    },
    {
      key: 'sizeBytes',
      header: '大小',
      className: 'w-20 text-right',
      render: (r) => (
        <span className="text-muted-foreground">{r.acquisitionMode === 'link_only' ? '链接' : formatByteString(r.sizeBytes)}</span>
      ),
    },
    {
      key: 'deletedAt',
      header: '删除时间',
      className: 'w-44',
      render: (r) => (
        <span className="text-muted-foreground">{r.deletedAt ? formatDateTime(r.deletedAt) : '-'}</span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      className: 'w-28 text-right',
      render: (r) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => handleRestore(r.id)}>
            <Undo2 className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(r)}>
            <Trash2 className="h-3 w-3 text-destructive" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="回收站" description="已删除的资源">
        <div className="flex flex-wrap gap-2">
          {selectedIds.size > 0 && (
            <Button variant="outline" size="sm" className="gap-1" onClick={handleBatchRestore}>
              <RotateCcw className="h-4 w-4" />
              批量恢复 ({selectedIds.size})
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

      <DataTable
        columns={columns}
        data={resources}
        loading={loading}
        error={error ?? undefined}
        onRetry={fetchTrash}
        emptyTitle="回收站为空"
        emptyDescription="删除的资源将在这里显示"
        keyExtractor={(r) => r.id}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}
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
