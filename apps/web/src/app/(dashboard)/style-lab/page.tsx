'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, Copy, ImagePlus, Loader2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { analyzeStyle, getStyleHealth, retryStyleAi } from '@/lib/api/style';
import { createReferenceDraft, listDesignDocuments } from '@/lib/api/design';
import type { DesignDocument } from '@/lib/api/design';
import type { StyleAnalyzeResult, StyleHealth, StyleVariation } from '@/lib/types';

const DENSITY_LABELS: Record<string, string> = {
  compact: '紧凑',
  comfortable: '舒适',
  loose: '宽松',
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024).toFixed(0)}KB`;
}

/** 降级剩余时间：不足 1 分钟按 1 分钟展示，避免出现「0 分钟后重试」 */
function formatRetryAfter(ms: number): string {
  return `${Math.max(1, Math.ceil(ms / 60000))} 分钟`;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(`${label} 已复制`);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('复制失败，请手动选择复制');
    }
  };
  return (
    <Button type="button" variant="outline" size="sm" onClick={copy} className="gap-1.5">
      {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? '已复制' : '复制'}
    </Button>
  );
}

/**
 * 预览用 HTML 净化（纵深防御）
 *
 * iframe 已用 sandbox="" 禁脚本，但 sandbox 不阻止子资源加载（img/link 外部 URL）。
 * 这里仅对"预览"的 HTML 做处理：剥离事件属性、外部资源引用、script/link 标签。
 * 复制给用户使用的 HTML 保持原样，不做处理。
 */
function sanitizePreviewHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:src|href)\s*=\s*("(?!data:)[^"]*"|'(?!data:)[^']*')/gi, '');
}

function ColorSwatch({ hex, label }: { hex: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={`点击复制 ${hex}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(hex);
          setCopied(true);
          toast.success(`${hex} 已复制`);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          toast.error('复制失败');
        }
      }}
      className="group flex min-w-0 flex-col items-start gap-1"
    >
      <span
        className={cn(
          'relative h-10 w-full rounded-md border transition-transform group-hover:scale-105',
        )}
        style={{ backgroundColor: hex }}
      >
        {copied && (
          <Check className="absolute inset-0 m-auto h-4 w-4 text-white drop-shadow" />
        )}
      </span>
      <span className="max-w-full truncate text-xs text-muted-foreground">{label ?? hex}</span>
    </button>
  );
}

