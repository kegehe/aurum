'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Camera,
  Check,
  Copy,
  Loader2,
  Monitor,
  MousePointerClick,
  RefreshCw,
  Smartphone,
  Sparkles,
  Tablet,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  getPreviewSample,
  previewSnapshotUrl,
  type PreviewSampleDto,
} from '@/lib/api/studio';
import { AssetStudio } from './asset-studio';

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

function formatBytes(bytes: number): string {
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function StudioLoading() {
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-[520px] w-full" />
    </div>
  );
}

function StudioSwitch() {
  const params = useSearchParams();
  const assetId = params.get('asset');
  if (assetId) return <AssetStudio key={assetId} assetId={assetId} />;
  return <SampleStudio />;
}

export default function StudioPage() {
  return (
    <Suspense fallback={<StudioLoading />}>
      <StudioSwitch />
    </Suspense>
  );
}

function SampleStudio() {
  const [sample, setSample] = useState<PreviewSampleDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [selectedPart, setSelectedPart] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSnapshot(null);
    try {
      setSample(await getPreviewSample());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '预览编译失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { source?: string; type?: string; part?: string };
      if (data?.source !== 'aurum-preview') return;
      if (data.type === 'select' && data.part) setSelectedPart(data.part);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const source = useMemo(
    () => sample?.files.find((file) => file.path === 'files/glass-button.tsx')?.content ?? '',
    [sample],
  );

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} 已复制`);
    } catch {
      toast.error('复制失败，请手动选择');
    }
  };

  const renderSnapshot = () => {
    if (!sample) return;
    setSnapshot(`${previewSnapshotUrl(viewport, 'default')}&t=${Date.now()}`);
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="工作台 · 按钮切片"
        description="实时编译资产，在隔离沙箱中预览按钮效果，并按视口生成快照。"
      >
        <Link href="/design-library">
          <Button className="gap-2">
            <Sparkles className="h-4 w-4" />
            AI 新建样式 / 动效
          </Button>
        </Link>
        <Button variant="outline" className="gap-2" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          重新编译
        </Button>
      </PageHeader>

      {error && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <CardTitle className="text-base">实时预览</CardTitle>
                <Badge variant="secondary" className="text-[11px]">
                  iframe sandbox
                </Badge>
              </div>
              <div className="flex gap-1 rounded-md border p-1">
                {(['desktop', 'tablet', 'mobile'] as const).map((item) => {
                  const Icon = item === 'desktop' ? Monitor : item === 'tablet' ? Tablet : Smartphone;
                  return (
                    <Button
                      key={item}
                      type="button"
                      variant={viewport === item ? 'secondary' : 'ghost'}
                      size="sm"
                      className="gap-1.5 px-2"
                      onClick={() => {
                        setViewport(item);
                        setSnapshot(null);
                      }}
                      title={VIEWPORT_LABEL[item]}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {VIEWPORT_LABEL[item]}
                    </Button>
                  );
                })}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {loading && !sample ? (
                <Skeleton className="h-[420px] w-full" />
              ) : sample ? (
                <div className="rounded-lg border bg-slate-100 p-4">
                  <div
                    className="mx-auto overflow-hidden rounded-md border bg-white shadow-sm transition-[max-width]"
                    style={{ maxWidth: VIEWPORT_WIDTH[viewport] }}
                  >
                    <iframe
                      key={`${reloadKey}-${viewport}`}
                      ref={iframeRef}
                      title="玻璃按钮预览"
                      sandbox="allow-scripts"
                      srcDoc={sample.html}
                      className="h-[420px] w-full bg-transparent"
                    />
                  </div>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <MousePointerClick className="h-3.5 w-3.5" />
                <span>点按钮看 React 状态；点任意 data-part 看选中回传。</span>
                <Badge variant="outline" className="gap-1">
                  选中：{selectedPart ?? '无'}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5"
                  onClick={() => {
                    setSelectedPart(null);
                    setReloadKey((key) => key + 1);
                  }}
                >
                  <RefreshCw className="h-3 w-3" />
                  重播
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-base">组件源码</CardTitle>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={!source}
                onClick={() => void copy(source, 'React 代码')}
              >
                <Copy className="h-3.5 w-3.5" />
                复制 React
              </Button>
            </CardHeader>
            <CardContent>
              <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
                {source || '暂无源码'}
              </pre>
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">资产摘要</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {sample ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">名称</span>
                    <span className="font-medium">{sample.manifest.name}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">类型</span>
                    <Badge variant="secondary">
                      {sample.manifest.kind} · {sample.manifest.subtype}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">状态</span>
                    <span className="text-xs">{sample.manifest.states?.join(' / ')}</span>
                  </div>
                  <Separator />
                  <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                    <span>CSS {formatBytes(sample.cssBytes)}</span>
                    <span>JS {formatBytes(sample.jsBytes)}</span>
                    <span>{sample.classes.length} 个类名</span>
                    <span>{sample.manifest.files.length} 个交付文件</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {sample.classes.slice(0, 6).map((item) => (
                      <Badge key={item} variant="outline" className="font-mono text-[10px]">
                        {item}
                      </Badge>
                    ))}
                  </div>
                </>
              ) : (
                <Skeleton className="h-24 w-full" />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">已支持能力</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-muted-foreground">
              {[
                'esbuild 浏览器 bundle',
                'Tailwind 4 类名编译',
                'React hooks / 点击交互',
                'iframe sandbox + CSP',
                'Playwright 快照',
              ].map((item) => (
                <div key={item} className="flex items-center gap-2">
                  <Check className="h-3.5 w-3.5 text-emerald-600" />
                  <span>{item}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-base">Playwright 快照</CardTitle>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={!sample}
                onClick={renderSnapshot}
              >
                <Camera className="h-3.5 w-3.5" />
                生成
              </Button>
            </CardHeader>
            <CardContent>
              {snapshot ? (
                <img
                  src={snapshot}
                  alt={`${VIEWPORT_LABEL[viewport]}快照`}
                  className="w-full rounded-md border"
                />
              ) : (
                <div className={cn('flex h-28 items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground')}>
                  点「生成」用 Chromium 截一张固定视口快照
                </div>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
