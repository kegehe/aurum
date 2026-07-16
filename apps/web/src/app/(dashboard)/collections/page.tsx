'use client';

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Layers, FolderOpen } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { LoadingState } from '@/components/shared/loading-state';
import { ErrorState } from '@/components/shared/error-state';
import { EmptyState } from '@/components/shared/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ResourceTypeIcon } from '@/components/shared/resource-type-icon';
import {
  listCollections,
  createCollection,
  updateCollection,
  deleteCollection,
} from '@/lib/api/collections';
import type { CollectionItem } from '@/lib/types';

export default function CollectionsPage() {
  const [collections, setCollections] = useState<CollectionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCollection, setEditingCollection] = useState<CollectionItem | null>(null);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');

  // Delete
  const [deleteTarget, setDeleteTarget] = useState<CollectionItem | null>(null);

  const fetchCollections = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listCollections();
      setCollections(data.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchCollections(); }, [fetchCollections]);

  const openCreate = () => {
    setEditingCollection(null);
    setFormName('');
    setFormDescription('');
    setDialogOpen(true);
  };

  const openEdit = (col: CollectionItem) => {
    setEditingCollection(col);
    setFormName(col.name);
    setFormDescription(col.description ?? '');
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formName.trim()) return;
    try {
      if (editingCollection) {
        await updateCollection(editingCollection.id, { name: formName.trim(), description: formDescription || undefined });
        toast.success('集合已更新');
      } else {
        await createCollection({ name: formName.trim(), description: formDescription || undefined });
        toast.success('集合已创建');
      }
      setDialogOpen(false);
      await fetchCollections();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteCollection(deleteTarget.id);
      toast.success(`已删除集合 "${deleteTarget.name}"`);
      setDeleteTarget(null);
      await fetchCollections();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  if (loading) {
    return (
      <div>
        <PageHeader title="集合管理" description="管理资源集合" />
        <LoadingState variant="card" count={4} />
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <PageHeader title="集合管理" description="管理资源集合" />
        <ErrorState message={error} onRetry={fetchCollections} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="集合管理" description="管理资源集合">
        <Button size="sm" className="gap-1" onClick={openCreate}>
          <Plus className="h-4 w-4" />
          新建集合
        </Button>
      </PageHeader>

      {collections.length === 0 ? (
        <EmptyState title="暂无集合" description="创建集合并将资源组织在一起" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {collections.map((col) => (
            <Card key={col.id} className="overflow-hidden">
              {/* 封面区域 */}
              <div className="flex h-32 items-center justify-center bg-muted">
                {col.coverResource ? (
                  <ResourceTypeIcon type={col.coverResource.resourceType} className="h-12 w-12 text-muted-foreground" />
                ) : (
                  <Layers className="h-12 w-12 text-muted-foreground" />
                )}
              </div>

              <CardHeader className="pb-2">
                <CardTitle className="text-base">{col.name}</CardTitle>
              </CardHeader>

              <CardContent className="pb-2">
                {col.description ? (
                  <p className="line-clamp-2 text-sm text-muted-foreground">{col.description}</p>
                ) : (
                  <p className="text-sm text-muted-foreground italic">暂无描述</p>
                )}
                <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                  <FolderOpen className="h-3 w-3" />
                  <span>{col.resourceCount} 个资源</span>
                </div>
              </CardContent>

              <CardFooter className="gap-1 pt-0">
                <Button variant="ghost" size="sm" onClick={() => openEdit(col)}>
                  <Pencil className="mr-1 h-3 w-3" />编辑
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(col)}>
                  <Trash2 className="mr-1 h-3 w-3 text-destructive" />删除
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      {/* Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => {
        setDialogOpen(open);
        if (!open) {
          setEditingCollection(null);
          setFormName('');
          setFormDescription('');
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingCollection ? '编辑集合' : '新建集合'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="col-name">名称</Label>
              <Input
                id="col-name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="集合名称"
                maxLength={255}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="col-desc">描述</Label>
              <Textarea
                id="col-desc"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="集合描述（可选）"
                maxLength={2000}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={handleSave} disabled={!formName.trim()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}
        title="删除集合"
        description={`确定要删除集合 "${deleteTarget?.name}" 吗？集合中的资源不会被删除。`}
        variant="destructive"
        confirmLabel="删除"
        onConfirm={handleDelete}
      />
    </div>
  );
}
