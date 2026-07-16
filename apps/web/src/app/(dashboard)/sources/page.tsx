'use client';

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Plus, Power, PowerOff } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { listSources, createSource, updateSource, deleteSource } from '@/lib/api/sources';
import { listLicenses } from '@/lib/api/licenses';
import { SOURCE_TYPE_LABELS, ACQUISITION_MODE_LABELS } from '@/lib/constants';
import type { SourceItem, LicenseItem } from '@/lib/types';

const SOURCE_TYPES = Object.entries(SOURCE_TYPE_LABELS);
const ACQUISITION_MODES = Object.entries(ACQUISITION_MODE_LABELS);

export default function SourcesPage() {
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [licenses, setLicenses] = useState<LicenseItem[]>([]);

  // 新建/编辑 Dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSource, setEditingSource] = useState<SourceItem | null>(null);
  const [formName, setFormName] = useState('');
  const [formSlug, setFormSlug] = useState('');
  const [formSourceType, setFormSourceType] = useState('link_metadata');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formEnabled, setFormEnabled] = useState(true);
  const [formAllowedModes, setFormAllowedModes] = useState<string[]>(['link_only', 'metadata_only']);
  const [formDefaultLicenseId, setFormDefaultLicenseId] = useState('');
  const [formRateLimit, setFormRateLimit] = useState('30');
  const [formMaxConcurrency, setFormMaxConcurrency] = useState('1');
  const [formRequiresReview, setFormRequiresReview] = useState(false);

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<SourceItem | null>(null);

  const fetchSources = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listSources({ pageSize: 100 });
      setSources(data.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchLicenses = useCallback(async () => {
    try {
      const data = await listLicenses({ pageSize: 100 });
      setLicenses(data.items);
    } catch { /* non-blocking */ }
  }, []);

  useEffect(() => { fetchSources(); fetchLicenses(); }, [fetchSources, fetchLicenses]);

  const resetForm = () => {
    setFormName('');
    setFormSlug('');
    setFormSourceType('link_metadata');
    setFormBaseUrl('');
    setFormEnabled(true);
    setFormAllowedModes(['link_only', 'metadata_only']);
    setFormDefaultLicenseId('');
    setFormRateLimit('30');
    setFormMaxConcurrency('1');
    setFormRequiresReview(false);
  };

  const openCreate = () => {
    setEditingSource(null);
    resetForm();
    setDialogOpen(true);
  };

  const openEdit = (source: SourceItem) => {
    setEditingSource(source);
    setFormName(source.name);
    setFormSlug(source.slug);
    setFormSourceType(source.sourceType);
    setFormBaseUrl(source.baseUrl ?? '');
    setFormEnabled(source.enabled);
    setFormAllowedModes(source.allowedModes.split(',').map((m) => m.trim()));
    setFormDefaultLicenseId(source.defaultLicenseId ?? '');
    setFormRateLimit(String(source.rateLimitPerMinute));
    setFormMaxConcurrency(String(source.maxConcurrency));
    setFormRequiresReview(source.requiresReview);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formName.trim() || !formSlug.trim()) return;
    try {
      const data = {
        name: formName.trim(),
        slug: formSlug.trim(),
        sourceType: formSourceType,
        baseUrl: formBaseUrl.trim() || undefined,
        enabled: formEnabled,
        allowedModes: formAllowedModes.join(','),
        defaultLicenseId: formDefaultLicenseId || undefined,
        rateLimitPerMinute: parseInt(formRateLimit) || 30,
        maxConcurrency: parseInt(formMaxConcurrency) || 1,
        requiresReview: formRequiresReview,
      };
      if (editingSource) {
        await updateSource(editingSource.id, data);
        toast.success('来源已更新');
      } else {
        await createSource(data);
        toast.success('来源已创建');
      }
      setDialogOpen(false);
      await fetchSources();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败');
    }
  };

  const handleToggleEnabled = async (source: SourceItem) => {
    try {
      await updateSource(source.id, { enabled: !source.enabled });
      toast.success(source.enabled ? '来源已禁用' : '来源已启用');
      await fetchSources();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteSource(deleteTarget.id);
      toast.success(`已删除来源 "${deleteTarget.name}"`);
      setDeleteTarget(null);
      await fetchSources();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  const toggleMode = (mode: string) => {
    setFormAllowedModes((prev) =>
      prev.includes(mode) ? prev.filter((m) => m !== mode) : [...prev, mode],
    );
  };

  const columns: Column<SourceItem>[] = [
    {
      key: 'name',
      header: '来源名称',
      render: (s) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{s.name}</span>
          <span className="text-xs text-muted-foreground">{s.slug}</span>
        </div>
      ),
    },
    {
      key: 'sourceType',
      header: '类型',
      className: 'w-28',
      render: (s) => (
        <Badge variant="secondary">{SOURCE_TYPE_LABELS[s.sourceType] ?? s.sourceType}</Badge>
      ),
    },
    {
      key: 'enabled',
      header: '状态',
      className: 'w-20',
      render: (s) => (
        <Badge variant={s.enabled ? 'default' : 'outline'}>
          {s.enabled ? '启用' : '禁用'}
        </Badge>
      ),
    },
    {
      key: 'allowedModes',
      header: '允许模式',
      className: 'w-40',
      render: (s) => (
        <div className="flex flex-wrap gap-1">
          {s.allowedModes.split(',').map((mode) => (
            <Badge key={mode} variant="outline" className="text-xs">
              {ACQUISITION_MODE_LABELS[mode.trim()] ?? mode.trim()}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      key: 'defaultLicense',
      header: '默认许可',
      className: 'w-32',
      render: (s) => (
        <span className="text-sm text-muted-foreground">
          {s.defaultLicense?.name ?? '—'}
        </span>
      ),
    },
    {
      key: 'requiresReview',
      header: '审核',
      className: 'w-16 text-center',
      render: (s) => (
        <Badge variant={s.requiresReview ? 'destructive' : 'secondary'}>
          {s.requiresReview ? '需审核' : '自动'}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      className: 'w-36 text-right',
      render: (s) => (
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleToggleEnabled(s)}
            title={s.enabled ? '禁用' : '启用'}
          >
            {s.enabled ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => openEdit(s)}>
            编辑
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDeleteTarget(s)}
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
      <PageHeader title="来源管理" description="管理外部资源来源配置和策略">
        <Button size="sm" className="gap-1" onClick={openCreate}>
          <Plus className="h-4 w-4" />
          新建来源
        </Button>
      </PageHeader>

      <DataTable
        columns={columns}
        data={sources}
        loading={loading}
        error={error ?? undefined}
        onRetry={fetchSources}
        emptyTitle="暂无来源"
        emptyDescription="创建来源配置来管理外部资源导入策略"
        keyExtractor={(s) => s.id}
      />

      {/* 新建/编辑 Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => {
        setDialogOpen(open);
        if (!open) { setEditingSource(null); resetForm(); }
      }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingSource ? '编辑来源' : '新建来源'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="source-name">名称 *</Label>
                <Input id="source-name" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="来源名称" maxLength={100} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="source-slug">标识符 *</Label>
                <Input id="source-slug" value={formSlug} onChange={(e) => setFormSlug(e.target.value.replace(/[^a-z0-9-]/g, ''))} placeholder="my-source" maxLength={50} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>来源类型 *</Label>
                <Select value={formSourceType} onValueChange={setFormSourceType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SOURCE_TYPES.map(([value, label]) => (
                      <SelectItem key={value} value={value}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="source-base-url">Base URL</Label>
                <Input id="source-base-url" value={formBaseUrl} onChange={(e) => setFormBaseUrl(e.target.value)} placeholder="https://example.com" />
              </div>
            </div>
            <div className="space-y-2">
              <Label>允许导入模式</Label>
              <div className="flex flex-wrap gap-2">
                {ACQUISITION_MODES.map(([value, label]) => (
                  <label key={value} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={formAllowedModes.includes(value)}
                      onChange={() => toggleMode(value)}
                      className="rounded border-gray-300"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label>默认许可证</Label>
              <Select value={formDefaultLicenseId || '__none__'} onValueChange={(v) => setFormDefaultLicenseId(v === '__none__' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="无" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">无</SelectItem>
                  {licenses.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.spdxId ? `${l.spdxId} — ${l.name}` : l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="source-rate-limit">速率限制（次/分钟）</Label>
                <Input id="source-rate-limit" type="number" value={formRateLimit} onChange={(e) => setFormRateLimit(e.target.value)} min={1} max={1000} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="source-concurrency">最大并发</Label>
                <Input id="source-concurrency" type="number" value={formMaxConcurrency} onChange={(e) => setFormMaxConcurrency(e.target.value)} min={1} max={10} />
              </div>
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={formEnabled} onChange={(e) => setFormEnabled(e.target.checked)} className="rounded border-gray-300" />
                启用
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={formRequiresReview} onChange={(e) => setFormRequiresReview(e.target.checked)} className="rounded border-gray-300" />
                需要人工审核
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={handleSave} disabled={!formName.trim() || !formSlug.trim() || formAllowedModes.length === 0}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}
        title="删除来源"
        description={`确定要删除来源 "${deleteTarget?.name}" 吗？仅无关联资源的来源可删除。此操作不可撤销。`}
        variant="destructive"
        confirmLabel="删除"
        onConfirm={handleDelete}
      />
    </div>
  );
}
