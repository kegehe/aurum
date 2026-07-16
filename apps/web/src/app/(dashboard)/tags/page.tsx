'use client';

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { listTags, createTag, updateTag, deleteTag } from '@/lib/api/tags';
import type { TagWithUsage } from '@/lib/types';

export default function TagsPage() {
  const [tags, setTags] = useState<TagWithUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 新建/编辑 Dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTag, setEditingTag] = useState<TagWithUsage | null>(null);
  const [formName, setFormName] = useState('');
  const [formColor, setFormColor] = useState('#3b82f6');

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<TagWithUsage | null>(null);

  const fetchTags = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listTags();
      setTags(data.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTags(); }, [fetchTags]);

  const openCreate = () => {
    setEditingTag(null);
    setFormName('');
    setFormColor('#3b82f6');
    setDialogOpen(true);
  };

  const openEdit = (tag: TagWithUsage) => {
    setEditingTag(tag);
    setFormName(tag.name);
    setFormColor(tag.color || '#3b82f6');
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formName.trim()) return;
    try {
      if (editingTag) {
        await updateTag(editingTag.id, { name: formName.trim(), color: formColor });
        toast.success('标签已更新');
      } else {
        await createTag({ name: formName.trim(), color: formColor });
        toast.success('标签已创建');
      }
      setDialogOpen(false);
      await fetchTags();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      const result = await deleteTag(deleteTarget.id);
      toast.success(`已删除标签 "${deleteTarget.name}"（${result.previousUsage} 个资源受影响）`);
      setDeleteTarget(null);
      await fetchTags();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  const columns: Column<TagWithUsage>[] = [
    {
      key: 'name',
      header: '标签名称',
      render: (tag) => (
        <div className="flex items-center gap-2">
          {tag.color && (
            <span
              className="inline-block h-3 w-3 rounded-full"
              style={{ backgroundColor: tag.color }}
            />
          )}
          <span className="font-medium">{tag.name}</span>
        </div>
      ),
    },
    {
      key: 'usageCount',
      header: '使用次数',
      className: 'text-center',
      render: (tag) => (
        <Badge variant="secondary">{tag.usageCount}</Badge>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      className: 'text-right',
      render: (tag) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => openEdit(tag)}>
            编辑
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDeleteTarget(tag)}
            className="text-destructive hover:text-destructive"
          >
            删除
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="标签管理" description="管理资源标签">
        <Button size="sm" className="gap-1" onClick={openCreate}>
          <Plus className="h-4 w-4" />
          新建标签
        </Button>
      </PageHeader>

      <DataTable
        columns={columns}
        data={tags}
        loading={loading}
        error={error ?? undefined}
        onRetry={fetchTags}
        emptyTitle="暂无标签"
        emptyDescription="创建标签来分类管理资源"
        keyExtractor={(t) => t.id}
      />

      {/* 新建/编辑 Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => {
        setDialogOpen(open);
        if (!open) {
          setEditingTag(null);
          setFormName('');
          setFormColor('#3b82f6');
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingTag ? '编辑标签' : '新建标签'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tag-name">名称</Label>
              <Input
                id="tag-name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="标签名称"
                maxLength={50}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tag-color">颜色</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="tag-color"
                  type="color"
                  value={formColor}
                  onChange={(e) => setFormColor(e.target.value)}
                  className="h-9 w-16 p-1"
                />
                <span className="text-sm text-muted-foreground">{formColor}</span>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={!formName.trim()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}
        title="删除标签"
        description={`确定要删除标签 "${deleteTarget?.name}" 吗？此操作不可撤销。`}
        variant="destructive"
        confirmLabel="删除"
        onConfirm={handleDelete}
      />
    </div>
  );
}
