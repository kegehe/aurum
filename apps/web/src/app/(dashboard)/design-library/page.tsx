'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Clipboard, FilePlus2, History, Loader2, Plus, RefreshCw, Send, Sparkles, Undo2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/shared/page-header';
import { cn } from '@/lib/utils';
import { cancelDesignTask, createCandidate, createChangeSet, createDesignDocument, createDraft, getCandidatePreviewUrl, getDesignDocument, listCandidatePreviews, listCandidates, listDesignDocuments, listDesignTasks, listReadyDrafts, publishChangeSet, publishDraft, queueAiCandidates, renderAndValidateCandidate, restoreDesignVersion, retryDesignTask, selectCandidate, type Candidate, type CandidatePreview, type DesignDocument, type DesignKind, type DesignTask } from '@/lib/api/design';

const KINDS: Array<{ value: DesignKind; label: string }> = [
  { value: 'foundation', label: '基础规范' }, { value: 'theme', label: '主题' }, { value: 'component', label: '组件' }, { value: 'layout', label: '布局' }, { value: 'style_pack', label: '样式包' },
];

const EXAMPLES: Record<DesignKind, Record<string, unknown>> = {
  foundation: { tokenSchemaVersion: 'aurum.tokens.v1', tokens: { color: { brand: { $type: 'color', $value: '#1f6feb' } } } },
  theme: { tokenSchemaVersion: 'aurum.tokens.v1', tokens: { surface: { page: { $type: 'color', $value: '#ffffff' } }, text: { primary: { $type: 'color', $value: '#172033' } } } },
  component: { schemaVersion: 'aurum.component.v1', componentType: 'button', variants: { primary: { tone: 'brand', size: 'md' } } },
  layout: { schemaVersion: 'aurum.layout.v1', layoutType: 'app-shell', regions: [{ id: 'sidebar', role: 'navigation' }, { id: 'main', role: 'main' }] },
  style_pack: { schemaVersion: 'aurum.style-pack.v1', dependencies: [] },
};