export default function StyleLabPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef<string | null>(null);
  // 始终指向"当前"文件，用于丢弃过期分析结果（分析中换图时的竞态）
  const fileRef = useRef<File | null>(null);
  // 递增序号：只允许最新一次请求控制 analyzing 状态
  const analyzeSeqRef = useRef(0);

  const [health, setHealth] = useState<StyleHealth | null>(null);
  const [retryingAi, setRetryingAi] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<StyleAnalyzeResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [themeDocuments, setThemeDocuments] = useState<DesignDocument[]>([]);
  const [referenceThemeId, setReferenceThemeId] = useState('');
  const [creatingReferenceDraft, setCreatingReferenceDraft] = useState(false);

  useEffect(() => {
    getStyleHealth().then(setHealth).catch(() => undefined);
    listDesignDocuments('theme').then(setThemeDocuments).catch(() => undefined);
  }, []);

  // 降级退避窗口是服务端状态，会自己到期。只在降级期间轮询，让倒计时跟着走、
  // 窗口过期后横幅自动消失 —— 否则它会一直挂着一个早已作废的剩余时间。
  useEffect(() => {
    if (!health?.degraded) return;
    const timer = window.setInterval(() => {
      getStyleHealth().then(setHealth).catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [health?.degraded]);

  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    [],
  );

  const setPreview = useCallback((url: string | null) => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = url;
    setPreviewUrl(url);
  }, []);

  const onFile = useCallback(
    (next: File | undefined | null) => {
      if (!next) return;
      if (!next.type.startsWith('image/')) {
        toast.error('请选择图片文件');
        return;
      }
      fileRef.current = next;
      setFile(next);
      setResult(null);
      setSelectedId(null);
      setPreview(URL.createObjectURL(next));
    },
    [setPreview],
  );

  const analyze = async () => {
    const target = fileRef.current;
    if (!target) return;
    const seq = ++analyzeSeqRef.current;
    setAnalyzing(true);
    try {
      const res = await analyzeStyle(target);
      // 分析期间用户换了图：丢弃过期结果，避免结果与预览图不一致
      if (fileRef.current !== target || analyzeSeqRef.current !== seq) return;
      setResult(res);
      setSelectedId(res.variations[0]?.id ?? null);
      toast.success('样式分析完成');
    } catch (error) {
      if (fileRef.current !== target || analyzeSeqRef.current !== seq) return;
      toast.error(error instanceof Error ? error.message : '分析失败，请重试');
    } finally {
      if (analyzeSeqRef.current === seq) {
        setAnalyzing(false);
        // 分析可能触发 AI 降级缓存，刷新 health 让顶部模式提示保持诚实
        getStyleHealth().then(setHealth).catch(() => undefined);
      }
    }
  };

  const selected = useMemo<StyleVariation | null>(
    () => result?.variations.find((v) => v.id === selectedId) ?? result?.variations[0] ?? null,
    [result, selectedId],
  );

  const profile = result?.profile;

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        title="样式实验室"
        description="上传一张截图或图片，提取它的样式（配色 / 字体 / 排版 / 布局），生成多种布局变体，并导出可在其它系统还原样式的提示词。AI 可用时优先 AI 分析，未配置或失败时自动降级为本地分析。"
      />

      {health && health.source === 'local' && health.degraded && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="flex flex-wrap items-center gap-3 p-4 text-sm text-amber-900">
            <div className="min-w-48 flex-1">
              <p>
                AI 已配置（{health.model || '当前模型'}），但最近一次调用失败，已临时降级为
                <strong>本地分析</strong>。约{' '}
                {formatRetryAfter(health.degradation?.retryAfterMs ?? 0)}后恢复尝试 AI ——
                届时下一次分析会重新调用它，也可点右侧按钮立即重试。
              </p>
              <p className="mt-1 text-xs text-amber-800">
                失败原因：{health.degradation?.reason || '未知错误'}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={retryingAi}
              onClick={async () => {
                setRetryingAi(true);
                try {
                  setHealth(await retryStyleAi());
                  toast.success('已清除降级状态，下次分析会重新尝试 AI');
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : '重试失败');
                } finally {
                  setRetryingAi(false);
                }
              }}
            >
              {retryingAi && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              立即重试 AI
            </Button>
          </CardContent>
        </Card>
      )}

      {health && health.source === 'local' && !health.degraded && (
        <Card className="border-sky-200 bg-sky-50">
          <CardContent className="p-4 text-sm text-sky-800">
            当前使用<strong>本地分析</strong>模式（无需 AI、零费用，色板取自图片像素）。配置 AI Key
            后可获得更智能的样式理解与文案，前往{' '}
            <Link href="/settings" className="font-medium underline underline-offset-2">
              系统设置 → AI 配置
            </Link>{' '}
            添加。
          </CardContent>
        </Card>
      )}

      {/* 上传区 */}
      <Card>
        <CardContent className="p-6">
          <div
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
            }}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              onFile(e.dataTransfer.files?.[0]);
            }}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 text-center transition-colors',
              dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50',
            )}
          >
            {previewUrl ? (
              <img
                src={previewUrl}
                alt="待分析图片"
                className="max-h-64 rounded-md border object-contain"
              />
            ) : (
              <>
                <ImagePlus className="h-10 w-10 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  拖拽图片到此处，或点击选择（支持截图 / 图片文件）
                </p>
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                onFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  fileInputRef.current?.click();
                }}
              >
                选择图片
              </Button>
              {file && (
                <Button
                  type="button"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    void analyze();
                  }}
                  disabled={analyzing}
                  className="gap-2"
                >
                  {analyzing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Wand2 className="h-4 w-4" />
                  )}
                  分析样式
                </Button>
              )}
            </div>
            {file && !analyzing && (
              <p className="text-xs text-muted-foreground">
                {file.name}（{formatBytes(file.size)}）
              </p>
            )}
          </div>

          {analyzing && (
            <div className="mt-4 space-y-2">
              <p className="text-xs text-muted-foreground">正在分析样式与生成变体…</p>
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          )}
        </CardContent>
      </Card>

      {result && profile && (
        <>
          {themeDocuments.length > 0 && (
            <Card className="border-sky-200 bg-sky-50">
              <CardContent className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-48 flex-1"><p className="text-sm font-medium text-sky-900">将分析结果作为参考草稿</p><p className="text-xs text-sky-800">仅保存为 inspiration_only 快照，不会直接覆盖主题。</p></div>
                <select value={referenceThemeId} onChange={(event) => setReferenceThemeId(event.target.value)} className="h-9 rounded-md border border-sky-300 bg-white px-2 text-sm"><option value="">选择目标主题</option>{themeDocuments.map((document) => <option key={document.id} value={document.id}>{document.name}</option>)}</select>
                <Button disabled={!referenceThemeId || creatingReferenceDraft} onClick={async () => { if (!referenceThemeId) return; setCreatingReferenceDraft(true); try { await createReferenceDraft(referenceThemeId, profile as unknown as Record<string, unknown>); toast.success('参考草稿已创建，可在设计运营台继续生成候选'); } catch (error) { toast.error(error instanceof Error ? error.message : '创建参考草稿失败'); } finally { setCreatingReferenceDraft(false); } }}>创建参考草稿</Button>
              </CardContent>
            </Card>
          )}
          {/* 样式档案 */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base">样式档案</CardTitle>
                <Badge variant={result.source === 'ai' ? 'default' : 'secondary'}>
                  {result.source === 'ai'
                    ? result.variationsSource === 'ai'
                      ? 'AI 分析'
                      : 'AI 档案 · 本地变体'
                    : '本地分析'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* 配色 */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-medium">配色</h3>
                  <span className="text-xs text-muted-foreground">{profile.colorPalette.mood}</span>
                </div>
                <div className="grid grid-cols-4 gap-3 sm:grid-cols-6 lg:grid-cols-8">
                  {result.detectedColors.map((hex) => (
                    <ColorSwatch key={hex} hex={hex} />
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {[profile.colorPalette.primary, profile.colorPalette.background, profile.colorPalette.accent].map(
                    (c, i) =>
                      c ? (
                        <Badge key={i} variant="secondary" className="gap-1.5 font-normal">
                          <span
                            className="h-3 w-3 rounded-full border"
                            style={{ backgroundColor: c.hex }}
                          />
                          {c.role} · {c.hex}
                          {c.approxName ? ` · ${c.approxName}` : ''}
                        </Badge>
                      ) : null,
                  )}
                </div>
              </div>

              <Separator />

              {/* 字体 */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-sm font-medium">字体</h3>
                  <p className="text-sm text-muted-foreground">
                    {profile.typography.familyTrait}
                    {profile.typography.suggestedFont && (
                      <span className="ml-1 text-xs">（建议：{profile.typography.suggestedFont}）</span>
                    )}
                  </p>
                  <ul className="mt-2 space-y-1">
                    {profile.typography.hierarchy.map((h, i) => (
                      <li key={i} className="text-xs text-muted-foreground">
                        {h.role}：{h.sizePx}px / {h.weight}
                        {h.letterSpacing ? ` · ${h.letterSpacing}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* 布局与间距 */}
                <div>
                  <h3 className="mb-2 text-sm font-medium">布局与间距</h3>
                  <p className="text-sm text-muted-foreground">{profile.layout.composition}</p>
                  {profile.layout.regions.length > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      区域：{profile.layout.regions.join('、')}
                      {profile.layout.grid ? ` · ${profile.layout.grid.columns} 栏栅格` : ''}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    间距单位 {profile.spacing.unit}px · 密度{' '}
                    {DENSITY_LABELS[profile.spacing.density] ?? profile.spacing.density}
                  </p>
                </div>
              </div>

              <Separator />

              {/* 质感与关键词 */}
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="mr-1 text-sm font-medium">质感</h3>
                <Badge variant="outline">圆角 {profile.textureMood.radius}</Badge>
                <Badge variant="outline">阴影 {profile.textureMood.shadow}</Badge>
                {profile.textureMood.gradient && (
                  <Badge variant="outline">渐变 {profile.textureMood.gradient}</Badge>
                )}
                {profile.textureMood.keywords.map((k) => (
                  <Badge key={k} variant="secondary">
                    {k}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* 布局变体 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">布局变体</CardTitle>
              <p className="text-sm text-muted-foreground">
                选择你想要的构图，导出区会随之切换该变体的生图提示词。
              </p>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                {result.variations.map((v) => {
                  const active = selected?.id === v.id;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => setSelectedId(v.id)}
                      className={cn(
                        'overflow-hidden rounded-lg border text-left transition-colors',
                        active
                          ? 'border-primary ring-2 ring-primary/30'
                          : 'border-border hover:border-primary/50',
                      )}
                    >
                      <iframe
                        title={v.name}
                        sandbox=""
                        srcDoc={sanitizePreviewHtml(v.html)}
                        className="h-56 w-full bg-white"
                      />
                      <div className="flex items-center justify-between gap-2 border-t bg-card px-3 py-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{v.name}</p>
                          {v.description && (
                            <p className="truncate text-xs text-muted-foreground">{v.description}</p>
                          )}
                        </div>
                        {active && <Check className="h-4 w-4 shrink-0 text-primary" />}
                      </div>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* 导出 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                导出{selected ? ` · ${selected.name}` : ''}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {selected && (
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-medium">生图提示词</h3>
                  </div>
                  <p className="mb-3 text-xs text-amber-600">{selected.imagePrompt.referenceNote}</p>
                  <Tabs defaultValue="midjourney">
                    <TabsList>
                      <TabsTrigger value="midjourney">Midjourney</TabsTrigger>
                      <TabsTrigger value="stableDiffusion">Stable Diffusion</TabsTrigger>
                      <TabsTrigger value="flux">Flux</TabsTrigger>
                    </TabsList>
                    <TabsContent value="midjourney">
                      <PromptBlock text={selected.imagePrompt.midjourney} label="Midjourney 提示词" />
                    </TabsContent>
                    <TabsContent value="stableDiffusion">
                      <PromptBlock text={selected.imagePrompt.stableDiffusion} label="Stable Diffusion 提示词" />
                    </TabsContent>
                    <TabsContent value="flux">
                      <PromptBlock text={selected.imagePrompt.flux} label="Flux 提示词" />
                    </TabsContent>
                  </Tabs>
                </div>
              )}

              <Separator />

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-medium">网页样式（CSS Design Tokens）</h3>
                  <CopyButton text={result.exports.cssTokens} label="CSS Tokens" />
                </div>
                <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
                  {result.exports.cssTokens}
                </pre>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-medium">风格文案（Style Guide）</h3>
                  <CopyButton text={result.exports.styleGuide} label="风格文案" />
                </div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs leading-relaxed">
                  {result.exports.styleGuide}
                </pre>
              </div>

              {selected && (
                <>
                  <Separator />
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="text-sm font-medium">网页布局（HTML，当前变体）</h3>
                      <CopyButton text={selected.html} label="HTML" />
                    </div>
                    <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
                      {selected.html}
                    </pre>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function PromptBlock({ text, label }: { text: string; label: string }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-end">
        <CopyButton text={text} label={label} />
      </div>
      <Textarea readOnly value={text} className="min-h-28 text-xs" />
    </div>
  );
}
