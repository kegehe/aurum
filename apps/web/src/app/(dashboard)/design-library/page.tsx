'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Check,
  ClipboardList,
  Copy,
  ImagePlus,
  Loader2,
  RefreshCw,
  Save,
  Sparkles,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { PageHeader } from '@/components/shared/page-header';
import { cn } from '@/lib/utils';
import { analyzeStyle } from '@/lib/api/style';
import {
  composeDesignGenerate,
  composeDesignPreview,
  composeDesignPublish,
  composeDesignRecipe,
  getDesignTask,
  listDesignDocuments,
  listDesignRecipes,
  type ComposePreviewResult,
  type DesignControl,
  type DesignDocument,
  type DesignGate,
  type DesignKind,
  type DesignRecipeSummary,
  type DesignTask,
} from '@/lib/api/design';

type Category = DesignRecipeSummary['category'];

interface CategorySpec {
  value: Category;
  label: string;
  kind: DesignKind;
  hint: string;
}

const CATEGORIES: CategorySpec[] = [
  { value: 'palette', label: '配色', kind: 'theme', hint: '整套界面的颜色、圆角与间距' },
  { value: 'button', label: '按钮', kind: 'component', hint: '可以被点的操作' },
  { value: 'card', label: '卡片', kind: 'component', hint: '装信息的容器' },
  { value: 'text', label: '文字', kind: 'component', hint: '标题与强调' },
  { value: 'motion', label: '动效', kind: 'animation', hint: '进场与持续动画' },
];

const POLL_MS = 1_500;
/** 约两分钟。超时不是失败——产物仍然在审核台里，只是这一轮不继续等。 */
const POLL_LIMIT = 80;

interface Proposal {
  label: string;
  rationale: string;
  content: Record<string, unknown>;
  kind: DesignKind;
}

/**
 * 预览舞台。
 *
 * 给一层柔和的彩色底：玻璃拟态、发光、半透明这类效果的观感取决于背景，
 * 放在纯白上会显得"什么都没有"，用户会以为效果没生效。
 */
const STAGE_CSS = `
html,body{margin:0;padding:0;background:transparent}
body{min-height:180px;display:flex;align-items:center;justify-content:center;padding:28px;
  font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#0f172a;
  background-image:linear-gradient(135deg,#dde7f7 0%,#f7e6f0 48%,#dff1ea 100%)}
`;