export default function DesignLibraryPage() {
  const [documents, setDocuments] = useState<DesignDocument[]>([]);
  const [selected, setSelected] = useState<DesignDocument | null>(null);
  const [kind, setKind] = useState<DesignKind>('theme');
  const [loading, setLoading] = useState(true);
  const [candidateText, setCandidateText] = useState('');
  const [aiIntent, setAiIntent] = useState('');
  const [draftId, setDraftId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candidatePreviews, setCandidatePreviews] = useState<Record<string, CandidatePreview[]>>({});
  const [tasks, setTasks] = useState<DesignTask[]>([]);
  const [working, setWorking] = useState(false);
  const [readyDrafts, setReadyDrafts] = useState<Array<{ id: string; document: { id: string; name: string; kind: DesignKind }; candidates: Array<{ id: string; label: string }> }>>([]);
  const [selectedDraftIds, setSelectedDraftIds] = useState<string[]>([]);

  const refresh = async (preserveId?: string) => {
    setLoading(true);
    try {
      const next = await listDesignDocuments();
      setDocuments(next);
      const id = preserveId ?? selected?.id;
      const item = id ? next.find((entry) => entry.id === id) : next[0];
      if (item) await choose(item.id);
      else setSelected(null);
    } catch (error) { toast.error(error instanceof Error ? error.message : '读取设计目录失败'); } finally { setLoading(false); }
  };
  const choose = async (id: string) => {
    try {
      const doc = await getDesignDocument(id);
      setSelected(doc);
      setDraftId(null); setCandidates([]); setCandidatePreviews({});
      const current = doc.currentPublishedVersion;
      setCandidateText(current?.content ? JSON.stringify(JSON.parse(current.content), null, 2) : '');
    } catch (error) { toast.error(error instanceof Error ? error.message : '读取设计文档失败'); }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { listReadyDrafts().then(setReadyDrafts).catch(() => undefined); }, [draftId, selected]);
  const refreshDraftState = async (id: string) => {
    const nextCandidates = await listCandidates(id);
    setCandidates(nextCandidates);
    const previews = await Promise.all(nextCandidates.map(async (candidate) => [candidate.id, await listCandidatePreviews(candidate.id).catch(() => [])] as const));
    setCandidatePreviews(Object.fromEntries(previews));
    setTasks(await listDesignTasks());
  };
  useEffect(() => {
    if (!draftId) return;
    void refreshDraftState(draftId).catch(() => undefined);
    const timer = window.setInterval(() => { void refreshDraftState(draftId).catch(() => undefined); }, 3_000);
    return () => window.clearInterval(timer);
  }, [draftId]);

  const currentContent = useMemo(() => selected?.currentPublishedVersion?.content ?? '', [selected]);
  const create = async () => {
    const name = window.prompt('设计文档名称');
    if (!name) return;
    const slug = window.prompt('唯一 slug（小写连字符）', name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
    if (!slug) return;
    setWorking(true);
    try {
      const document = await createDesignDocument({ name, slug, kind, content: EXAMPLES[kind] });
      toast.success('已创建并发布初始版本');
      await refresh(document.id);
    } catch (error) { toast.error(error instanceof Error ? error.message : '创建失败'); } finally { setWorking(false); }
  };
  const beginDraft = async () => {
    if (!selected) return;
    setWorking(true);
    try { const draft = await createDraft(selected.id); setDraftId(draft.id); setCandidates([]); setCandidatePreviews({}); toast.success('草稿已创建'); }
    catch (error) { toast.error(error instanceof Error ? error.message : '创建草稿失败'); } finally { setWorking(false); }
  };
  const propose = async () => {
    if (!draftId) return;
    let content: Record<string, unknown>;
    try { content = JSON.parse(candidateText); } catch { toast.error('候选 JSON 无法解析'); return; }
    setWorking(true);
    try {
      const candidate = await createCandidate(draftId, { label: `方案 ${String.fromCharCode(65 + candidates.length)}`, content, rationale: '由运营台手工调整' });
      await renderAndValidateCandidate(candidate.id);
      await refreshDraftState(draftId);
      toast.success('候选已加入校验队列');
    } catch (error) { toast.error(error instanceof Error ? error.message : '生成候选失败'); } finally { setWorking(false); }
  };
  const publish = async (candidate: Candidate) => {
    if (!draftId || !selected) return;
    setWorking(true);
    try { await selectCandidate(candidate.id); await publishDraft(draftId); toast.success('已发布新版本'); await refresh(selected.id); }
    catch (error) { toast.error(error instanceof Error ? error.message : '发布失败'); } finally { setWorking(false); }
  };
  const askAi = async () => {
    if (!draftId || aiIntent.trim().length < 2) { toast.error('请输入明确的调整意图'); return; }
    setWorking(true);
    try {
      await queueAiCandidates(draftId, { intent: aiIntent.trim(), count: 3 });
      toast.success('AI 已加入候选生成队列');
      window.setTimeout(() => { void refreshDraftState(draftId).catch(() => undefined); }, 1_000);
    } catch (error) { toast.error(error instanceof Error ? error.message : 'AI 任务创建失败'); } finally { setWorking(false); }
  };
  const restore = async (versionId: string) => {
    if (!selected || !window.confirm('恢复会创建一个新的正式版本，确认继续？')) return;
    setWorking(true);
    try { await restoreDesignVersion(selected.id, versionId); toast.success('已创建恢复版本'); await refresh(selected.id); }
    catch (error) { toast.error(error instanceof Error ? error.message : '恢复失败'); } finally { setWorking(false); }
  };
  const publishMulti = async () => {
    if (selectedDraftIds.length < 2) { toast.error('至少选择两个 ready 草稿'); return; }
    setWorking(true);
    try { const changeSet = await createChangeSet(selectedDraftIds); await publishChangeSet(changeSet.id); toast.success('多文档 ChangeSet 已原子发布'); setSelectedDraftIds([]); setReadyDrafts(await listReadyDrafts()); await refresh(selected?.id); }
    catch (error) { toast.error(error instanceof Error ? error.message : '多文档发布失败'); } finally { setWorking(false); }
  };
  const operateTask = async (task: DesignTask, operation: 'cancel' | 'retry') => {
    setWorking(true);
    try {
      if (operation === 'cancel') await cancelDesignTask(task.id); else await retryDesignTask(task.id);
      if (draftId) await refreshDraftState(draftId);
    } catch (error) { toast.error(error instanceof Error ? error.message : '任务操作失败'); } finally { setWorking(false); }
  };

  return <div className="mx-auto max-w-7xl space-y-5">
    <PageHeader title="设计运营台" description="内部设计规范、候选方案与不可变发布版本"><Button onClick={create} disabled={working} className="gap-2"><Plus className="h-4 w-4" />新建设计资产</Button></PageHeader>
    <div className="flex flex-wrap items-center gap-2 border-b pb-3">
      {KINDS.map((item) => <Button key={item.value} variant={kind === item.value ? 'default' : 'outline'} size="sm" onClick={() => setKind(item.value)}>{item.label}</Button>)}
    </div>
    {readyDrafts.length > 1 && <section className="rounded-md border border-amber-200 bg-amber-50 p-3"><div className="mb-2 flex items-center justify-between gap-3"><div><p className="text-sm font-medium text-amber-950">跨文档原子发布</p><p className="text-xs text-amber-900">选择多个已校验草稿，在同一个事务中发布。</p></div><Button size="sm" onClick={publishMulti} disabled={working || selectedDraftIds.length < 2}>发布 ChangeSet</Button></div><div className="flex flex-wrap gap-2">{readyDrafts.map((draft) => <label key={draft.id} className="flex cursor-pointer items-center gap-2 rounded border bg-white px-2 py-1 text-xs"><input type="checkbox" checked={selectedDraftIds.includes(draft.id)} onChange={(event) => setSelectedDraftIds((current) => event.target.checked ? [...current, draft.id] : current.filter((id) => id !== draft.id))} />{draft.document.name} · {draft.candidates[0]?.label ?? '已选择候选'}</label>)}</div></section>}
    <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)_280px]">
      <aside className="min-h-[540px] border-r pr-3">{loading ? <Loader2 className="m-4 h-5 w-5 animate-spin" /> : documents.filter((item) => item.kind === kind).map((item) => <button key={item.id} onClick={() => void choose(item.id)} className={cn('mb-1 w-full rounded-md px-3 py-2 text-left', selected?.id === item.id ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}><div className="truncate text-sm font-medium">{item.name}</div><div className="text-xs opacity-70">v{item.currentPublishedVersion?.versionNumber ?? 0}</div></button>)}</aside>
      <main className="min-w-0 space-y-4">{selected ? <>
        <section className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">{selected.name}</h2><p className="text-sm text-muted-foreground">{selected.slug} · 已发布 v{selected.currentPublishedVersion?.versionNumber}</p></div><div className="flex gap-2"><Button variant="outline" size="icon" title="复制正式规范" onClick={() => navigator.clipboard.writeText(currentContent).then(() => toast.success('已复制'))}><Clipboard className="h-4 w-4" /></Button><Button onClick={beginDraft} disabled={working || !!draftId} className="gap-2"><FilePlus2 className="h-4 w-4" />创建草稿</Button></div></section>
        <section className="rounded-md border"><div className="border-b px-3 py-2 text-sm font-medium">正式规范</div><pre className="max-h-64 overflow-auto p-3 text-xs leading-5">{currentContent}</pre></section>
        {draftId && <section className="space-y-3 rounded-md border p-4"><div className="flex items-center justify-between"><div><h3 className="font-medium">草稿候选</h3><p className="text-xs text-muted-foreground">AI 只能生成候选，候选必须完成三视口校验后才可发布。</p></div><Button onClick={propose} disabled={working} className="gap-2"><Send className="h-4 w-4" />手工生成</Button></div><div className="grid gap-2 sm:grid-cols-[1fr_auto]"><Textarea value={aiIntent} onChange={(e) => setAiIntent(e.target.value)} placeholder="例如：保持表格密度，把主题调整为沉稳的蓝灰色，提高强调色对比度。" className="min-h-20 text-sm" /><Button onClick={askAi} disabled={working} className="gap-2"><Sparkles className="h-4 w-4" />AI 生成候选</Button></div><Textarea value={candidateText} onChange={(e) => setCandidateText(e.target.value)} className="min-h-72 font-mono text-xs" />{candidates.map((candidate) => <div key={candidate.id} className="space-y-3 border-t pt-3"><div className="flex items-center justify-between gap-3"><div><Badge>{candidate.status}</Badge><span className="ml-2 text-sm">{candidate.label}</span><p className="mt-1 text-xs text-muted-foreground">{candidate.rationale}</p></div><Button size="sm" onClick={() => publish(candidate)} disabled={working || candidate.status !== 'validated'} className="gap-1"><Check className="h-4 w-4" />选择并发布</Button></div>{candidate.structuredDiff && <details><summary className="cursor-pointer text-xs text-muted-foreground">查看结构化 Diff</summary><pre className="mt-2 max-h-40 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(JSON.parse(candidate.structuredDiff), null, 2)}</pre></details>}{candidatePreviews[candidate.id]?.length ? <details><summary className="cursor-pointer text-xs text-muted-foreground">查看三端视觉 Diff</summary><div className="mt-3 grid gap-3 lg:grid-cols-3">{candidatePreviews[candidate.id].map((preview) => <div key={preview.viewport} className="min-w-0 space-y-2"><div className="flex items-center justify-between text-xs"><span>{preview.viewport}</span><span className="text-muted-foreground">{preview.changedPixels?.toLocaleString() ?? 0} px changed</span></div><div className="grid grid-cols-2 gap-2"><img className="aspect-[4/3] w-full rounded border object-cover object-top" alt={`${preview.viewport} candidate`} src={getCandidatePreviewUrl(candidate.id, preview.viewport, 'snapshot')} />{preview.diffUrl ? <img className="aspect-[4/3] w-full rounded border object-cover object-top" alt={`${preview.viewport} diff`} src={getCandidatePreviewUrl(candidate.id, preview.viewport, 'diff')} /> : <div className="aspect-[4/3] rounded border bg-muted" />}</div></div>)}</div></details> : null}</div>)}<div className="border-t pt-3"><div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-medium">任务队列</h3><Button variant="ghost" size="icon" title="刷新任务" disabled={working} onClick={() => draftId && void refreshDraftState(draftId)}><RefreshCw className="h-4 w-4" /></Button></div><div className="space-y-2">{tasks.filter((task) => !task.candidateId || candidates.some((candidate) => candidate.id === task.candidateId)).slice(0, 8).map((task) => <div key={task.id} className="flex items-center justify-between gap-3 rounded border px-2 py-2 text-xs"><div className="min-w-0"><span>{task.taskType}</span><Badge className="ml-2" variant="secondary">{task.status}</Badge>{task.errorMessage ? <p className="mt-1 truncate text-destructive">{task.errorMessage}</p> : null}</div><div className="flex shrink-0 gap-1">{['pending', 'running'].includes(task.status) ? <Button variant="ghost" size="icon" title="取消任务" disabled={working} onClick={() => operateTask(task, 'cancel')}><X className="h-4 w-4" /></Button> : null}{task.status === 'failed' ? <Button variant="ghost" size="icon" title="重试任务" disabled={working || task.retryCount >= 3} onClick={() => operateTask(task, 'retry')}><RefreshCw className="h-4 w-4" /></Button> : null}</div></div>)}</div></div></section>}
      </> : <div className="py-24 text-center text-sm text-muted-foreground">选择或新建设计资产</div>}</main>
      <aside className="border-l pl-4"><div className="mb-3 flex items-center gap-2 text-sm font-medium"><History className="h-4 w-4" />版本历史</div>{selected?.versions?.map((version) => <div key={version.id} className="mb-3 border-b pb-3"><div className="flex items-center justify-between"><span className="text-sm font-medium">v{version.versionNumber}</span>{version.id !== selected.currentPublishedVersion?.id && <Button variant="ghost" size="icon" title="恢复为新版本" onClick={() => restore(version.id)} disabled={working}><Undo2 className="h-4 w-4" /></Button>}</div><p className="mt-1 text-xs text-muted-foreground">{version.summary || '无摘要'}</p></div>)}</aside>
    </div>
  </div>;
}
