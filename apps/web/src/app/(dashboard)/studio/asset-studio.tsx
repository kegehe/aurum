'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  CheckCircle2,
  FileCode2,
  Loader2,
  MessageSquare,
  Monitor,
  RefreshCw,
  Save,
  Send,
  Smartphone,
  Tablet,
  Undo2,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { PageHeader } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { diffHunks } from '@/lib/line-diff';
import { cn } from '@/lib/utils';
import { TokenEditor } from './token-editor';
import {
  applyStudioCandidate,
  createStudioSession,
  getAsset,
  getAssetPreview,
  getStudioSession,
  discardStudioSession,
  closeStudioSession,
  getStudioSessionPreview,
  listStudioSessions,
  listStudioSnapshots,
  rejectStudioCandidate,
  restoreStudioSnapshot,
  retryStudioMessage,
  saveAssetVersion,
  saveStudioSession,
  streamStudioMessage,
  undoStudioSession,
  type AssetDetail,
  type AssetPreview,
  type StudioCandidate,
  type StudioSession,
  type StudioSessionSummary,
  type StudioSnapshotSummary,
} from '@/lib/api/assets';

type Viewport = 'desktop' | 'tablet' | 'mobile';

const VIEWPORT_WIDTH: Record<Viewport, string> = {
  desktop: '100%',
  tablet: '768px',
  mobile: '390px',
};

const VIEWPORT_LABEL: Record<Viewport, string> = {
  desktop: '桌面',
  tablet: '平板',
  mobile: '手机',
};

async function getStudioSessionSafe(id: string) {
  try {
    return await getStudioSession(id);
  } catch {
    return null;
  }
}