function buildSrcDoc(css: string, html: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${STAGE_CSS}${css}</style></head><body>${html}</body></html>`;
}

function randomSlug(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function messageOf(error: unknown, fallback = '操作失败'): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function pollTask(taskId: string): Promise<DesignTask> {
  for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
    const task = await getDesignTask(taskId);
    if (['succeeded', 'failed', 'canceled'].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error('等待超时。任务仍在后台跑，可到审核台看结果。');
}

function readTaskPayload(task: DesignTask): {
  candidates?: Proposal[];
  failures?: Array<{ label: string; error: string }>;
} {
  if (!task.result) return {};
  try {
    return JSON.parse(task.result) as ReturnType<typeof readTaskPayload>;
  } catch {
    return {};
  }
}

function gateText(gate?: DesignGate | null): string {
  if (!gate) return '发布门禁未通过';
  return gate.errors.length ? gate.errors.join('；') : '发布门禁未通过';
}

export default function DesignWizardPage() {
  const [documents, setDocuments] = useState<DesignDocument[]>([]);
  const [recipes, setRecipes] = useState<DesignRecipeSummary[]>([]);
  const [themeId, setThemeId] = useState('');
  const [category, setCategory] = useState<Category>('card');
  const [intent, setIntent] = useState('');
  const [recipeId, setRecipeId] = useState<string | null>(null);
  const [reference, setReference] = useState<Record<string, unknown> | null>(null);
  const [referenceLabel, setReferenceLabel] = useState('');
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [preview, setPreview] = useState<ComposePreviewResult | null>(null);
  const [edits, setEdits] = useState<Record<string, string | number>>({});
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState<null | 'generate' | 'preview' | 'publish' | 'reference'>(null);
  const [blocked, setBlocked] = useState<DesignGate | null>(null);
  const [published, setPublished] = useState(false);
  const [stageKey, setStageKey] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewSeq = useRef(0);
  const debounceRef = useRef<number | null>(null);

  const themeDocuments = useMemo(
    () => documents.filter((item) => item.kind === 'theme' && item.currentPublishedVersion?.id),
    [documents],
  );
  const spec = CATEGORIES.find((item) => item.value === category) ?? CATEGORIES[1];
  const selected = proposals[selectedIndex];
  const activeKind = selected?.kind ?? spec.kind;

  const refresh = useCallback(async (preserveThemeId?: string) => {
    try {
      const [list, recipeList] = await Promise.all([listDesignDocuments(), listDesignRecipes()]);
      setDocuments(list);
      setRecipes(recipeList);
      const themes = list.filter(
        (item) => item.kind === 'theme' && item.currentPublishedVersion?.id,
      );
      setThemeId((current) => preserveThemeId ?? current ?? themes[0]?.id ?? '');
    } catch (error) {
      toast.error(messageOf(error, '加载失败'));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runPreview = useCallback(
    async (
      kind: DesignKind,
      content: Record<string, unknown>,
      nextEdits: Record<string, string | number>,
    ) => {
      const seq = previewSeq.current + 1;
      previewSeq.current = seq;
      setBusy('preview');
      try {
        const result = await composeDesignPreview({
          kind,
          content,
          themeDocumentId: kind === 'theme' ? undefined : themeId || undefined,
          edits: nextEdits,
        });
        // 丢弃过期响应：拖滑块会连发多次，先发的后到会把画布刷回旧值
        if (seq !== previewSeq.current) return;
        setPreview(result);
      } catch (error) {
        if (seq === previewSeq.current) toast.error(messageOf(error, '预览失败'));
      } finally {
        if (seq === previewSeq.current) setBusy(null);
      }
    },
    [themeId],
  );

  const schedulePreview = useCallback(
    (
      kind: DesignKind,
      content: Record<string, unknown>,
      nextEdits: Record<string, string | number>,
    ) => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        void runPreview(kind, content, nextEdits);
      }, 120);
    },
    [runPreview],
  );

  const chooseProposal = (index: number) => {
    const proposal = proposals[index];
    if (!proposal) return;
    setSelectedIndex(index);
    setEdits({});
    setBlocked(null);
    setPublished(false);
    void runPreview(proposal.kind, proposal.content, {});
  };

  const useRecipe = async (recipe: DesignRecipeSummary) => {
    // 组件与动效的颜色/圆角都要从配色里取。没有配色就发出去的话，服务端结构校验会
    // 抛出"必须声明钉住的依赖版本"——那是给开发看的，不是给使用者看的。
    if (recipe.kind !== 'theme' && !themeId) {
      toast.error('先在上面装一套配色，颜色才有地方取');
      return;
    }
    setBusy('preview');
    setBlocked(null);
    setPublished(false);
    setRecipeId(recipe.id);
    try {
      const result = await composeDesignRecipe({
        recipeId: recipe.id,
        themeDocumentId: recipe.kind === 'theme' ? undefined : themeId || undefined,
      });
      setProposals([
        { label: recipe.name, rationale: recipe.blurb, content: result.content, kind: recipe.kind },
      ]);
      setSelectedIndex(0);
      setEdits({});
      setPreview(result);
      if (!name.trim() || proposals.length === 0) {
        setName(recipe.name);
        setSlug(recipe.id);
      }
    } catch (error) {
      toast.error(messageOf(error, '配方加载失败'));
    } finally {
      setBusy(null);
    }
  };

  const installPalette = async (recipe: DesignRecipeSummary) => {
    const existing = documents.find((item) => item.slug === recipe.id);
    if (existing?.currentPublishedVersion?.id) {
      setThemeId(existing.id);
      toast.success(`已选用「${recipe.name}」`);
      return;
    }
    setBusy('publish');
    try {
      const composed = await composeDesignRecipe({ recipeId: recipe.id });
      const result = await composeDesignPublish({
        kind: 'theme',
        name: recipe.name,
        slug: recipe.id,
        content: composed.content,
        summary: `内置配色：${recipe.blurb}`,
      });
      if (!result.published) {
        toast.error(gateText(result.gate));
        return;
      }
      const task = result.taskId ? await pollTask(result.taskId) : null;
      if (task && task.status !== 'succeeded') {
        toast.error(task.errorMessage ?? '配色发布失败');
        return;
      }
      toast.success(`配色「${recipe.name}」已就绪`);
      await refresh(result.documentId);
    } catch (error) {
      toast.error(messageOf(error, '配色创建失败'));
    } finally {
      setBusy(null);
    }
  };

  const generate = async () => {
    if (intent.trim().length < 2) {
      toast.error('先用一句话描述你想要的效果');
      return;
    }
    if (spec.kind !== 'theme' && !themeId) {
      toast.error('先选一套配色，颜色才有地方取');
      return;
    }
    setBusy('generate');
    setBlocked(null);
    setPublished(false);
    try {
      const { taskId } = await composeDesignGenerate({
        kind: spec.kind,
        intent: intent.trim(),
        themeDocumentId: themeId || undefined,
        recipeId: recipeId ?? undefined,
        reference: reference ?? undefined,
        count: 3,
      });
      const task = await pollTask(taskId);
      if (task.status !== 'succeeded') {
        toast.error(task.errorMessage ?? '生成失败');
        return;
      }
      const payload = readTaskPayload(task);
      const list = (payload.candidates ?? []).map((item) => ({ ...item, kind: spec.kind }));
      if (!list.length) {
        toast.error('没有生成出可用方案，换个说法再试一次');
        return;
      }
      setProposals(list);
      setSelectedIndex(0);
      setEdits({});
      if (payload.failures?.length) {
        // 部分成功要如实告知：用户会奇怪为什么只有两个方案
        toast.warning(`${payload.failures.length} 个方案没过校验，已跳过`);
      }
      if (!name.trim() || proposals.length === 0) {
        setName(spec.label);
        setSlug(randomSlug(spec.kind === 'animation' ? 'motion' : 'style'));
      }
      void runPreview(spec.kind, list[0].content, {});
    } catch (error) {
      toast.error(messageOf(error, '生成失败'));
    } finally {
      setBusy(null);
    }
  };

  const changeControl = (control: DesignControl, value: string | number) => {
    if (!selected) return;
    const next = { ...edits, [control.key]: value };
    setEdits(next);
    schedulePreview(selected.kind, selected.content, next);
  };

  const attachImage = async (file: File) => {
    setBusy('reference');
    try {
      const result = await analyzeStyle(file);
      setReference(result.profile as unknown as Record<string, unknown>);
      setReferenceLabel(
        `${result.image.width}×${result.image.height} · ${result.source === 'ai' ? 'AI 分析' : '本地分析'}`,
      );
      toast.success('参考图已附上，生成时会参考它的配色与质感');
    } catch (error) {
      toast.error(messageOf(error, '参考图分析失败'));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!preview || !selected) return;
    if (!name.trim() || !slug.trim()) {
      toast.error('给这个样式起个名字');
      return;
    }
    setBusy('publish');
    setBlocked(null);
    setPublished(false);
    try {
      const result = await composeDesignPublish({
        kind: activeKind,
        name: name.trim(),
        slug: slug.trim(),
        content: preview.content,
        themeDocumentId: activeKind === 'theme' ? undefined : themeId || undefined,
      });
      if (!result.published) {
        setBlocked(result.gate ?? null);
        return;
      }
      const task = result.taskId ? await pollTask(result.taskId) : null;
      if (task && task.status !== 'succeeded') {
        toast.error(task.errorMessage ?? '渲染或发布失败');
        return;
      }
      setPublished(true);
      toast.success('已发布');
      await refresh();
    } catch (error) {
      toast.error(messageOf(error, '保存失败'));
    } finally {
      setBusy(null);
    }
  };

  const copyCss = async () => {
    if (!preview) return;
    try {
      await navigator.clipboard.writeText(preview.css);
      toast.success('CSS 已复制，粘到项目里就能用');
    } catch {
      toast.error('复制失败');
    }
  };

  const categoryRecipes = recipes.filter((recipe) => recipe.category === category);
  const palettes = recipes.filter((recipe) => recipe.category === 'palette');

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader
        title="新建设计资产"
        description="挑一个现成效果，或者用一句话描述你要的样子；调好之后一键发布"
      >
        <Link href="/design-library/review">
          <Button variant="outline" className="gap-2">
            <ClipboardList className="h-4 w-4" />
            审核台
          </Button>
        </Link>
      </PageHeader>

      {/* 第 1 步：配色 */}
      <section className="space-y-3 rounded-md border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">① 用哪套配色</span>
          {themeId ? (
            <span className="text-xs text-muted-foreground">
              颜色、圆角、间距都从这套配色里取，换配色就等于整套换肤
            </span>
          ) : (
            <span className="text-xs text-destructive">
              还没有配色。先点下面任一套安装，再开始做样式。
            </span>
          )}
        </div>
        {themeDocuments.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {themeDocuments.map((theme) => (
              <button
                key={theme.id}
                type="button"
                onClick={() => setThemeId(theme.id)}
                className={cn(
                  'rounded border px-2.5 py-1 text-xs transition',
                  theme.id === themeId
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'hover:bg-muted',
                )}
              >
                {theme.name}
              </button>
            ))}
          </div>
        )}
        <details className="text-xs" open={themeDocuments.length === 0}>
          <summary className="cursor-pointer text-muted-foreground">
            内置配色（点一下就装好）
          </summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {palettes.map((palette) => (
              <button
                key={palette.id}
                type="button"
                disabled={busy !== null}
                onClick={() => void installPalette(palette)}
                className={cn(
                  'rounded-md border p-2 text-left transition hover:border-primary',
                  documents.some((item) => item.slug === palette.id) && 'border-primary/40',
                )}
              >
                <span className="block text-xs font-medium">{palette.name}</span>
                <span className="mt-0.5 block max-w-[180px] text-[11px] text-muted-foreground">
                  {palette.blurb}
                </span>
              </button>
            ))}
          </div>
        </details>
      </section>

      <div className="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
        {/* 第 2 步：描述或挑现成的 */}
        <aside className="space-y-3">
          <section className="space-y-3 rounded-md border p-4">
            <span className="text-sm font-medium">② 你要做什么</span>
            <div className="flex flex-wrap gap-1.5">
              {CATEGORIES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  title={item.hint}
                  onClick={() => {
                    setCategory(item.value);
                    setRecipeId(null);
                  }}
                  className={cn(
                    'rounded border px-2.5 py-1 text-xs transition',
                    item.value === category
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'hover:bg-muted',
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{spec.hint}</p>

            <div className="space-y-2">
              <Textarea
                value={intent}
                onChange={(event) => setIntent(event.target.value)}
                onPaste={(event) => {
                  const file = Array.from(event.clipboardData.files).find((item) =>
                    item.type.startsWith('image/'),
                  );
                  if (file) {
                    event.preventDefault();
                    void attachImage(file);
                  }
                }}
                placeholder="例：做一个毛玻璃卡片，要能浮在图片上不糊"
                className="min-h-20 text-sm"
              />
              {reference ? (
                <div className="flex items-center justify-between gap-2 rounded border bg-muted/40 px-2 py-1.5">
                  <span className="text-xs">
                    已附参考图 <span className="text-muted-foreground">{referenceLabel}</span>
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="移除参考图"
                    onClick={() => {
                      setReference(null);
                      setReferenceLabel('');
                    }}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full gap-2"
                  disabled={busy !== null}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImagePlus className="h-4 w-4" />
                  附一张参考图（也可以直接粘贴）
                </Button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void attachImage(file);
                  event.target.value = '';
                }}
              />
              <Button
                className="w-full gap-2"
                disabled={busy !== null}
                onClick={() => void generate()}
              >
                {busy === 'generate' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {busy === 'generate' ? '正在生成…' : '生成 3 个方案'}
              </Button>
            </div>
          </section>

          <section className="space-y-2 rounded-md border p-4">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium">现成的效果</span>
              <span className="text-xs text-muted-foreground">不用等 AI</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {categoryRecipes.map((recipe) => (
                <button
                  key={recipe.id}
                  type="button"
                  title={recipe.blurb}
                  disabled={busy !== null}
                  onClick={() => void useRecipe(recipe)}
                  className={cn(
                    'rounded border px-2 py-1 text-xs transition hover:border-primary',
                    recipeId === recipe.id && 'border-primary bg-primary/10 text-primary',
                  )}
                >
                  {recipe.name}
                </button>
              ))}
              {categoryRecipes.length === 0 && (
                <span className="text-xs text-muted-foreground">这一类还没有现成效果</span>
              )}
            </div>
          </section>
        </aside>

        {/* 第 3 步：画布与微调 */}
        <main className="min-w-0 space-y-4">
          {!selected ? (
            <div className="flex h-64 items-center justify-center rounded-md border text-sm text-muted-foreground">
              左边挑一个现成效果，或者描述一句你想要的样子
            </div>
          ) : (
            <>
              {proposals.length > 1 && (
                <div className="flex flex-wrap gap-1.5">
                  {proposals.map((proposal, index) => (
                    <button
                      key={`${proposal.label}-${index}`}
                      type="button"
                      onClick={() => chooseProposal(index)}
                      className={cn(
                        'rounded border px-2.5 py-1 text-xs transition',
                        index === selectedIndex
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'hover:bg-muted',
                      )}
                    >
                      {proposal.label}
                    </button>
                  ))}
                </div>
              )}

              <section className="space-y-2 rounded-md border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{selected.label}</span>
                    <Badge variant="secondary" className="text-[11px]">
                      实时预览
                    </Badge>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5"
                    title="重播动画"
                    onClick={() => setStageKey((key) => key + 1)}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    重播
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{selected.rationale}</p>
                {preview && (
                  <iframe
                    key={stageKey}
                    title={`${selected.label} 预览`}
                    // sandbox="" 是隔离手段，不是安全边界：真正把关的是服务端的
                    // 白名单编译与门禁（方案 §8 明确写了这一点）。这里只是让预览
                    // 碰不到运营台自身的 DOM。
                    sandbox=""
                    srcDoc={buildSrcDoc(preview.css, preview.html)}
                    className="h-56 w-full rounded border bg-transparent"
                  />
                )}
                <p className="text-[11px] text-muted-foreground">
                  把鼠标移到预览上就能看到悬停效果。这是即时视图，不是发布依据——发布时会用受控渲染器另出一份固定视口的权威预览。
                </p>
              </section>

              {preview && preview.controls.length > 0 && (
                <section className="space-y-3 rounded-md border p-4">
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm font-medium">③ 微调</span>
                    <span className="text-xs text-muted-foreground">
                      只改取值，不改结构；不花 AI 调用
                    </span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {preview.controls.map((control) => (
                      <div key={control.key} className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">{control.label}</Label>
                        <ControlField
                          control={control}
                          value={edits[control.key]}
                          onChange={(value) => changeControl(control, value)}
                        />
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section className="space-y-3 rounded-md border p-4">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-medium">④ 保存</span>
                  {preview && <GateBadge gate={preview.gate} />}
                </div>

                {blocked && (
                  <div className="space-y-1 rounded border border-destructive/40 bg-destructive/5 p-2.5">
                    <p className="text-xs font-medium text-destructive">没有发布：规范检查没过</p>
                    <p className="text-xs text-destructive">{gateText(blocked)}</p>
                    <p className="text-xs text-muted-foreground">
                      改一下上面受影响的那一项再来一次。库里什么都没写入，可以放心重试。
                    </p>
                  </div>
                )}

                {published && (
                  <div className="flex items-center gap-2 rounded border border-emerald-300 bg-emerald-50 p-2.5">
                    <Check className="h-4 w-4 text-emerald-700" />
                    <p className="text-xs text-emerald-900">
                      已发布。可以「复制 CSS」贴到项目里，或者到审核台看历史版本。
                    </p>
                  </div>
                )}

                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="asset-name" className="text-xs text-muted-foreground">
                      叫什么名字
                    </Label>
                    <Input
                      id="asset-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="毛玻璃卡片"
                    />
                  </div>
                  <div className="flex items-end gap-2">
                    <Button
                      className="flex-1 gap-2"
                      disabled={busy !== null || !preview}
                      onClick={() => void save()}
                    >
                      {busy === 'publish' ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Save className="h-4 w-4" />
                      )}
                      {busy === 'publish' ? '正在发布…' : '保存并发布'}
                    </Button>
                    <Button
                      variant="outline"
                      className="gap-2"
                      disabled={!preview}
                      onClick={() => void copyCss()}
                    >
                      <Copy className="h-4 w-4" />
                      复制 CSS
                    </Button>
                  </div>
                </div>

                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">高级</summary>
                  <div className="mt-2 space-y-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="asset-slug" className="text-xs text-muted-foreground">
                        资产标识（URL 用，小写字母与连字符）
                      </Label>
                      <Input
                        id="asset-slug"
                        value={slug}
                        onChange={(event) => setSlug(event.target.value)}
                        className="font-mono text-xs"
                      />
                    </div>
                    <div>
                      <p className="text-muted-foreground">
                        用到的配色变量：{preview?.tokensUsed.length ?? 0} 个
                        {preview?.skippedTokens.length
                          ? `（${preview.skippedTokens.length} 个无法导出）`
                          : ''}
                      </p>
                      {preview && preview.skipped.length > 0 && (
                        <ul className="mt-1 space-y-0.5 text-muted-foreground">
                          {preview.skipped.map((item) => (
                            <li key={item.key}>
                              {item.key.split('/').slice(-1)[0]}：{item.reason}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </details>
              </section>
            </>
          )}
        </main>
      </div>

      {busy === 'preview' && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          正在编译预览…
        </p>
      )}
    </div>
  );
}

function GateBadge({ gate }: { gate: DesignGate }) {
  if (gate.passed) {
    return (
      <Badge className="gap-1 bg-emerald-600 text-[11px] text-white hover:bg-emerald-600">
        <Check className="h-3 w-3" />
        规范与对比度检查通过
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" className="text-[11px]">
      {gate.errors.length} 项检查未通过
    </Badge>
  );
}

/**
 * 一个控件。
 *
 * 四种形态都对应服务端反推出来的取值类别：颜色给色板、token 档位给按钮组、
 * 枚举给下拉、数值给滑轨。取值一律从 `control.options` 里选，客户端不构造声明。
 */
function ControlField({
  control,
  value,
  onChange,
}: {
  control: DesignControl;
  value: string | number | undefined;
  onChange: (next: string | number) => void;
}) {
  const current = value ?? control.value;

  if (control.type === 'color') {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {control.options?.map((option) => {
          const active = current === option.value;
          return (
            <button
              key={option.value}
              type="button"
              title={option.label}
              onClick={() => onChange(option.value)}
              className={cn(
                'h-7 w-7 rounded-full border-2 transition',
                active ? 'border-primary ring-2 ring-primary/30' : 'border-border',
              )}
              style={{ backgroundColor: option.swatch ?? 'transparent' }}
            />
          );
        })}
      </div>
    );
  }

  if (control.type === 'scale') {
    return (
      <div className="flex flex-wrap gap-1">
        {control.options?.map((option) => {
          const active = current === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              className={cn(
                'rounded border px-2 py-1 text-xs transition',
                active ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted',
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    );
  }

  if (control.type === 'choose') {
    return (
      <select
        value={String(current)}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
      >
        {control.options?.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  const numeric = Number(value ?? control.numeric ?? control.min ?? 0);
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={control.min}
        max={control.max}
        step={control.step}
        value={numeric}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full accent-primary"
      />
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {numeric}
      </span>
    </div>
  );
}
