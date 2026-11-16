'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Box,
  Camera,
  Check,
  ChevronDown,
  Copy,
  GitCompare,
  Heart,
  History,
  LayoutTemplate,
  Loader2,
  Monitor,
  Palette,
  Smartphone,
  Sparkles,
  Tablet,
  Trash2,
  Wand2,
} from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { PageHeader } from '@/components/shared/page-header';
import { SearchInput } from '@/components/shared/search-input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  archiveAsset,
  assetCoverUrl,
  captureAssetSnapshot,
  getAsset,
  getAssetExport,
  getAssetPreview,
  listAssets,
  listAssetVersions,
  diffAssetVersions,
  seedSampleAsset,
  toggleAssetFavorite,
  type AssetDetail,
  type AssetExport,
  type AssetPreview,
  type AssetSummary,
  type AssetVersionDiff,
  type AssetVersionSummary,
} from '@/lib/api/assets';

const PAGE_SIZE = 24;

type KindTab = 'all' | 'component' | 'animation' | 'layout' | 'theme';
type Viewport = 'desktop' | 'tablet' | 'mobile';
type CodeFormat = 'react' | 'css' | 'registry' | 'ai' | 'json';

const KIND_TABS: Array<{ value: KindTab; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'theme', label: '样式' },
  { value: 'component', label: '组件' },
  { value: 'animation', label: '动效' },
  { value: 'layout', label: '布局' },
];

const KIND_META: Record<
  string,
  { label: string; icon: typeof Box; background: string }
> = {
  component: {
    label: '组件',
    icon: Box,
    background: 'from-sky-100 via-cyan-50 to-white',
  },
  animation: {
    label: '动效',
    icon: Sparkles,
    background: 'from-amber-100 via-orange-50 to-white',
  },
  layout: {
    label: '布局',
    icon: LayoutTemplate,
    background: 'from-violet-100 via-indigo-50 to-white',
  },
  theme: {
    label: '样式',
    icon: Palette,
    background: 'from-emerald-100 via-teal-50 to-white',
  },
  foundation: {
    label: '基础规范',
    icon: Palette,
    background: 'from-emerald-100 via-teal-50 to-white',
  },
  style_pack: {
    label: '样式包',
    icon: Palette,
    background: 'from-emerald-100 via-teal-50 to-white',
  },
};

const VIEWPORT_WIDTH: Record<Viewport, string> = {
  desktop: '100%',
  tablet: '768px',
  mobile: '390px',
};

const CODE_TABS: Array<{ value: CodeFormat; label: string }> = [
  { value: 'react', label: 'React' },
  { value: 'css', label: 'CSS' },
  { value: 'registry', label: 'Registry' },
  { value: 'ai', label: 'AI 用法' },
  { value: 'json', label: 'JSON' },
];

function metaOf(kind: string) {
  return KIND_META[kind] ?? KIND_META.component;
}

function showsLivePreview(asset: { format: string; kind: string }) {
  return (
    asset.format === 'package' ||
    (asset.format === 'token' && (asset.kind === 'component' || asset.kind === 'animation'))
  );
}

function previewTitle(asset: { format: string; kind: string }, hasPreview: boolean) {
  if (asset.format === 'package' || hasPreview) return '实时预览';
  if (
    asset.format === 'token' &&
    (asset.kind === 'theme' || asset.kind === 'foundation' || asset.kind === 'style_pack')
  ) {
    return '色板预览';
  }
  if (asset.format === 'token') return '颜色';
  return '旧格式资产';
}

function paletteCaption(kind: string, count: number) {
  if (kind === 'theme' || kind === 'foundation' || kind === 'style_pack') {
    return `主题色板 · 共 ${count} 个颜色`;
  }
  return `用到的颜色 · 共 ${count} 个`;
}

function paletteEmptyCopy(kind: string) {
  if (kind === 'theme' || kind === 'foundation') return '这份主题没有可显示的颜色值';
  if (kind === 'style_pack') return '样式包本身没有色值，颜色在它依赖的主题里';
  if (kind === 'animation') return '这份动效没有写出可显示的颜色';
  if (kind === 'layout') return '这份布局没有写出可显示的颜色';
  return '这份资产没有写出可显示的颜色';
}

