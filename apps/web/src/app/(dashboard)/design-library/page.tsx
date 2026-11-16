'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowRight,
  ClipboardList,
  Image as ImageIcon,
  ImagePlus,
  Loader2,
  Play,
  RefreshCw,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { analyzeStyle } from '@/lib/api/style';
import {
  getResource,
  getResourcePreviewUrl,
  getResourceThumbnailUrl,
} from '@/lib/api/resources';
import { RESOURCE_TYPE_LABELS } from '@/lib/constants';
import { designMediaIssue } from '@/lib/resource';
import { ResourceType } from '@aurum/shared-types';
import {
  composeDesignAuto,
  composeDesignPreview,
  composeDesignPublish,
  getDesignTask,
  type ComposePreviewResult,
  type DesignTask,
} from '@/lib/api/design';

type Kind = 'theme' | 'component' | 'animation';

interface Proposal {
  kind: Kind;
  name: string;
  label: string;
  rationale: string;
  content: Record<string, unknown>;
}

interface DesignMaterial {
  id: string;
  title: string;
  resourceType: ResourceType;
  previewUrl: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: string | null;
  issue: string | null;
}

const POLL_MS = 1_500;
/**
 * 约三分钟。实测这套免费上游的尾延迟能到 2 分钟以上，2 分钟的窗口会在任务
 * 即将出结果时先报「等待超时」，把失败原因盖掉。超时不是失败：任务仍在后台跑。
 */
const POLL_LIMIT = 120;

const KIND_LABEL: Record<Kind, string> = {
  theme: '配色',
  component: '组件',
  animation: '动效',
};

/** 预览舞台：给一层柔和彩底，玻璃/发光这类效果放在纯白上会显得没生效。 */
const STAGE_CSS = `
html,body{margin:0;padding:0;background:transparent}
body{min-height:200px;display:flex;align-items:center;justify-content:center;padding:28px;
  font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#0f172a;
  background-image:linear-gradient(135deg,#dde7f7 0%,#f7e6f0 48%,#dff1ea 100%)}
`;

const EXAMPLES = [
  '磨砂玻璃按钮，悬停时光扫过并微微上浮',
  '卡片进场：从下方 12px 浮起并淡入',
  '一套偏冷的深色配色，适合后台看板',
];

