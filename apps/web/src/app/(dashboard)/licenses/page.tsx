'use client';

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Plus, Check, X, HelpCircle } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { listLicenses, createLicense, updateLicense, deleteLicense } from '@/lib/api/licenses';
import type { LicenseItem } from '@/lib/types';

/** 三态布尔标记组件 */
function TriBool({ value }: { value: boolean | null }) {
  if (value === true) return <Check className="h-4 w-4 text-green-600" />;
  if (value === false) return <X className="h-4 w-4 text-red-500" />;
  return <HelpCircle className="h-4 w-4 text-muted-foreground" />;
}

export default function LicensesPage() {
  const [licenses, setLicenses] = useState<LicenseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 新建/编辑 Dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingLicense, setEditingLicense] = useState<LicenseItem | null>(null);
  const [formSpdxId, setFormSpdxId] = useState('');
  const [formName, setFormName] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [formText, setFormText] = useState('');
  const [formCommercialUse, setFormCommercialUse] = useState<boolean | null>(null);
  const [formRedistribution, setFormRedistribution] = useState<boolean | null>(null);
  const [formDerivatives, setFormDerivatives] = useState<boolean | null>(null);
  const [formAttribution, setFormAttribution] = useState(false);
  const [formShareAlike, setFormShareAlike] = useState(false);

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<LicenseItem | null>(null);

  const fetchLicenses = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listLicenses({ pageSize: 100 });
      setLicenses(data.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchLicenses(); }, [fetchLicenses]);

  const resetForm = () => {
    setFormSpdxId('');
    setFormName('');
    setFormUrl('');
    setFormText('');
    setFormCommercialUse(null);
    setFormRedistribution(null);
    setFormDerivatives(null);
    setFormAttribution(false);
    setFormShareAlike(false);
  };

  const openCreate = () => {
    setEditingLicense(null);
    resetForm();
    setDialogOpen(true);
  };

  const openEdit = (license: LicenseItem) => {
    setEditingLicense(license);
    setFormSpdxId(license.spdxId ?? '');
    setFormName(license.name);
    setFormUrl(license.url ?? '');
    setFormText('');
    setFormCommercialUse(license.allowsCommercialUse);
    setFormRedistribution(license.allowsRedistribution);
    setFormDerivatives(license.allowsDerivatives);
    setFormAttribution(license.requiresAttribution);
    setFormShareAlike(license.shareAlike);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formName.trim()) return;
    try {
      const data = {
        spdxId: formSpdxId.trim() || undefined,
        name: formName.trim(),
        url: formUrl.trim() || undefined,
        text: formText.trim() || undefined,
        allowsCommercialUse: formCommercialUse ?? undefined,
        allowsRedistribution: formRedistribution ?? undefined,
        allowsDerivatives: formDerivatives ?? undefined,
        requiresAttribution: formAttribution,
        shareAlike: formShareAlike,
      };
      if (editingLicense) {
        await updateLicense(editingLicense.id, data);
        toast.success('许可证已更新');
      } else {
        await createLicense(data);
        toast.success('许可证已创建');
      }
      setDialogOpen(false);
      await fetchLicenses();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteLicense(deleteTarget.id);
      toast.success(`已删除许可证 "${deleteTarget.name}"`);
      setDeleteTarget(null);
      await fetchLicenses();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  /** 三态复选框切换：null → true → false → null */
  const cycleTriBool = (setter: (v: boolean | null) => void, current: boolean | null) => {
    if (current === null) setter(true);
    else if (current === true) setter(false);
    else setter(null);
  };

  const columns: Column<LicenseItem>[] = [
    {
      key: 'spdxId',
      header: 'SPDX ID',
      className: 'w-32',
      render: (l) => (
        <Badge variant="outline" className="font-mono text-xs">
          {l.spdxId ?? '自定义'}
        </Badge>
      ),
    },
    {
      key: 'name',
      header: '名称',
      render: (l) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{l.name}</span>
          {l.url && (
            <a href={l.url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline truncate max-w-48">
              {l.url}
            </a>
          )}
        </div>
      ),
    },
    {
      key: 'allowsCommercialUse',
      header: '商用',
      className: 'w-16 text-center',
      render: (l) => <TriBool value={l.allowsCommercialUse} />,
    },
    {
      key: 'allowsRedistribution',
      header: '再分发',
      className: 'w-16 text-center',
      render: (l) => <TriBool value={l.allowsRedistribution} />,
    },
    {
      key: 'allowsDerivatives',
      header: '衍生',
      className: 'w-16 text-center',
      render: (l) => <TriBool value={l.allowsDerivatives} />,
    },
    {
      key: 'requiresAttribution',
      header: '署名',
      className: 'w-16 text-center',
      render: (l) => <TriBool value={l.requiresAttribution} />,
    },
    {
      key: 'shareAlike',
      header: '相同方式',
      className: 'w-16 text-center',
      render: (l) => <TriBool value={l.shareAlike} />,
    },
    {
      key: 'actions',
      header: '操作',
      className: 'w-24 text-right',
      render: (l) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => openEdit(l)}>
            编辑
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDeleteTarget(l)}
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
      <PageHeader title="许可证管理" description="管理许可证目录和许可策略">
        <Button size="sm" className="gap-1" onClick={openCreate}>
          <Plus className="h-4 w-4" />
          新建许可证
        </Button>
      </PageHeader>

      <DataTable
        columns={columns}
        data={licenses}
        loading={loading}
        error={error ?? undefined}
        onRetry={fetchLicenses}
        emptyTitle="暂无许可证"
        emptyDescription="创建许可证来管理资源使用权限"
        keyExtractor={(l) => l.id}
      />

      {/* 新建/编辑 Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => {
        setDialogOpen(open);
        if (!open) { setEditingLicense(null); resetForm(); }
      }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingLicense ? '编辑许可证' : '新建许可证'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="license-spdx">SPDX ID</Label>
                <Input id="license-spdx" value={formSpdxId} onChange={(e) => setFormSpdxId(e.target.value)} placeholder="MIT" maxLength={50} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="license-name">名称 *</Label>
                <Input id="license-name" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="MIT License" maxLength={200} />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="license-url">许可证 URL</Label>
              <Input id="license-url" value={formUrl} onChange={(e) => setFormUrl(e.target.value)} placeholder="https://spdx.org/licenses/MIT.html" />
            </div>
            {!editingLicense && (
              <div className="space-y-2">
                <Label htmlFor="license-text">许可证全文</Label>
                <Textarea id="license-text" value={formText} onChange={(e) => setFormText(e.target.value)} placeholder="可选：粘贴许可证全文" rows={4} />
              </div>
            )}
            <div className="space-y-3">
              <Label>许可属性（点击切换：未设置 → ✓ → ✗ → 未设置）</Label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => cycleTriBool(setFormCommercialUse, formCommercialUse)}
                  className="flex items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-accent"
                >
                  <span>允许商用</span>
                  <TriBool value={formCommercialUse} />
                </button>
                <button
                  type="button"
                  onClick={() => cycleTriBool(setFormRedistribution, formRedistribution)}
                  className="flex items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-accent"
                >
                  <span>允许再分发</span>
                  <TriBool value={formRedistribution} />
                </button>
                <button
                  type="button"
                  onClick={() => cycleTriBool(setFormDerivatives, formDerivatives)}
                  className="flex items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-accent"
                >
                  <span>允许衍生</span>
                  <TriBool value={formDerivatives} />
                </button>
                <button
                  type="button"
                  onClick={() => setFormAttribution(!formAttribution)}
                  className="flex items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-accent"
                >
                  <span>需要署名</span>
                  <TriBool value={formAttribution} />
                </button>
                <button
                  type="button"
                  onClick={() => setFormShareAlike(!formShareAlike)}
                  className="flex items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-accent"
                >
                  <span>相同方式共享</span>
                  <TriBool value={formShareAlike} />
                </button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={handleSave} disabled={!formName.trim()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}
        title="删除许可证"
        description={`确定要删除许可证 "${deleteTarget?.name}" 吗？仅无关联资源的许可证可删除。此操作不可撤销。`}
        variant="destructive"
        confirmLabel="删除"
        onConfirm={handleDelete}
      />
    </div>
  );
}