function isPaletteKind(kind: string) {
  return kind === 'theme' || kind === 'foundation' || kind === 'style_pack';
}

function editActionLabel(asset: { format: string; kind: string }) {
  if (asset.format !== 'token') return '在工作台打开';
  if (isPaletteKind(asset.kind)) return '编辑 Token';
  if (asset.kind === 'component') return '编辑组件';
  if (asset.kind === 'animation') return '编辑动效';
  if (asset.kind === 'layout') return '编辑布局';
  return '编辑';
}

function tagSlug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '');
}

export default function LibraryPage() {
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [kind, setKind] = useState<KindTab>('all');
  const [tag, setTag] = useState<string | null>(null);
  // 只看收藏：后端已支持 favorite 过滤，这里只负责把开关带进列表请求
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AssetDetail | null>(null);
  const [preview, setPreview] = useState<AssetPreview | null>(null);
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [format, setFormat] = useState<CodeFormat>('react');
  const [exportData, setExportData] = useState<AssetExport | null>(null);
  const [busy, setBusy] = useState(false);
  const [coverNonce, setCoverNonce] = useState(0);
  const [versions, setVersions] = useState<AssetVersionSummary[]>([]);
  const [diff, setDiff] = useState<AssetVersionDiff | null>(null);
  const [versionsBusy, setVersionsBusy] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const selectSeq = useRef(0);
  const listSeq = useRef(0);
  const loadedRef = useRef(0);
  const canSeed = kind === 'all' || kind === 'component';
  const hasFilter = Boolean(query.trim() || tag || kind !== 'all' || favoriteOnly);

  const load = useCallback(
    async (silent = false) => {
      const seq = silent ? listSeq.current : listSeq.current + 1;
      if (!silent) {
        listSeq.current = seq;
        setLoading(true);
        setError(null);
        setNextCursor(null);
      }
      try {
        // 静默刷新（封面轮询）要保留用户已经翻出来的分页粒度，不能截回第一页。
        const target = silent ? Math.max(loadedRef.current, PAGE_SIZE) : PAGE_SIZE;
        const collected: AssetSummary[] = [];
        let cursor: string | undefined;
        let next: string | null = null;
        for (;;) {
          const page = await listAssets({
            q: query.trim() || undefined,
            kind: kind === 'all' ? undefined : kind,
            tag: tag ?? undefined,
            favorite: favoriteOnly ? 'true' : undefined,
            limit: PAGE_SIZE,
            cursor,
          });
          if (listSeq.current !== seq) return;
          collected.push(...page.items);
          next = page.nextCursor;
          cursor = next ?? undefined;
          if (!next || collected.length >= target) break;
        }
        setKnownTags((current) =>
          [...new Set([...current, ...collected.flatMap((item) => item.tags)])].slice(0, 24),
        );
        if (silent) {
          // 封面轮询只按 id 刷新已加载条目的状态：不重排、不推进游标。
          setAssets((current) => {
            const updates = new Map(collected.map((item) => [item.id, item]));
            return current.map((item) => updates.get(item.id) ?? item);
          });
        } else {
          setAssets(collected);
          setNextCursor(next);
        }
      } catch (cause) {
        if (listSeq.current !== seq) return;
        setError(cause instanceof Error ? cause.message : '资产库加载失败');
      } finally {
        if (!silent && listSeq.current === seq) setLoading(false);
      }
    },
    [favoriteOnly, kind, query, tag],
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const seq = listSeq.current;
    setLoadingMore(true);
    try {
      const result = await listAssets({
        q: query.trim() || undefined,
        kind: kind === 'all' ? undefined : kind,
        tag: tag ?? undefined,
        favorite: favoriteOnly ? 'true' : undefined,
        limit: PAGE_SIZE,
        cursor: nextCursor,
      });
      if (listSeq.current !== seq) return;
      setAssets((current) => {
        const known = new Set(current.map((item) => item.id));
        return [...current, ...result.items.filter((item) => !known.has(item.id))];
      });
      // 游标没前进说明后端排序在翻页期间发生了回卷，停止翻页避免死循环。
      setNextCursor(result.nextCursor === nextCursor ? null : result.nextCursor);
      setKnownTags((current) =>
        [...new Set([...current, ...result.items.flatMap((item) => item.tags)])].slice(0, 24),
      );
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '加载更多失败');
    } finally {
      setLoadingMore(false);
    }
  }, [favoriteOnly, kind, loadingMore, nextCursor, query, tag]);

  useEffect(() => {
    loadedRef.current = assets.length;
  }, [assets.length]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!assets.some((item) => item.coverStatus === 'pending' || item.coverStatus === 'running')) {
      return;
    }
    const timer = window.setTimeout(() => {
      void load(true);
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [assets, load]);

  useEffect(() => {
    if (!selected || (selected.coverStatus !== 'pending' && selected.coverStatus !== 'running')) {
      return;
    }
    const id = selected.id;
    const timer = window.setTimeout(() => {
      void getAsset(id)
        .then((updated) => {
          setSelected((current) => (current?.id === id ? updated : current));
          setCoverNonce((value) => value + 1);
        })
        .catch(() => undefined);
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [selected]);

  const selectAsset = useCallback(async (asset: AssetSummary) => {
    const seq = selectSeq.current + 1;
    selectSeq.current = seq;
    setBusy(true);
    setPreview(null);
    setExportData(null);
    setVersions([]);
    setDiff(null);
    try {
      const [detail, versionList] = await Promise.all([
        getAsset(asset.id),
        listAssetVersions(asset.id),
      ]);
      if (selectSeq.current !== seq) return;
      setSelected(detail);
      setVersions(versionList.items);
      setFormat(
        detail.format === 'package'
          ? 'react'
          : detail.format === 'token'
            ? 'css'
            : 'json',
      );
      if (showsLivePreview(detail)) {
        try {
          const current = await getAssetPreview(asset.id);
          if (selectSeq.current !== seq) return;
          setPreview(current);
        } catch (cause) {
          // 组件和动效预览失败时还能看色板；资产包没有这层退路。
          if (detail.format === 'package') throw cause;
          if (selectSeq.current === seq) {
            toast.error(cause instanceof Error ? cause.message : '预览加载失败');
          }
        }
      }
    } catch (cause) {
      if (selectSeq.current === seq) {
        toast.error(cause instanceof Error ? cause.message : '资产加载失败');
      }
    } finally {
      if (selectSeq.current === seq) setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!selected) return;
    const allowed =
      selected.format === 'package'
        ? ['react', 'css', 'registry', 'ai', 'json']
        : selected.format === 'token'
          ? ['css', 'json', 'ai']
          : ['json'];
    if (!allowed.includes(format)) return;
    let active = true;
    setExportData(null);
    getAssetExport(selected.id, format)
      .then((data) => {
        if (active) setExportData(data);
      })
      .catch((cause) => {
        if (active) toast.error(cause instanceof Error ? cause.message : '导出失败');
      });
    return () => {
      active = false;
    };
  }, [selected, format]);

  const code = useMemo(() => {
    if (!exportData) return '';
    if (format === 'react') {
      return (exportData.files ?? [])
        .map((file) => `// ${file.path}\n${file.content}`)
        .join('\n\n');
    }
    if (format === 'css') return exportData.css ?? '';
    if (format === 'registry') return JSON.stringify(exportData.registry ?? {}, null, 2);
    if (format === 'json') {
      return JSON.stringify(exportData.content ?? exportData.manifest ?? {}, null, 2);
    }
    return exportData.markdown ?? '';
  }, [exportData, format]);

  const availableCodeTabs = useMemo(() => {
    if (selected?.format === 'package') return CODE_TABS;
    if (selected?.format === 'token') {
      return CODE_TABS.filter((tab) => ['css', 'json', 'ai'].includes(tab.value));
    }
    return CODE_TABS.filter((tab) => tab.value === 'json');
  }, [selected?.format]);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} 已复制`);
    } catch {
      toast.error('复制失败，请手动选择');
    }
  };

  const seed = async () => {
    setBusy(true);
    try {
      const asset = await seedSampleAsset();
      toast.success('示例按钮已创建');
      await load();
      await selectAsset(asset);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '创建示例失败');
    } finally {
      setBusy(false);
    }
  };

  const favorite = async () => {
    if (!selected) return;
    try {
      const updated = await toggleAssetFavorite(selected.id);
      setSelected((current) => (current?.id === updated.id ? updated : current));
      // 只看收藏时这次切换会改变列表成员关系：取消收藏要移出，重新收藏要回到列表。
      // 服务端按 updatedAt 倒序（收藏切换会刷新该字段），重新收藏的资产因此排在首位，
      // 本地插入即可与服务端顺序一致，不必整页重拉丢掉已翻出的分页。
      if (favoriteOnly) {
        setAssets((current) => {
          if (!updated.favorite) return current.filter((item) => item.id !== updated.id);
          if (current.some((item) => item.id === updated.id)) {
            return current.map((item) => (item.id === updated.id ? updated : item));
          }
          return [updated, ...current];
        });
        return;
      }
      setAssets((current) =>
        current.map((item) =>
          item.id === updated.id ? { ...item, favorite: updated.favorite } : item,
        ),
      );
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '收藏失败');
    }
  };

  const compareVersion = async (versionId: string, againstVersionId: string) => {
    if (!selected) return;
    setVersionsBusy(true);
    try {
      setDiff(await diffAssetVersions(selected.id, versionId, againstVersionId));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '版本对比失败');
    } finally {
      setVersionsBusy(false);
    }
  };

  const archive = async () => {
    if (!selected) return;
    try {
      await archiveAsset(selected.id);
      toast.success('资产已归档');
      setArchiveOpen(false);
      setSelected(null);
      setPreview(null);
      setVersions([]);
      setDiff(null);
      // 本地移除已归档项，避免整页重新加载把已翻出的分页结果丢掉。
      const remaining = assets.filter((item) => item.id !== selected.id);
      setAssets(remaining);
      // 已加载的都被归档完但服务器还有更多：回到第一页，避免误显示空状态。
      if (remaining.length === 0 && nextCursor) void load();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '归档失败');
    }
  };

  const captureCover = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const updated = await captureAssetSnapshot(selected.id);
      setSelected((current) => (current?.id === updated.id ? updated : current));
      setCoverNonce((value) => value + 1);
      setAssets((current) =>
        current.map((item) =>
          item.id === updated.id
            ? { ...item, coverStatus: 'pending', coverError: null }
            : item,
        ),
      );
      toast.success('封面生成任务已提交');
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '封面生成失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader
        title="资产库"
        description="浏览设计资产，实时预览效果、查看导出代码并一键复制。"
      >
        <Link href="/design-library">
          <Button className="gap-2">
            <Sparkles className="h-4 w-4" />
            AI 新建
          </Button>
        </Link>
        <Link href="/studio">
          <Button variant="outline" className="gap-2">
            <Wand2 className="h-4 w-4" />
            去工作台
          </Button>
        </Link>
        {canSeed && !hasFilter && (
          <Button variant="outline" className="gap-2" onClick={() => void seed()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Box className="h-4 w-4" />}
            创建示例按钮
          </Button>
        )}
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-md border p-1">
          {KIND_TABS.map((item) => (
            <Button
              key={item.value}
              variant={kind === item.value ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => {
                setKind(item.value);
                setSelected(null);
                setPreview(null);
              }}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <SearchInput
          value={query}
          onChange={(value) => {
            setQuery(value);
            setSelected(null);
            setPreview(null);
          }}
          placeholder="搜索名称、slug、描述"
          className="w-full sm:w-72"
        />
        <Button
          variant={favoriteOnly ? 'secondary' : 'outline'}
          size="sm"
          className="gap-1"
          aria-pressed={favoriteOnly}
          title={favoriteOnly ? '显示全部资产' : '只显示已收藏的资产'}
          onClick={() => {
            setFavoriteOnly((value) => !value);
            setSelected(null);
            setPreview(null);
          }}
        >
          <Heart className={cn('h-4 w-4', favoriteOnly && 'fill-rose-500 text-rose-500')} />
          只看收藏
        </Button>
      </div>

      {knownTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-muted-foreground">标签</span>
          <Button
            variant={tag === null ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => {
              setTag(null);
              setSelected(null);
            }}
          >
            全部标签
          </Button>
          {knownTags.map((item) => (
            <Button
              key={item}
              variant={tag === tagSlug(item) ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => {
                setTag(tagSlug(item));
                setSelected(null);
                setPreview(null);
              }}
            >
              {item}
            </Button>
          ))}
        </div>
      )}

      {error && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-64 w-full" />
          ))}
        </div>
      ) : assets.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Box className="h-10 w-10 text-muted-foreground" />
            <div>
              <p className="font-medium">
                {hasFilter
                  ? '没有匹配的资产'
                  : canSeed
                    ? '还没有设计资产'
                    : '这一类还没有资产'}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {hasFilter
                  ? '换个搜索词、标签或筛选条件，或者去工作台新建一个。'
                  : canSeed
                    ? '先创建一个示例按钮，或去工作台做第一个组件。'
                    : '去工作台做一个，保存后会出现在这里。'}
              </p>
            </div>
            <div className="flex gap-2">
              {canSeed && !hasFilter && (
                <Button onClick={() => void seed()} disabled={busy} className="gap-2">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Box className="h-4 w-4" />}
                  创建示例按钮
                </Button>
              )}
              <Link href="/studio">
                <Button variant="outline">去工作台</Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {assets.map((asset) => {
            const meta = metaOf(asset.kind);
            const Icon = meta.icon;
            return (
              <button
                key={asset.id}
                type="button"
                onClick={() => void selectAsset(asset)}
                className={cn(
                  'group overflow-hidden rounded-lg border text-left transition',
                  selected?.id === asset.id
                    ? 'border-primary ring-2 ring-primary/20'
                    : 'hover:border-primary/40',
                )}
              >
                <div
                  className={cn(
                    'relative flex h-36 items-center justify-center bg-gradient-to-br',
                    meta.background,
                  )}
                >
                  {asset.hasCover ? (
                    <img
                      src={assetCoverUrl(
                        asset.id,
                        `${asset.version?.id ?? 'v1'}-${coverNonce}`,
                      )}
                      alt={`${asset.name} 封面`}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : asset.coverStatus === 'pending' || asset.coverStatus === 'running' ? (
                    <div className="flex h-12 w-40 flex-col items-center justify-center rounded-xl border border-white/70 bg-white/80 px-4 text-xs font-medium text-slate-600 shadow-lg backdrop-blur">
                      封面生成中…
                    </div>
                  ) : asset.coverStatus === 'failed' ? (
                    <div className="flex h-12 w-40 flex-col items-center justify-center rounded-xl border border-rose-200 bg-rose-50 px-4 text-xs font-medium text-rose-700 shadow-lg">
                      封面生成失败
                    </div>
                  ) : asset.palette.length > 0 ? (
                    <div className="flex h-full w-full flex-col justify-center gap-2 px-8">
                      <div className="flex gap-1.5">
                        {asset.palette.slice(0, 7).map((color) => (
                          <span
                            key={color}
                            className="h-10 flex-1 rounded-md border border-white/70 shadow-sm"
                            style={{ backgroundColor: color }}
                          />
                        ))}
                      </div>
                      <p className="text-center text-[11px] text-muted-foreground">
                        色板 · {asset.palette.length} 色
                      </p>
                    </div>
                  ) : (
                    <div className="flex h-12 w-40 items-center justify-center rounded-xl border border-white/70 bg-white/80 px-4 text-sm font-medium text-slate-700 shadow-lg backdrop-blur">
                      {asset.name}
                    </div>
                  )}
                  <Badge
                    variant="secondary"
                    className="absolute left-3 top-3 z-10 gap-1 text-[11px]"
                  >
                    <Icon className="h-3 w-3" />
                    {meta.label}
                    {asset.subtype ? ` · ${asset.subtype}` : ''}
                  </Badge>
                </div>
                <div className="space-y-2 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{asset.name}</p>
                      {asset.description && (
                        <p className="truncate text-xs text-muted-foreground">{asset.description}</p>
                      )}
                    </div>
                    {asset.favorite && <Heart className="h-4 w-4 fill-rose-500 text-rose-500" />}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {asset.tags.slice(0, 3).map((tag) => (
                      <Badge key={tag} variant="outline" className="text-[10px]">
                        {tag}
                      </Badge>
                    ))}
                    {asset.version && (
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        v{asset.version.versionNumber}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {!loading && nextCursor && (
        <div className="flex justify-center pt-1">
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => void loadMore()}
            disabled={loadingMore}
          >
            {loadingMore ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
            {loadingMore ? '加载中…' : '加载更多'}
          </Button>
        </div>
      )}

      {selected && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-lg">{selected.name}</CardTitle>
                <Badge variant="secondary">{metaOf(selected.kind).label}</Badge>
                {selected.subtype && <Badge variant="outline">{selected.subtype}</Badge>}
                {selected.version && (
                  <Badge variant="outline">v{selected.version.versionNumber}</Badge>
                )}
                {selected.coverStatus && selected.coverStatus !== 'succeeded' && (
                  <Badge
                    variant={selected.coverStatus === 'failed' ? 'destructive' : 'secondary'}
                    className="text-[10px]"
                  >
                    {selected.coverStatus === 'failed' ? '封面生成失败' : '封面生成中'}
                  </Badge>
                )}
              </div>
              {selected.description && (
                <p className="mt-1 text-sm text-muted-foreground">{selected.description}</p>
              )}
              <div className="mt-2 flex flex-wrap gap-1">
                {selected.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-[11px]">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              {selected.format === 'package' && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => void captureCover()}
                  disabled={busy}
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Camera className="h-3.5 w-3.5" />
                  )}
                  {selected.hasCover ? '重生成封面' : '生成封面'}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => void favorite()}
              >
                <Heart className={cn('h-3.5 w-3.5', selected.favorite && 'fill-rose-500 text-rose-500')} />
                {selected.favorite ? '已收藏' : '收藏'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-destructive"
                onClick={() => setArchiveOpen(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                归档
              </Button>
              {(selected.format === 'package' || selected.format === 'token') && (
                <Link href={`/studio?asset=${encodeURIComponent(selected.id)}`}>
                  <Button variant="outline" size="sm" className="gap-1.5">
                    <Sparkles className="h-3.5 w-3.5" />
                    {editActionLabel(selected)}
                  </Button>
                </Link>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <div
              className={cn(
                'grid gap-4',
                (selected.whenToUse ||
                  (selected.palette.length > 0 && !isPaletteKind(selected.kind)) ||
                  (selected.tokens ?? []).length > 0 ||
                  selected.files.length > 0) &&
                  'lg:grid-cols-[minmax(0,1fr)_300px]',
              )}
            >
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{previewTitle(selected, Boolean(preview))}</span>
                    {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                  </div>
                  {showsLivePreview(selected) && (preview || selected.format === 'package') && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">预览宽度</span>
                      <div className="flex gap-1 rounded-md border p-1">
                        {(['desktop', 'tablet', 'mobile'] as const).map((item) => {
                          const Icon = item === 'desktop' ? Monitor : item === 'tablet' ? Tablet : Smartphone;
                          const label = item === 'desktop' ? '宽' : item === 'tablet' ? '中' : '窄';
                          return (
                            <Button
                              key={item}
                              variant={viewport === item ? 'secondary' : 'ghost'}
                              size="sm"
                              className="gap-1.5"
                              aria-label={`${label}预览`}
                              onClick={() => setViewport(item)}
                            >
                              <Icon className="h-3.5 w-3.5" />
                              {label}
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
                <div className="rounded-lg border bg-slate-100 p-4">
                  <div
                    className="mx-auto overflow-hidden rounded-md border bg-white shadow-sm"
                    style={{ maxWidth: VIEWPORT_WIDTH[viewport] }}
                  >
                    {showsLivePreview(selected) && preview ? (
                      <iframe
                        key={`${selected.id}-${viewport}`}
                        title={`${selected.name} 预览`}
                        sandbox="allow-scripts"
                        srcDoc={preview.html}
                        className="h-[420px] w-full bg-transparent"
                      />
                    ) : showsLivePreview(selected) && (busy || selected.format === 'package') ? (
                      <Skeleton className="h-[420px] w-full" />
                    ) : selected.format === 'token' ? (
                      <div className="flex h-[420px] flex-col items-center justify-center gap-5 p-8">
                        {selected.palette.length ? (
                          <>
                            <div className="grid w-full max-w-lg grid-cols-4 gap-3">
                              {selected.palette.map((color) => (
                                <div key={color} className="space-y-1">
                                  <div
                                    className="h-16 rounded-md border shadow-sm"
                                    style={{ backgroundColor: color }}
                                  />
                                  <p className="truncate text-center font-mono text-[10px] text-muted-foreground">
                                    {color}
                                  </p>
                                </div>
                              ))}
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {paletteCaption(selected.kind, selected.palette.length)}
                            </p>
                          </>
                        ) : (
                          <>
                            <Palette className="h-8 w-8 text-muted-foreground" />
                            <p className="text-sm text-muted-foreground">{paletteEmptyCopy(selected.kind)}</p>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="flex h-[420px] flex-col items-center justify-center gap-3 p-8 text-center">
                        <LayoutTemplate className="h-8 w-8 text-muted-foreground" />
                        <p className="text-sm">旧格式资产，暂不支持实时预览</p>
                        <p className="text-xs text-muted-foreground">
                          可以在下方 JSON 查看原始声明。
                        </p>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {selected.files.length > 0 && <span>{selected.files.length} 个文件</span>}
                  {selected.format === 'token' && (
                    <>
                      {selected.files.length > 0 && <span>·</span>}
                      <span>{selected.palette.length} 个颜色</span>
                      {preview && (
                        <>
                          <span>·</span>
                          <span>CSS {(preview.cssBytes / 1024).toFixed(1)} KB</span>
                        </>
                      )}
                    </>
                  )}
                  {selected.format === 'package' && (
                    <>
                      {selected.files.length > 0 && <span>·</span>}
                      <span>{(selected.states ?? []).join(' / ') || '无状态声明'}</span>
                      {preview && (
                        <>
                          <span>·</span>
                          <span>CSS {(preview.cssBytes / 1024).toFixed(1)} KB</span>
                          <span>·</span>
                          <span>JS {(preview.jsBytes / 1024).toFixed(1)} KB</span>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>

              {(selected.whenToUse ||
                (selected.palette.length > 0 && !isPaletteKind(selected.kind)) ||
                (selected.tokens ?? []).length > 0 ||
                selected.files.length > 0) && (
                <aside className="space-y-3 rounded-md border p-3 text-sm">
                  {selected.whenToUse && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">什么时候用</p>
                      <p className="mt-1">{selected.whenToUse}</p>
                    </div>
                  )}
                  {selected.palette.length > 0 && !isPaletteKind(selected.kind) && (
                    <>
                      {selected.whenToUse && <Separator />}
                      <div>
                        <p className="text-xs font-medium text-muted-foreground">用到的颜色</p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {selected.palette.map((color) => (
                            <span
                              key={color}
                              className="h-5 w-5 rounded border"
                              style={{ backgroundColor: color }}
                              title={color}
                            />
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                  {(selected.tokens ?? []).length > 0 && (
                    <>
                      {(selected.whenToUse ||
                        (selected.palette.length > 0 && !isPaletteKind(selected.kind))) && (
                        <Separator />
                      )}
                      <div>
                        <p className="text-xs font-medium text-muted-foreground">Token</p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {selected.tokens.map((token) => (
                            <Badge key={token} variant="outline" className="font-mono text-[10px]">
                              {token}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                  {selected.files.length > 0 && (
                    <>
                      {(selected.whenToUse ||
                        (selected.palette.length > 0 && !isPaletteKind(selected.kind)) ||
                        (selected.tokens ?? []).length > 0) && <Separator />}
                      <div>
                        <p className="text-xs font-medium text-muted-foreground">文件</p>
                        <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                          {selected.files.slice(0, 6).map((file) => (
                            <li key={file.path} className="truncate font-mono">
                              {file.target || file.path}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </>
                  )}
                </aside>
              )}
            </div>

            <Separator />

            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1 rounded-md border p-1">
                  {availableCodeTabs.map((item) => (
                    <Button
                      key={item.value}
                      variant={format === item.value ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => setFormat(item.value)}
                    >
                      {item.label}
                    </Button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    disabled={!code}
                    onClick={() => void copy(code, availableCodeTabs.find((item) => item.value === format)?.label ?? '代码')}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    复制
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    disabled={!preview}
                    onClick={() =>
                      preview && void copy(preview.fragment || preview.html, preview.fragment ? '组件 HTML' : 'HTML')
                    }
                  >
                    <Check className="h-3.5 w-3.5" />
                    复制 HTML
                  </Button>
                </div>
              </div>
              <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
                {code || '正在加载导出内容…'}
              </pre>
            </div>
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title="归档这个资产？"
        description="归档后资产不会出现在资产库默认列表，但历史版本和文件仍保留。"
        confirmLabel="归档"
        variant="destructive"
        onConfirm={archive}
      />

      {selected && versions.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <History className="h-4 w-4" />
              版本历史
            </CardTitle>
            {versionsBusy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </CardHeader>
          <CardContent className="space-y-3">
            {versions.map((version, index) => (
              <div
                key={version.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">v{version.versionNumber}</Badge>
                    {index === 0 && <Badge variant="outline">当前</Badge>}
                    <span className="text-xs text-muted-foreground">
                      {new Date(version.publishedAt ?? version.createdAt).toLocaleString('zh-CN')}
                    </span>
                    {version.fileCount > 0 && (
                      <span className="text-xs text-muted-foreground">{version.fileCount} 个文件</span>
                    )}
                  </div>
                  <p className="text-sm">{version.summary || '无摘要'}</p>
                  <p
                    className="truncate font-mono text-[10px] text-muted-foreground"
                    title={version.contentHash}
                  >
                    {version.contentHash.slice(0, 12)}
                  </p>
                </div>
                {index < versions.length - 1 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    disabled={versionsBusy}
                    onClick={() => void compareVersion(version.id, versions[index + 1].id)}
                  >
                    <GitCompare className="h-3.5 w-3.5" />
                    对比上一版
                  </Button>
                )}
              </div>
            ))}

            {diff && (
              <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="outline">
                    v{diff.from.versionNumber} → v{diff.to.versionNumber}
                  </Badge>
                  <span>新增 {diff.summary.added}</span>
                  <span>删除 {diff.summary.removed}</span>
                  <span>修改 {diff.summary.changed}</span>
                </div>
                {diff.files.filter((file) => file.status !== 'unchanged').length === 0 ? (
                  <p className="text-xs text-muted-foreground">两个版本内容相同。</p>
                ) : (
                  diff.files
                    .filter((file) => file.status !== 'unchanged')
                    .map((file) => (
                      <details key={file.path} className="rounded border bg-background p-2">
                        <summary className="cursor-pointer text-xs">
                          <Badge
                            variant={file.status === 'removed' ? 'destructive' : 'secondary'}
                            className="mr-2 text-[10px]"
                          >
                            {file.status}
                          </Badge>
                          <span className="font-mono">{file.path}</span>
                        </summary>
                        <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed">
                          {file.before ? `--- before
${file.before}

` : ''}
                          {file.after ?? ''}
                        </pre>
                      </details>
                    ))
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