function buildSrcDoc(css: string, html: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${STAGE_CSS}${css}</style></head><body>${html}</body></html>`;
}

function messageOf(error: unknown, fallback = '操作失败'): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function slugFor(kind: Kind): string {
  const prefix = kind === 'theme' ? 'theme' : kind === 'animation' ? 'motion' : 'style';
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

async function pollTask(taskId: string): Promise<DesignTask> {
  for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
    const task = await getDesignTask(taskId);
    if (['succeeded', 'failed', 'canceled'].includes(task.status)) return task;
    await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
  }
  throw new Error('等待超时。任务仍在后台跑，可以稍等一下再点「换一批」。');
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

function isKind(value: unknown): value is Kind {
  return value === 'theme' || value === 'component' || value === 'animation';
}

/**
 * 一句话生成。
 *
 * 刻意只有输入框 + 一个按钮：类别（配色 / 组件 / 动效）、配色、命名都由服务端
 * 与模型决定，用户不需要先学我们的分类学。需要精细控制时再走「高级模式」。
 */
function DesignCreatePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const resourceParam = searchParams.get('resource');
  const [material, setMaterial] = useState<DesignMaterial | null>(null);
  const [materialLoading, setMaterialLoading] = useState(Boolean(resourceParam));
  const [materialPreviewError, setMaterialPreviewError] = useState(false);
  const [intent, setIntent] = useState('');
  const [busy, setBusy] = useState<null | 'generate' | 'publish'>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [preview, setPreview] = useState<ComposePreviewResult | null>(null);
  const [themeId, setThemeId] = useState<string | undefined>(undefined);
  const [gateErrors, setGateErrors] = useState<string[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [published, setPublished] = useState<{ name: string } | null>(null);
  /** 资产已创建但权威预览渲染失败时的提示：这种情况不能当失败让人重试，
   *  否则重试会再建一个同内容的新资产。 */
  const [publishWarning, setPublishWarning] = useState<string | null>(null);
  /** 生成时的意图快照：发布摘要用它，避免用户改了输入框后摘要对不上产物 */
  const [generatedIntent, setGeneratedIntent] = useState('');
  /** 参考图档案：只表达视觉意图（配色、质感），生成时随提示词一起下发 */
  const [reference, setReference] = useState<Record<string, unknown> | null>(null);
  const [referenceLabel, setReferenceLabel] = useState('');
  const [referencePreview, setReferencePreview] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewSeq = useRef(0);
  /** 素材变化时递增；旧生成/发布任务的结果不再写回新页面。 */
  const generationSeq = useRef(0);
  const mounted = useRef(true);

  // 生成要轮询两分钟，中途离开页面时别再往已卸载的组件写状态。
  // StrictMode 会 mount → cleanup → mount，这里必须在副作用里重新置 true。
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // 资源库「用于设计」带过来的素材。只在这里读取展示信息；生成时只把 ID 发给服务端。
  useEffect(() => {
    if (!resourceParam) {
      generationSeq.current += 1;
      previewSeq.current += 1;
      setBusy(null);
      setMaterial(null);
      setMaterialLoading(false);
      setMaterialPreviewError(false);
      return;
    }

    let cancelled = false;
    generationSeq.current += 1;
    previewSeq.current += 1;
    setBusy(null);
    setMaterial(null);
    setMaterialPreviewError(false);
    setMaterialLoading(true);
    setProposals([]);
    setPreview(null);
    setPreviewError(null);
    setGateErrors([]);
    setPublished(null);
    setPublishWarning(null);

    void getResource(resourceParam)
      .then((resource) => {
        if (cancelled) return;
        const hasThumbnail = resource.files.some((file) => file.fileRole === 'thumbnail');
        const hasOriginal = resource.files.some((file) => file.fileRole === 'original');
        const remotePreview =
          resource.locators?.find(
            (locator) =>
              locator.locatorType === 'preview' &&
              (!locator.contentType || locator.contentType.startsWith('image/')),
          )?.url ?? null;
        // 没有本地缩略图时，本地 /preview 需要有原文件；远程资源直接用它自己的预览图。
        const previewUrl = hasThumbnail
          ? getResourceThumbnailUrl(resource.id)
          : resource.resourceType === ResourceType.image && hasOriginal
            ? getResourcePreviewUrl(resource.id, 1024)
            : remotePreview;
        const issue = designMediaIssue(resource);
        setMaterialPreviewError(false);
        setMaterial({
          id: resource.id,
          title: resource.title || resource.originalFilename,
          resourceType: resource.resourceType,
          previewUrl,
          width: resource.width,
          height: resource.height,
          durationSeconds: resource.durationSeconds,
          issue,
        });
        setIntent((current) =>
          current.trim()
            ? current
            : resource.resourceType === ResourceType.video
              ? '用这个视频封面做一个有设计感的卡片'
              : '用这张图片做一个有设计感的卡片',
        );
        if (issue) toast.warning(issue);
      })
      .catch((error) => {
        if (cancelled) return;
        setMaterial(null);
        toast.error(error instanceof Error ? error.message : '素材加载失败');
      })
      .finally(() => {
        if (!cancelled) setMaterialLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [resourceParam]);

  const selected = proposals[selectedIndex];
  // 媒体组件默认 560px 宽、按素材比例出高度，h-72 会把底部文案裁掉。
  const previewStageHeight = material ? 'h-[520px]' : 'h-72';

  const runPreview = async (proposal: Proposal, theme: string | undefined) => {
    const seq = previewSeq.current + 1;
    previewSeq.current = seq;
    try {
      const result = await composeDesignPreview({
        kind: proposal.kind,
        content: proposal.content,
        themeDocumentId: proposal.kind === 'theme' ? undefined : theme,
      });
      if (seq !== previewSeq.current || !mounted.current) return;
      setPreview(result);
      setPreviewError(null);
      setGateErrors(result.gate.errors);
    } catch (error) {
      if (seq !== previewSeq.current) return;
      setPreview(null);
      setPreviewError(messageOf(error, '预览失败'));
    }
  };

  const attachImage = async (file: File) => {
    setAnalyzing(true);
    try {
      // 分析失败会降级为本地确定性分析，所以这里通常不会卡住
      const result = await analyzeStyle(file);
      setReference(result.profile as unknown as Record<string, unknown>);
      setReferenceLabel(
        `${result.image.width}×${result.image.height} · ${result.source === 'ai' ? 'AI 分析' : '本地分析'}`,
      );
      setReferencePreview((current) => {
        if (current) URL.revokeObjectURL(current);
        return URL.createObjectURL(file);
      });
      toast.success('参考图已附上，生成时会参考它的配色与质感');
    } catch (error) {
      toast.error(messageOf(error, '参考图分析失败'));
    } finally {
      setAnalyzing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const clearReference = () => {
    setReference(null);
    setReferenceLabel('');
    setReferencePreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
  };

  const removeMaterial = () => {
    generationSeq.current += 1;
    previewSeq.current += 1;
    setBusy(null);
    setMaterial(null);
    setMaterialPreviewError(false);
    setProposals([]);
    setPreview(null);
    setPreviewError(null);
    setGateErrors([]);
    setPublished(null);
    setPublishWarning(null);
    if (resourceParam) router.replace('/design-library');
  };

  const generate = async () => {
    if (busy !== null || analyzing || materialLoading) return;
    if (material?.issue) {
      toast.error(material.issue);
      return;
    }
    if (intent.trim().length < 2) {
      toast.error('说一句你想要的样子');
      return;
    }
    const generation = ++generationSeq.current;
    setBusy('generate');
    setProposals([]);
    setPreview(null);
    setPreviewError(null);
    setGateErrors([]);
    setPublished(null);
    setPublishWarning(null);
    try {
      const { taskId, themeDocumentId } = await composeDesignAuto({
        intent: intent.trim(),
        count: 3,
        reference: reference ?? undefined,
        mediaResourceId: material?.id,
      });
      if (generation !== generationSeq.current) return;
      setThemeId(themeDocumentId);
      const task = await pollTask(taskId);
      if (generation !== generationSeq.current || !mounted.current) return;
      if (task.status !== 'succeeded') {
        toast.error(task.errorMessage ?? '生成失败');
        return;
      }
      const payload = readTaskPayload(task);
      const list = (payload.candidates ?? []).filter((item) => isKind(item.kind));
      if (list.length === 0) {
        toast.error('没有生成出可用方案，换个说法再试一次');
        return;
      }
      setProposals(list);
      setSelectedIndex(0);
      setGeneratedIntent(intent.trim());
      if (payload.failures?.length) {
        toast.warning(`${payload.failures.length} 个方案没过校验，已跳过`);
      }
      await runPreview(list[0], themeDocumentId);
    } catch (error) {
      if (generation !== generationSeq.current || !mounted.current) return;
      toast.error(messageOf(error, '生成失败'));
    } finally {
      if (generation === generationSeq.current) setBusy(null);
    }
  };

  const choose = async (index: number) => {
    const proposal = proposals[index];
    if (!proposal) return;
    setSelectedIndex(index);
    setPublished(null);
    setPublishWarning(null);
    // 旧预览属于上一个方案：不清掉的话「发布」会把旧内容按新类别发出去
    setPreview(null);
    setPreviewError(null);
    setGateErrors([]);
    await runPreview(proposal, themeId);
  };

  const publish = async () => {
    if (busy !== null || !selected || !preview) return;
    const generation = generationSeq.current;
    setBusy('publish');
    try {
      const result = await composeDesignPublish({
        kind: selected.kind,
        name: (selected.name || selected.label).slice(0, 120),
        slug: slugFor(selected.kind),
        content: preview.content,
        themeDocumentId: selected.kind === 'theme' ? undefined : themeId,
        summary: `一句话生成：${(generatedIntent || intent).trim().slice(0, 120)}`,
      });
      if (generation !== generationSeq.current || !mounted.current) return;
      if (!result.published) {
        setGateErrors(result.gate?.errors ?? ['发布门禁未通过']);
        toast.error('没过发布门禁，原因见下方');
        return;
      }
      // 走到这里 `createDocument` 已经把 v1 发布出去了：之后的轮询失败
      // （超时、断网）都不能当成"没发出去"，否则用户重试会多出一个同内容资产。
      const name = selected.name || selected.label;
      setPublished({ name });
      let task: DesignTask | null = null;
      try {
        task = result.taskId ? await pollTask(result.taskId) : null;
      } catch (error) {
        if (generation !== generationSeq.current || !mounted.current) return;
        setPublishWarning(
          `资产已创建，但没等到渲染结果：${messageOf(error, '渲染超时')}。封面会在渲染成功后出现在资产库。`,
        );
        toast.warning('已创建，但渲染结果未知');
        return;
      }
      if (generation !== generationSeq.current || !mounted.current) return;
      if (task && task.status !== 'succeeded') {
        setPublishWarning(
          `资产已创建，但权威预览渲染失败：${task.errorMessage ?? '未知原因'}。需要重新发布才能再生成封面。`,
        );
        toast.warning('已创建，但预览渲染失败');
        return;
      }
      toast.success('已发布');
    } catch (error) {
      if (generation !== generationSeq.current || !mounted.current) return;
      toast.error(messageOf(error, '发布失败'));
    } finally {
      if (generation === generationSeq.current) setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="一句话生成"
        description="说一句话，AI 自己判断这是配色、组件还是动效；从资源库带素材进来时会生成使用该素材的组件。"
      >
        <Link href="/design-library/review">
          <Button variant="outline" className="gap-2">
            <ClipboardList className="h-4 w-4" />
            审核台
          </Button>
        </Link>
        <Link href="/design-library/advanced">
          <Button variant="ghost" className="gap-2">
            <Settings2 className="h-4 w-4" />
            高级模式
          </Button>
        </Link>
      </PageHeader>

      <Card>
        <CardContent className="space-y-3 p-4">
          <Textarea
            value={intent}
            onChange={(event) => setIntent(event.target.value)}
            placeholder="比如：磨砂玻璃按钮，悬停时光扫过并微微上浮"
            rows={3}
            maxLength={2_000}
            disabled={busy !== null}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void generate();
            }}
          />

          {materialLoading ? (
            <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在读取素材…
            </div>
          ) : material ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2">
                <div className="relative h-12 w-16 shrink-0 overflow-hidden rounded bg-muted">
                  {material.previewUrl && !materialPreviewError ? (
                    <img
                      src={material.previewUrl}
                      alt=""
                      className="h-full w-full object-cover"
                      referrerPolicy="no-referrer"
                      onError={() => setMaterialPreviewError(true)}
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <ImageIcon className="h-5 w-5 text-muted-foreground" />
                    </div>
                  )}
                  {material.resourceType === ResourceType.video && (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/25">
                      <Play className="h-4 w-4 fill-white text-white" />
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">素材：{material.title}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {RESOURCE_TYPE_LABELS[material.resourceType]}
                    {material.width && material.height
                      ? ` · ${material.width}×${material.height}`
                      : ''}
                    {material.resourceType === ResourceType.video ? ' · 使用封面帧' : ''}
                  </p>
                </div>
                <Button variant="ghost" size="sm" asChild>
                  <Link href={`/resources/${material.id}`}>查看资源</Link>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={removeMaterial}
                  disabled={busy !== null}
                  title="移除素材"
                  aria-label="移除素材"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              {material.issue && (
                <p className="rounded-md bg-destructive/10 p-2 text-[11px] text-destructive">
                  {material.issue} 移除素材后可继续生成。
                </p>
              )}
              <p className="text-[11px] text-muted-foreground">
                素材会作为生成组件的媒体区，由服务端渲染为图片/视频封面。
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void attachImage(file);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={analyzing || busy !== null}
              onClick={() => fileInputRef.current?.click()}
            >
              {analyzing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ImagePlus className="h-3.5 w-3.5" />
              )}
              {reference ? '换一张参考图' : '附参考图（可选）'}
            </Button>
            {reference && (
              <span className="flex items-center gap-2 rounded-md border px-2 py-1 text-[11px] text-muted-foreground">
                {referencePreview && (
                  <img
                    src={referencePreview}
                    alt="参考图"
                    className="h-7 w-7 rounded object-cover"
                  />
                )}
                {referenceLabel}
                <button
                  type="button"
                  onClick={clearReference}
                  className="text-muted-foreground transition hover:text-foreground"
                  aria-label="移除参考图"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => setIntent(example)}
                  className="rounded-full border px-2.5 py-1 text-[11px] text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
                >
                  {example}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-muted-foreground">Ctrl / ⌘ + Enter</span>
              <Button
                className="gap-2"
                onClick={() => void generate()}
                disabled={
                  busy !== null || analyzing || materialLoading || Boolean(material?.issue)
                }
              >
                {busy === 'generate' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {busy === 'generate' ? '生成中…' : '生成'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {proposals.length > 0 && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                {proposals.map((proposal, index) => (
                  <button
                    key={`${proposal.kind}-${proposal.label}-${index}`}
                    type="button"
                    // 发布/生成进行中不允许切方案：否则「已发布」会显示在另一个方案旁边
                    disabled={busy !== null}
                    onClick={() => void choose(index)}
                    className={cn(
                      'rounded-md border px-2.5 py-1 text-xs transition',
                      index === selectedIndex
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'hover:bg-muted',
                    )}
                  >
                    {proposal.name || proposal.label}
                  </button>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto gap-1.5"
                  onClick={() => void generate()}
                  disabled={busy !== null || materialLoading || Boolean(material?.issue)}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  换一批
                </Button>
              </div>

              {selected && (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary" className="text-[11px]">
                    {KIND_LABEL[selected.kind]}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{selected.rationale}</span>
                </div>
              )}

              {preview ? (
                <iframe
                  title="预览"
                  // sandbox="" 是隔离手段，不是安全边界：真正把关的是服务端的
                  // 白名单编译与发布门禁。这里只让它碰不到运营台自身的 DOM。
                  sandbox=""
                  srcDoc={buildSrcDoc(preview.css, preview.html)}
                  className={cn('w-full rounded border bg-transparent', previewStageHeight)}
                />
              ) : previewError ? (
                <div
                  className={cn(
                    'flex items-center justify-center rounded border border-dashed px-6 text-center text-xs text-destructive',
                    previewStageHeight,
                  )}
                >
                  {previewError}
                </div>
              ) : (
                <div
                  className={cn(
                    'flex items-center justify-center rounded border border-dashed text-xs text-muted-foreground',
                    previewStageHeight,
                  )}
                >
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  正在编译预览…
                </div>
              )}

              {gateErrors.length > 0 && (
                <p className="rounded-md bg-destructive/10 p-2 text-[11px] text-destructive">
                  {gateErrors.join('；')}
                </p>
              )}
            </CardContent>
          </Card>

          <aside className="space-y-3">
            <Card>
              <CardContent className="space-y-2 p-4">
                <p className="text-sm font-medium">满意就直接发布</p>
                <p className="text-[11px] text-muted-foreground">
                  发布前会跑对比度与依赖门禁；没过会告诉你具体哪一项。
                </p>
                <Button
                  className="w-full gap-2"
                  onClick={() => void publish()}
                  disabled={busy !== null || !preview || published !== null}
                >
                  {busy === 'publish' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowRight className="h-4 w-4" />
                  )}
                  {published ? '已发布' : '发布'}
                </Button>
                {publishWarning && (
                  <p className="rounded-md bg-amber-500/10 p-2 text-[11px] text-amber-700">
                    {publishWarning}
                  </p>
                )}
                {published && (
                  <Link href="/library" className="block">
                    <Button variant="outline" className="w-full text-xs">
                      去资产库看看「{published.name}」
                    </Button>
                  </Link>
                )}
              </CardContent>
            </Card>
            <p className="px-1 text-[11px] text-muted-foreground">
              想要先选配色、微调圆角和间距？用「高级模式」。
            </p>
          </aside>
        </div>
      )}

      {proposals.length === 0 && (
        <p className="text-center text-xs text-muted-foreground">
          生成的是提案，不会直接进资产库；发布后才会出现在「资产库」里。
        </p>
      )}
    </div>
  );
}

export default function DesignCreatePage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-5xl space-y-4">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-40 w-full" />
        </div>
      }
    >
      <DesignCreatePageInner />
    </Suspense>
  );
}