export function AssetStudio({ assetId }: { assetId: string }) {
  const [asset, setAsset] = useState<AssetDetail | null>(null);
  const [preview, setPreview] = useState<AssetPreview | null>(null);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [activePath, setActivePath] = useState('');
  const [summary, setSummary] = useState('工作台保存');
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<StudioSession | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [candidate, setCandidate] = useState<StudioCandidate | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [sessions, setSessions] = useState<StudioSessionSummary[]>([]);
  const [snapshots, setSnapshots] = useState<StudioSnapshotSummary[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const detail = await getAsset(assetId);
      setAsset(detail);
      let currentSession: StudioSession | null = null;
      if (detail.format === 'package') {
        try {
          currentSession = await createStudioSession(detail.id);
        } catch {
          // 草稿会话创建失败不阻塞源码编辑
        }
      }
      setSession(currentSession);
      setCandidate(currentSession?.candidates[0] ?? null);
      const sourceFiles = currentSession?.draft.files ?? detail.files;
      setFiles(Object.fromEntries(sourceFiles.map((file) => [file.path, file.content])));
      const preferred =
        (detail.manifest?.files as Array<{ path?: string }> | undefined)?.[0]?.path ??
        sourceFiles[0]?.path ??
        '';
      setActivePath(preferred);
      if (detail.format === 'package') {
        try {
          setPreview(
            currentSession
              ? await getStudioSessionPreview(currentSession.id)
              : await getAssetPreview(detail.id),
          );
        } catch {
          setPreview(await getAssetPreview(detail.id));
        }
      } else {
        setPreview(null);
      }
      const sessionList = await listStudioSessions(detail.id);
      setSessions(sessionList.items);
      if (currentSession) {
        const snapshotList = await listStudioSnapshots(currentSession.id);
        setSnapshots(snapshotList.items);
      } else {
        setSnapshots([]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '资产加载失败');
    } finally {
      setLoading(false);
    }
  }, [assetId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const dirty = useMemo(
    () =>
      Boolean(
        asset?.files.some((file) => (files[file.path] ?? file.content) !== file.content),
      ),
    [asset, files],
  );

  const draftDirty = useMemo(
    () =>
      Boolean(
        session?.draft.files.some(
          (file) => (files[file.path] ?? file.content) !== file.content,
        ),
      ),
    [session, files],
  );

  // 有未保存修改时离开页面先确认；否则整段编辑会静默丢掉。
  useEffect(() => {
    if (!dirty && !draftDirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty, draftDirty]);

  const save = async () => {
    if (!asset || asset.format !== 'package') return;
    setSaving(true);
    try {
      const updated = session
        ? (
            await saveStudioSession(
              session.id,
              summary.trim() || 'AI 对话保存',
              asset.files.map((file) => ({
                ...file,
                content: files[file.path] ?? file.content,
              })),
            )
          ).asset
        : await saveAssetVersion(asset.id, {
            files: asset.files.map((file) => ({
              ...file,
              content: files[file.path] ?? file.content,
            })),
            summary: summary.trim() || '工作台保存',
            // 以页面加载时看到的版本为基准，避免覆盖期间别人发布的新版本。
            baseVersionId: asset.version?.id,
          });
      setAsset(updated);
      setFiles(Object.fromEntries(updated.files.map((file) => [file.path, file.content])));
      // 版本已经落库，预览刷新失败不能反过来报成“保存失败”。
      try {
        setPreview(await getAssetPreview(updated.id));
      } catch (cause) {
        toast.warning(
          `已保存，但预览刷新失败：${cause instanceof Error ? cause.message : '未知错误'}`,
        );
      }
      if (session) {
        const refreshed = await getStudioSessionSafe(session.id);
        if (refreshed) setSession(refreshed);
        void refreshSnapshots(session.id);
      }
      toast.success(`已保存 v${updated.version?.versionNumber ?? ''}`);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const startChat = async () => {
    if (!asset) return;
    setChatBusy(true);
    try {
      const created = await createStudioSession(asset.id);
      setSession(created);
      setCandidate(created.candidates[0] ?? null);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'AI 会话创建失败');
    } finally {
      setChatBusy(false);
    }
  };

  const sendChat = async () => {
    if (!session || chatInput.trim().length < 2) return;
    if (draftDirty) {
      toast.error('本地有未同步到草稿的修改，请先保存新版本');
      return;
    }
    setChatBusy(true);
    setStreamingText('');
    const controller = new AbortController();
    abortRef.current = controller;
    let streamedError: string | null = null;
    let gotCandidate = false;
    try {
      await streamStudioMessage(
        session.id,
        chatInput.trim(),
        {
          onDelta: (text) => setStreamingText((current) => current + text),
          onCandidate: (nextCandidate) => {
            gotCandidate = true;
            setCandidate(nextCandidate);
          },
          onError: (message) => {
            streamedError = message;
            toast.error(message);
          },
        },
        controller.signal,
      );
      const refreshed = await getStudioSessionSafe(session.id);
      if (refreshed) setSession(refreshed);
      if (gotCandidate && !streamedError) {
        setChatInput('');
        toast.success('AI 已生成修改补丁');
      }
    } catch (cause) {
      const aborted =
        cause instanceof DOMException
          ? cause.name === 'AbortError'
          : cause instanceof Error && /abort/i.test(cause.message);
      if (!aborted) {
        toast.error(cause instanceof Error ? cause.message : 'AI 修改失败');
      } else {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      const refreshed = await getStudioSessionSafe(session.id);
      if (refreshed) setSession(refreshed);
    } finally {
      abortRef.current = null;
      setChatBusy(false);
      setStreamingText('');
    }
  };

  const stopChat = () => {
    abortRef.current?.abort();
  };

  const retryChat = async () => {
    if (!session) return;
    if (draftDirty) {
      toast.error('本地有未同步到草稿的修改，请先保存新版本');
      return;
    }
    setChatBusy(true);
    setStreamingText('');
    const controller = new AbortController();
    abortRef.current = controller;
    let streamedError: string | null = null;
    let gotCandidate = false;
    try {
      await retryStudioMessage(
        session.id,
        {
          onDelta: (text) => setStreamingText((current) => current + text),
          onCandidate: (nextCandidate) => {
            gotCandidate = true;
            setCandidate(nextCandidate);
          },
          onError: (message) => {
            streamedError = message;
            toast.error(message);
          },
        },
        controller.signal,
      );
      const refreshed = await getStudioSessionSafe(session.id);
      if (refreshed) setSession(refreshed);
      if (gotCandidate && !streamedError) {
        toast.success('已重新生成补丁');
      }
    } catch (cause) {
      const aborted =
        cause instanceof DOMException
          ? cause.name === 'AbortError'
          : cause instanceof Error && /abort/i.test(cause.message);
      if (!aborted) {
        toast.error(cause instanceof Error ? cause.message : '重新生成失败');
      } else {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      const refreshed = await getStudioSessionSafe(session.id);
      if (refreshed) setSession(refreshed);
    } finally {
      abortRef.current = null;
      setChatBusy(false);
      setStreamingText('');
    }
  };

  const discardDraft = async () => {
    if (!session) return;
    setChatBusy(true);
    try {
      const result = await discardStudioSession(session.id);
      setSession(result.session);
      setFiles(
        Object.fromEntries(result.session.draft.files.map((file) => [file.path, file.content])),
      );
      setPreview(result.preview);
      setCandidate(null);
      setChatInput('');
      setDiscardOpen(false);
      void refreshSnapshots(result.session.id);
      toast.success('草稿已丢弃，恢复到当前正式版本');
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '丢弃草稿失败');
    } finally {
      setChatBusy(false);
    }
  };

  const refreshSnapshots = async (sessionId: string) => {
    try {
      const list = await listStudioSnapshots(sessionId);
      setSnapshots(list.items);
    } catch {
      // 快照列表是辅助信息
    }
  };

  const switchSession = async (id: string) => {
    if (!asset || id === session?.id) return;
    setChatBusy(true);
    try {
      const next = await getStudioSession(id);
      setSession(next);
      setCandidate(next.candidates[0] ?? null);
      setFiles(Object.fromEntries(next.draft.files.map((file) => [file.path, file.content])));
      setPreview(await getStudioSessionPreview(next.id));
      await refreshSnapshots(next.id);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '会话切换失败');
    } finally {
      setChatBusy(false);
    }
  };

  const closeCurrentSession = async () => {
    if (!session || !asset) return;
    setChatBusy(true);
    try {
      await closeStudioSession(session.id);
      const created = await createStudioSession(asset.id);
      setSession(created);
      setCandidate(created.candidates[0] ?? null);
      setFiles(
        Object.fromEntries(created.draft.files.map((file) => [file.path, file.content])),
      );
      setPreview(await getStudioSessionPreview(created.id));
      const list = await listStudioSessions(asset.id);
      setSessions(list.items);
      await refreshSnapshots(created.id);
      toast.success('会话已关闭，已创建新会话');
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '关闭会话失败');
    } finally {
      setChatBusy(false);
    }
  };

  const restoreSnapshot = async (revision: number) => {
    if (!session) return;
    setChatBusy(true);
    try {
      const result = await restoreStudioSnapshot(session.id, revision);
      setSession(result.session);
      setFiles(
        Object.fromEntries(result.session.draft.files.map((file) => [file.path, file.content])),
      );
      setPreview(result.preview);
      setCandidate(result.session.candidates[0] ?? null);
      await refreshSnapshots(session.id);
      toast.success(`已恢复草稿版本 #${revision}`);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '恢复快照失败');
    } finally {
      setChatBusy(false);
    }
  };

  const rejectCandidate = async () => {
    if (!candidate) return;
    setChatBusy(true);
    try {
      const refreshed = await rejectStudioCandidate(candidate.id);
      setSession(refreshed);
      setCandidate(
        refreshed.candidates.find((item) => item.id === candidate.id) ?? {
          ...candidate,
          status: 'rejected',
        },
      );
      toast.success('补丁已拒绝');
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '拒绝补丁失败');
    } finally {
      setChatBusy(false);
    }
  };

  const undoCandidate = async () => {
    if (!session) return;
    setChatBusy(true);
    try {
      const result = await undoStudioSession(session.id);
      setSession(result.session);
      setFiles(
        Object.fromEntries(result.session.draft.files.map((file) => [file.path, file.content])),
      );
      setPreview(result.preview);
      setCandidate(result.session.candidates[0] ?? null);
      void refreshSnapshots(result.session.id);
      toast.success('已撤销最近一次草稿修改');
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '撤销失败');
    } finally {
      setChatBusy(false);
    }
  };

  const applyCandidate = async () => {
    if (!candidate) return;
    setChatBusy(true);
    try {
      const result = await applyStudioCandidate(candidate.id);
      setSession(result.session);
      setFiles(
        Object.fromEntries(result.session.draft.files.map((file) => [file.path, file.content])),
      );
      setPreview(result.preview);
      setCandidate(
        result.session.candidates.find((item) => item.id === candidate.id) ?? {
          ...candidate,
          status: 'applied',
        },
      );
      void refreshSnapshots(result.session.id);
      toast.success('补丁已应用到草稿');
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '应用补丁失败');
    } finally {
      setChatBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-[520px] w-full" />
      </div>
    );
  }

  if (error || !asset) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <PageHeader title="工作台" description="加载资产失败" />
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="space-y-3 p-4 text-sm text-destructive">
            <p>{error ?? '资产不存在'}</p>
            <Link href="/library">
              <Button variant="outline" size="sm">
                返回资产库
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (asset.format === 'token') {
    return <TokenEditor asset={asset} onSaved={(updated) => setAsset(updated)} />;
  }

  if (asset.format !== 'package') {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <PageHeader title={asset.name} description="旧格式资产" />
        <Card>
          <CardContent className="space-y-4 p-6">
            <p className="text-sm text-muted-foreground">
              旧格式资产目前只支持浏览和 JSON 导出。
            </p>
            {asset.palette.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {asset.palette.map((color) => (
                  <span
                    key={color}
                    className="h-8 w-8 rounded border"
                    style={{ backgroundColor: color }}
                    title={color}
                  />
                ))}
              </div>
            )}
            <Link href="/library">
              <Button variant="outline" className="gap-2">
                <ArrowLeft className="h-4 w-4" />
                返回资产库
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const activeContent = files[activePath] ?? '';
  const currentFile = asset.files.find((file) => file.path === activePath);

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader
        title={asset.name}
        description={`${asset.kind}${asset.subtype ? ` · ${asset.subtype}` : ''} · v${
          asset.version?.versionNumber ?? 1
        }`}
      >
        <Link href="/library">
          <Button variant="outline" className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            返回资产库
          </Button>
        </Link>
        <Button
          variant="outline"
          className="gap-2"
          onClick={() => void load()}
          disabled={loading || saving}
        >
          <RefreshCw className="h-4 w-4" />
          重新加载
        </Button>
        <Button className="gap-2" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? '保存中…' : '保存新版本'}
        </Button>
      </PageHeader>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CardTitle className="text-base">实时预览</CardTitle>
                <Badge variant="secondary">iframe sandbox</Badge>
                {dirty && <Badge variant="outline">未保存</Badge>}
              </div>
              <div className="flex gap-1 rounded-md border p-1">
                {(['desktop', 'tablet', 'mobile'] as const).map((item) => {
                  const Icon = item === 'desktop' ? Monitor : item === 'tablet' ? Tablet : Smartphone;
                  return (
                    <Button
                      key={item}
                      variant={viewport === item ? 'secondary' : 'ghost'}
                      size="sm"
                      className="gap-1.5"
                      onClick={() => setViewport(item)}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {VIEWPORT_LABEL[item]}
                    </Button>
                  );
                })}
              </div>
            </CardHeader>
            <CardContent>
              <div className="rounded-lg border bg-slate-100 p-4">
                <div
                  className="mx-auto overflow-hidden rounded-md border bg-white shadow-sm"
                  style={{ maxWidth: VIEWPORT_WIDTH[viewport] }}
                >
                  {preview ? (
                    <iframe
                      key={`${asset.id}-${viewport}-${asset.version?.id ?? ''}`}
                      title={`${asset.name} 预览`}
                      sandbox="allow-scripts"
                      srcDoc={preview.html}
                      className="h-[520px] w-full bg-transparent"
                    />
                  ) : (
                    <Skeleton className="h-[520px] w-full" />
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <FileCode2 className="h-4 w-4" />
                源码
              </CardTitle>
              <div className="flex items-center gap-2">
                <Input
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                  className="h-8 w-48 text-xs"
                  placeholder="版本说明"
                />
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-1">
                {asset.files.map((file) => (
                  <Button
                    key={file.path}
                    variant={activePath === file.path ? 'secondary' : 'outline'}
                    size="sm"
                    className="max-w-full truncate font-mono text-[11px]"
                    onClick={() => setActivePath(file.path)}
                  >
                    {file.target ?? file.path}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {currentFile?.target ?? activePath}
              </p>
              <Textarea
                value={activeContent}
                onChange={(event) =>
                  setFiles((current) => ({ ...current, [activePath]: event.target.value }))
                }
                className="min-h-[360px] font-mono text-xs leading-relaxed"
                spellCheck={false}
              />
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">资产信息</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">slug</span>
                <code className="text-xs">{asset.slug}</code>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">版本</span>
                <Badge variant="outline">v{asset.version?.versionNumber ?? 1}</Badge>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">文件</span>
                <span>{asset.files.length}</span>
              </div>
              <Separator />
              <div>
                <p className="text-xs text-muted-foreground">标签</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {asset.tags.length ? (
                    asset.tags.map((tag) => (
                      <Badge key={tag} variant="outline" className="text-[10px]">
                        {tag}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-xs text-muted-foreground">无</span>
                  )}
                </div>
              </div>
              <Separator />
              <p className="text-xs text-muted-foreground">
                AI 对话调整、草稿和候选 Patch 还没接入；当前先支持源码编辑与保存新版本。
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">保存行为</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-muted-foreground">
              <p>保存会创建新的不可变版本，并自动生成桌面封面。</p>
              <p>预览与快照使用同一份源码；保存前会校验 import 白名单、路径和编译。</p>
              <p>旧版本可以在资产库详情里对比，不会覆盖。</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <MessageSquare className="h-4 w-4" />
                AI 对话
              </CardTitle>
              {session && (
                <div className="flex items-center gap-1">
                  <Select
                    value={session.id}
                    onValueChange={(value) => void switchSession(value)}
                    disabled={chatBusy || draftDirty}
                  >
                    <SelectTrigger className="h-7 w-28 text-[10px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {sessions
                        .filter((item) => item.status === 'open')
                        .map((item) => (
                          <SelectItem key={item.id} value={item.id} className="text-xs">
                            {item.messageCount} 条 · {item.draft?.revision ?? 1} 版
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-1.5 text-[10px] text-muted-foreground"
                    onClick={() => void closeCurrentSession()}
                    disabled={chatBusy || draftDirty}
                    title={draftDirty ? '先保存或丢弃本地修改' : undefined}
                  >
                    关闭
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-1.5 text-[10px] text-muted-foreground"
                    onClick={() => setDiscardOpen(true)}
                    disabled={chatBusy}
                  >
                    丢弃
                  </Button>
                </div>
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              {!session ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    创建一个草稿会话，让 AI 基于当前源码生成补丁。补丁不会直接改正式版本。
                  </p>
                  <Button
                    className="w-full gap-2"
                    onClick={() => void startChat()}
                    disabled={chatBusy}
                  >
                    {chatBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <MessageSquare className="h-4 w-4" />
                    )}
                    开始 AI 对话
                  </Button>
                </div>
              ) : (
                <>
                  <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                    {session.messages.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        描述你想改什么，例如「把按钮文案改成继续，其他不要动」。
                      </p>
                    )}
                    {session.messages.map((message) => (
                      <div
                        key={message.id}
                        className={cn(
                          'rounded-md px-2 py-1.5 text-xs leading-relaxed',
                          message.role === 'user'
                            ? 'ml-5 bg-primary text-primary-foreground'
                            : 'mr-5 bg-muted',
                          message.status === 'error' && 'bg-destructive/10 text-destructive',
                        )}
                      >
                        {message.content}
                      </div>
                    ))}
                    {streamingText && (
                      <div className="mr-5 space-y-1 rounded-md border border-dashed bg-muted/50 p-2">
                        <p className="text-[10px] text-muted-foreground">AI 正在生成补丁…</p>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-muted-foreground">
                          {streamingText}
                        </pre>
                      </div>
                    )}
                  </div>

                  {session.messages.some((message) => message.role === 'user') && !chatBusy && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full gap-2"
                      onClick={() => void retryChat()}
                      disabled={draftDirty}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      重新生成
                    </Button>
                  )}

                  {session.candidates.some((item) => item.status === 'applied') &&
                    candidate?.status !== 'applied' && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full gap-2"
                        onClick={() => void undoCandidate()}
                        disabled={chatBusy || draftDirty}
                      >
                        <Undo2 className="h-3.5 w-3.5" />
                        撤销最近修改
                      </Button>
                    )}

                  {candidate && (
                    <div className="space-y-2 rounded-md border bg-muted/30 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-medium">{candidate.label}</p>
                        {candidate.status === 'applied' ? (
                          <Badge variant="outline" className="gap-1 text-[10px] text-emerald-600">
                            <CheckCircle2 className="h-3 w-3" />
                            已应用
                          </Badge>
                        ) : candidate.status === 'rejected' ? (
                          <Badge variant="destructive" className="text-[10px]">
                            已拒绝
                          </Badge>
                        ) : candidate.status === 'undone' ? (
                          <Badge variant="outline" className="text-[10px]">
                            已撤销
                          </Badge>
                        ) : candidate.status === 'discarded' ? (
                          <Badge variant="outline" className="text-[10px]">
                            已丢弃
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            {candidate.status}
                          </Badge>
                        )}
                      </div>
                      {candidate.rationale && (
                        <p className="text-[11px] text-muted-foreground">{candidate.rationale}</p>
                      )}
                      <div className="flex flex-wrap gap-1">
                        {candidate.changedPaths.map((path) => (
                          <Badge key={path} variant="outline" className="font-mono text-[10px]">
                            {path}
                          </Badge>
                        ))}
                      </div>
                      {candidate.diff.length > 0 && (
                        <details className="rounded border bg-background p-2">
                          <summary className="cursor-pointer text-[11px] text-muted-foreground">
                            查看 diff · {candidate.diff.length} 个文件
                          </summary>
                          <div className="mt-2 space-y-3">
                            {candidate.diff.map((file) => {
                              const hunks = diffHunks(file.before, file.after);
                              const added = hunks.reduce(
                                (total, hunk) =>
                                  total +
                                  hunk.lines.filter((line) => line.type === 'add').length,
                                0,
                              );
                              const removed = hunks.reduce(
                                (total, hunk) =>
                                  total +
                                  hunk.lines.filter((line) => line.type === 'remove').length,
                                0,
                              );
                              return (
                                <div key={file.path} className="space-y-1">
                                  <div className="flex items-center justify-between gap-2">
                                    <p className="truncate font-mono text-[10px] text-muted-foreground">
                                      {file.path}
                                    </p>
                                    <span className="shrink-0 text-[10px] text-muted-foreground">
                                      +{added} -{removed}
                                    </span>
                                  </div>
                                  {hunks.length === 0 ? (
                                    <p className="text-[10px] text-muted-foreground">内容无变化</p>
                                  ) : (
                                    <div className="max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-[10px] leading-relaxed">
                                      {hunks.map((hunk, hunkIndex) => (
                                        <div
                                          key={`${file.path}-${hunk.beforeStart}-${hunk.afterStart}-${hunkIndex}`}
                                          className="mb-2 last:mb-0"
                                        >
                                          <div className="text-muted-foreground">
                                            @@ -{hunk.beforeStart},{hunk.beforeCount} +{hunk.afterStart},
                                            {hunk.afterCount} @@
                                          </div>
                                          {hunk.lines.map((line, lineIndex) => (
                                            <div
                                              key={`${hunkIndex}-${lineIndex}`}
                                              className={cn(
                                                'flex whitespace-pre-wrap',
                                                line.type === 'add' &&
                                                  'bg-emerald-50 text-emerald-700',
                                                line.type === 'remove' &&
                                                  'bg-rose-50 text-rose-700',
                                              )}
                                            >
                                              <span className="w-10 shrink-0 select-none pr-1 text-right text-muted-foreground">
                                                {line.beforeLine ?? ''}
                                              </span>
                                              <span className="w-10 shrink-0 select-none pr-1 text-right text-muted-foreground">
                                                {line.afterLine ?? ''}
                                              </span>
                                              <span className="w-3 shrink-0 select-none">
                                                {line.type === 'add'
                                                  ? '+'
                                                  : line.type === 'remove'
                                                    ? '-'
                                                    : ' '}
                                              </span>
                                              <span>{line.text || ' '}</span>
                                            </div>
                                          ))}
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </details>
                      )}
                      {candidate.status === 'planned' && (
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            className="flex-1 gap-2"
                            onClick={() => void applyCandidate()}
                            disabled={chatBusy || draftDirty}
                            title={draftDirty ? '本地修改尚未同步到草稿' : undefined}
                          >
                            {chatBusy ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            )}
                            应用
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="flex-1 gap-2"
                            onClick={() => void rejectCandidate()}
                            disabled={chatBusy}
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            拒绝
                          </Button>
                        </div>
                      )}
                      {candidate.status === 'applied' && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full gap-2"
                          onClick={() => void undoCandidate()}
                          disabled={chatBusy || draftDirty}
                        >
                          <Undo2 className="h-3.5 w-3.5" />
                          撤销到上一版
                        </Button>
                      )}
                    </div>
                  )}

                  {draftDirty && (
                    <p className="text-[11px] text-amber-600">
                      本地有未同步到草稿的修改，请先「保存新版本」或「丢弃草稿」再使用 AI。
                    </p>
                  )}
                  <Textarea
                    value={chatInput}
                    onChange={(event) => setChatInput(event.target.value)}
                    placeholder="描述修改要求…"
                    className="min-h-16 text-xs"
                    spellCheck={false}
                  />
                  {chatBusy ? (
                    <Button
                      variant="outline"
                      className="w-full gap-2"
                      onClick={stopChat}
                    >
                      <XCircle className="h-4 w-4" />
                      停止生成
                    </Button>
                  ) : (
                    <Button
                      className="w-full gap-2"
                      onClick={() => void sendChat()}
                      disabled={draftDirty || chatInput.trim().length < 2}
                    >
                      <Send className="h-4 w-4" />
                      发送
                    </Button>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">草稿历史</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {snapshots.length === 0 ? (
                <p className="text-xs text-muted-foreground">还没有草稿快照。</p>
              ) : (
                snapshots.slice(0, 6).map((snapshot) => (
                  <div
                    key={snapshot.id}
                    className="flex items-center justify-between gap-2 rounded-md border p-2"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-medium">#{snapshot.revision}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {new Date(snapshot.createdAt).toLocaleString('zh-CN')} · {snapshot.fileCount} 个文件
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-[10px]"
                      onClick={() => void restoreSnapshot(snapshot.revision)}
                      disabled={chatBusy || draftDirty}
                    >
                      恢复
                    </Button>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </aside>
      </div>

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="丢弃当前草稿？"
        description="草稿会恢复到当前正式版本，所有未保存的 AI 修改和候选补丁都会失效。"
        confirmLabel="丢弃草稿"
        variant="destructive"
        onConfirm={discardDraft}
      />
    </div>
  );
}
