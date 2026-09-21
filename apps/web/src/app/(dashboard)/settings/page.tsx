'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Check,
  Globe,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import {
  activateAiProvider,
  createAiProvider,
  deleteAiProvider,
  getAiSettingsSummary,
  listAiProviders,
  testAiProvider,
  testAiProviderConfig,
  updateAiProvider,
} from '@/lib/api/ai-settings';
import type {
  AiProviderItem,
  AiProviderSummary,
  AiTestResult,
} from '@/lib/types';

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic 兼容接口',
};

/** 测试状态展示：上次测试结果 / 错误信息 */
function TestStatusInfo({ provider }: { provider: AiProviderItem }) {
  if (!provider.lastTestedAt) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
        尚未测试
      </span>
    );
  }
  const time = new Date(provider.lastTestedAt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  if (provider.lastTestStatus === 'ok') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-success">
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-success/15">
          <Check className="h-2.5 w-2.5" />
        </span>
        上次测试成功（{time}）
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-destructive">
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-destructive/15">
        <X className="h-2.5 w-2.5" />
      </span>
      <span className="truncate">
        上次测试失败（{time}）：{provider.lastTestError ?? '未知错误'}
      </span>
    </span>
  );
}

/** 顶部状态横幅：AI 可用性 + 主要操作 */
function StatusBanner({
  summary,
  onAdd,
}: {
  summary: AiProviderSummary | null;
  onAdd: () => void;
}) {
  const available = summary?.available ?? false;
  return (
    <Card className={cn('overflow-hidden', available ? 'border-success/30' : 'border-warning/30')}>
      <CardContent className="relative p-0">
        <div
          className={cn(
            'absolute inset-0',
            available
              ? 'bg-gradient-to-r from-success/10 via-transparent to-transparent'
              : 'bg-gradient-to-r from-warning/10 via-transparent to-transparent',
          )}
        />
        <div className="relative flex flex-wrap items-center justify-between gap-4 p-5">
          <div className="flex min-w-0 items-center gap-3.5">
            <div
              className={cn(
                'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl',
                available ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning',
              )}
            >
              {available ? <Sparkles className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-base font-semibold">{available ? 'AI 功能可用' : 'AI 功能未启用'}</p>
                <Badge
                  variant={available ? 'success' : 'warning'}
                  className="rounded-full px-2"
                >
                  {available ? '可用' : '未启用'}
                </Badge>
              </div>
              <p className="mt-0.5 truncate text-sm text-muted-foreground">
                {summary?.source === 'db'
                  ? `当前生效：${summary.name ?? ''} · ${summary.model}`
                  : summary?.source === 'env'
                    ? `当前使用环境变量配置（${summary.model}）`
                    : '未配置 API Key，请添加配置或启用下方任一配置'}
              </p>
            </div>
          </div>
          <Button onClick={onAdd} className="shrink-0 gap-1.5">
            <Plus className="h-4 w-4" />
            新增配置
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** 空状态 */
function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center px-6 py-12 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <KeyRound className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="mt-4 text-sm font-semibold">还没有 AI 配置</h3>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          添加 API Key 后，样式实验室等 AI 功能即可使用。支持多个配置、运行时切换。
        </p>
        <Button size="sm" className="mt-5 gap-1.5" onClick={onAdd}>
          <Plus className="h-4 w-4" />
          新增配置
        </Button>
      </CardContent>
    </Card>
  );
}

const EMPTY_FORM = {
  name: '',
  baseUrl: '',
  apiKey: '',
  model: 'claude-sonnet-5',
  enabled: true,
};

export default function SettingsPage() {
  const [providers, setProviders] = useState<AiProviderItem[]>([]);
  const [summary, setSummary] = useState<AiProviderSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 新建/编辑 Dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AiProviderItem | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);

  // 卡片操作状态
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AiProviderItem | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [items, s] = await Promise.all([listAiProviders(), getAiSettingsSummary()]);
      setProviders(items);
      setSummary(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setTestResult(null);
    setDialogOpen(true);
  };

  const openEdit = (provider: AiProviderItem) => {
    setEditing(provider);
    setForm({
      name: provider.name,
      baseUrl: provider.baseUrl ?? '',
      apiKey: '',
      model: provider.model,
      enabled: provider.enabled,
    });
    setTestResult(null);
    setDialogOpen(true);
  };

  /** 更新表单字段并清空旧测试结果，避免「连接成功」与新值不一致 */
  const setField = (patch: Partial<typeof form>) => {
    setForm((prev) => ({ ...prev, ...patch }));
    setTestResult(null);
  };

  /** 表单内「测试连接」：编辑态未填新 key 时测试已保存的配置 */
  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      let result: AiTestResult;
      if (editing && !form.apiKey.trim()) {
        result = await testAiProvider(editing.id);
      } else {
        result = await testAiProviderConfig({
          provider: 'anthropic',
          baseUrl: form.baseUrl.trim() || undefined,
          apiKey: form.apiKey.trim(),
          model: form.model.trim() || 'claude-sonnet-5',
          name: form.name.trim() || undefined,
        });
      }
      setTestResult(result);
    } catch (e) {
      setTestResult({
        success: false,
        message: e instanceof Error ? e.message : '测试失败',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    if (!editing && !form.apiKey.trim()) {
      toast.error('请填写 API Key');
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await updateAiProvider(editing.id, {
          name: form.name.trim(),
          baseUrl: form.baseUrl.trim() || null,
          apiKey: form.apiKey.trim() || undefined,
          model: form.model.trim() || 'claude-sonnet-5',
          enabled: form.enabled,
        });
        toast.success('AI 配置已更新');
      } else {
        await createAiProvider({
          name: form.name.trim(),
          baseUrl: form.baseUrl.trim() || undefined,
          apiKey: form.apiKey.trim(),
          model: form.model.trim() || 'claude-sonnet-5',
          enabled: form.enabled,
        });
        toast.success('AI 配置已创建');
      }
      setDialogOpen(false);
      await fetchData();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败');
    } finally {
      setSaving(false);
    }
  };

  const handleActivate = async (provider: AiProviderItem) => {
    try {
      await activateAiProvider(provider.id);
      toast.success(`已将「${provider.name}」设为当前生效`);
      await fetchData();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败');
    }
  };

  const handleToggleEnabled = async (provider: AiProviderItem) => {
    try {
      await updateAiProvider(provider.id, { enabled: !provider.enabled });
      toast.success(provider.enabled ? '配置已停用' : '配置已启用');
      await fetchData();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败');
    }
  };

  const handleCardTest = async (provider: AiProviderItem) => {
    setTestingId(provider.id);
    try {
      const result = await testAiProvider(provider.id);
      if (result.success) {
        toast.success(
          `测试成功（${result.latencyMs}ms，模型 ${result.model ?? provider.model}）`,
        );
      } else {
        toast.error(`测试失败：${result.message ?? '未知错误'}`);
      }
      await fetchData();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '测试失败');
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteAiProvider(deleteTarget.id);
      toast.success(`已删除「${deleteTarget.name}」`);
      setDeleteTarget(null);
      await fetchData();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title="系统设置"
        description="配置 AI 服务连接。支持多个配置、运行时切换生效项，修改后立即生效，无需重启。"
      />

      <Tabs defaultValue="ai">
        <TabsList>
          <TabsTrigger value="ai" className="gap-1.5">
            <Sparkles className="h-3.5 w-3.5" />
            AI 配置
          </TabsTrigger>
        </TabsList>

        <TabsContent value="ai" className="mt-5 space-y-5">
          <StatusBanner summary={summary} onAdd={openCreate} />

          {/* 配置列表 */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">配置列表</h2>
              {!loading && providers.length > 0 && (
                <Badge variant="secondary" className="rounded-full px-2 text-xs">
                  {providers.length}
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fetchData()}
              className="gap-1 text-muted-foreground"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              刷新
            </Button>
          </div>

          {loading ? (
            <div className="space-y-3">
              {[1, 2].map((i) => (
                <Card key={i}>
                  <CardContent className="p-5">
                    <div className="flex items-center gap-3">
                      <Skeleton className="h-10 w-10 rounded-lg" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-4 w-1/3" />
                        <Skeleton className="h-3 w-1/2" />
                      </div>
                    </div>
                    <div className="mt-4 grid gap-2 sm:grid-cols-2">
                      <Skeleton className="h-8 w-full rounded-md" />
                      <Skeleton className="h-8 w-full rounded-md" />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : error ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
                <AlertTriangle className="h-8 w-8 text-destructive" />
                <p className="text-sm text-destructive">{error}</p>
                <Button variant="outline" size="sm" onClick={() => fetchData()}>
                  重试
                </Button>
              </CardContent>
            </Card>
          ) : providers.length === 0 ? (
            <EmptyState onAdd={openCreate} />
          ) : (
            <div className="space-y-3">
              {providers.map((provider) => (
                <Card
                  key={provider.id}
                  className={cn(
                    'relative overflow-hidden',
                    provider.isActive && 'border-primary/40 ring-1 ring-primary/15',
                    !provider.enabled && 'opacity-80',
                  )}
                >
                  {provider.isActive && (
                    <div className="absolute inset-y-0 left-0 w-1 bg-primary" />
                  )}
                  <CardContent className="p-5">
                    {/* 头部：头像 + 名称 + 操作 */}
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <div
                          className={cn(
                            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                            provider.isActive
                              ? 'bg-primary/10 text-primary'
                              : 'bg-secondary text-muted-foreground',
                          )}
                        >
                          <Sparkles className="h-5 w-5" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-semibold">{provider.name}</span>
                            {provider.isActive && <Badge className="rounded-full px-2">当前生效</Badge>}
                            <Badge
                              variant={provider.enabled ? 'secondary' : 'outline'}
                              className="rounded-full px-2"
                            >
                              {provider.enabled ? '启用' : '停用'}
                            </Badge>
                          </div>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {PROVIDER_LABELS[provider.provider] ?? provider.provider} · {provider.model}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-1">
                        {!provider.isActive && provider.enabled && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleActivate(provider)}
                            className="gap-1.5"
                          >
                            <Check className="h-3.5 w-3.5" />
                            设为当前
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleToggleEnabled(provider)}
                          title={provider.enabled ? '停用' : '启用'}
                        >
                          {provider.enabled ? (
                            <PowerOff className="h-4 w-4" />
                          ) : (
                            <Power className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEdit(provider)}
                          title="编辑"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setDeleteTarget(provider)}
                          className="text-destructive hover:text-destructive"
                          title="删除"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    {/* 详情 */}
                    <div className="mt-4 grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2">
                      <div className="flex items-center gap-2 bg-muted/40 px-3 py-2">
                        <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="shrink-0 text-muted-foreground">接口</span>
                        <span className="truncate font-medium">{provider.baseUrl || '官方默认'}</span>
                      </div>
                      <div className="flex items-center gap-2 bg-muted/40 px-3 py-2">
                        <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="shrink-0 text-muted-foreground">API Key</span>
                        <code className="truncate font-medium">{provider.apiKey || '未设置'}</code>
                      </div>
                    </div>

                    <Separator className="my-4" />

                    {/* 底部：测试状态 + 测试操作 */}
                    <div className="flex items-center justify-between gap-2">
                      <TestStatusInfo provider={provider} />
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => handleCardTest(provider)}
                        disabled={testingId === provider.id}
                      >
                        {testingId === provider.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        测试连接
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* 新建/编辑 Dialog */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setEditing(null);
            setForm(EMPTY_FORM);
            setTestResult(null);
          }
        }}
      >
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              {editing ? '编辑 AI 配置' : '新增 AI 配置'}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ai-name">配置名称 *</Label>
              <Input
                id="ai-name"
                value={form.name}
                onChange={(e) => setField({ name: e.target.value })}
                placeholder="如：官方 / 中转代理"
                maxLength={100}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-model">模型</Label>
              <Input
                id="ai-model"
                value={form.model}
                onChange={(e) => setField({ model: e.target.value })}
                placeholder="claude-sonnet-5"
                maxLength={200}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-base-url">Base URL（接口地址）</Label>
              <Input
                id="ai-base-url"
                value={form.baseUrl}
                onChange={(e) => setField({ baseUrl: e.target.value })}
                placeholder="https://api.anthropic.com"
                maxLength={2048}
              />
              <p className="text-xs text-muted-foreground">
                留空使用官方接口。不需要包含 <code>/v1/messages</code>，SDK 会自动追加；以{' '}
                <code>/v1</code> 结尾的地址会自动处理。
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-api-key">API Key{editing ? '' : ' *'}</Label>
              <Input
                id="ai-api-key"
                type="password"
                value={form.apiKey}
                onChange={(e) => setField({ apiKey: e.target.value })}
                placeholder={
                  editing && providerHasKey(editing)
                    ? '留空保持不变（已配置密钥）'
                    : 'sk-ant-…'
                }
                maxLength={500}
                autoComplete="off"
              />
              {editing && providerHasKey(editing) && (
                <p className="text-xs text-muted-foreground">
                  当前已配置密钥，留空或输入掩码值即保持不变；填写新值将覆盖。
                </p>
              )}
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setField({ enabled: e.target.checked })}
                className="rounded border-gray-300"
              />
              启用（停用的配置不会被选中为当前生效）
            </label>

            {/* 测试结果 */}
            {testResult && (
              <div
                className={cn(
                  'rounded-md border p-3 text-sm',
                  testResult.success
                    ? 'border-success/40 bg-success/5 text-success-foreground'
                    : 'border-destructive/40 bg-destructive/5 text-destructive-foreground',
                )}
              >
                <p className="flex items-center gap-1.5 font-medium">
                  {testResult.success ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <X className="h-4 w-4" />
                  )}
                  {testResult.success ? '连接成功' : '连接失败'}
                </p>
                {testResult.success ? (
                  <p className="mt-1 text-xs opacity-80">
                    延迟 {testResult.latencyMs}ms · 模型 {testResult.model ?? form.model}
                  </p>
                ) : (
                  <p className="mt-1 text-xs opacity-80">{testResult.message}</p>
                )}
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={testing}
              className="gap-1.5"
            >
              {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              测试连接
            </Button>
            <div className="flex-1" />
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !form.name.trim() || (!editing && !form.apiKey.trim())}
            >
              {saving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null);
        }}
        title="删除 AI 配置"
        description={`确定要删除「${deleteTarget?.name}」吗？此操作不可撤销。${
          deleteTarget?.isActive ? '该配置为当前生效项，删除后会自动切换其它配置。' : ''
        }`}
        variant="destructive"
        confirmLabel="删除"
        onConfirm={handleDelete}
      />
    </div>
  );
}

/** 编辑态：判断是否已有密钥（决定占位提示） */
function providerHasKey(provider: AiProviderItem): boolean {
  return provider.hasApiKey && !!provider.apiKey;
}
