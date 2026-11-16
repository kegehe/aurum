'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Pencil,
  Trash2,
  RotateCcw,
  RefreshCw,
  FileText,
  Heart,
  Image,
  Video,
  Loader2,
  Square,
  Camera,
  Wand2,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Expand,
} from 'lucide-react';
import { LoadingState } from '@/components/shared/loading-state';
import { ErrorState } from '@/components/shared/error-state';
import { ResourceTypeBadge } from '@/components/shared/resource-type-badge';
import { ResourceTypeIcon } from '@/components/shared/resource-type-icon';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  getResource,
  getResourceNeighbors,
  updateResource,
  batchSetResourceFavorite,
  softDeleteResource,
  restoreResource,
  reprocessResource,
  getResourceDownloadUrl,
  getResourcePreviewUrl,
  getResourceThumbnailUrl,
  getResourceFileDownloadUrl,
  checkResourceLocators,
  mirrorRemoteResource,
  captureResourceSnapshot,
} from '@/lib/api/resources';
import { cancelIngestionJob, listIngestionJobs } from '@/lib/api/ingestion';
import { listCategories } from '@/lib/api/categories';
import { formatByteString, formatDateTime } from '@/lib/format';
import { buildFilterParams, filtersFromSearchParams } from '@/lib/resource-filters';
import { cn } from '@/lib/utils';
import { PROCESSING_STATUS_LABELS, LOCATOR_TYPE_LABELS } from '@/lib/constants';
import { designMediaHref, isDesignMediaType } from '@/lib/resource';
import type { ResourceDetail, CategoryTreeNode, IngestionJobItem } from '@/lib/types';
import { IngestionJobStatus, IngestionJobType, type ResourceType } from '@aurum/shared-types';

const NO_FOLDER_VALUE = '__no_folder__';

function flattenCategories(categories: CategoryTreeNode[]): CategoryTreeNode[] {
  return categories.flatMap((category) => [category, ...flattenCategories(category.children)]);
}

const FILE_ROLE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  original: FileText,
  snapshot: FileText,
  thumbnail: Image,
  preview: Image,
  extracted_text: FileText,
  transcode: Video,
};

const FILE_ROLE_LABELS: Record<string, string> = {
  original: '原文件',
  snapshot: '页面快照',
  thumbnail: '缩略图',
  preview: '预览',
  extracted_text: '提取文本',
  transcode: '转码',
};

const TEXT_PREVIEW_MAX_CHARS = 200_000;
/** 详情页图片预览的缩放上限（长边像素）：不做缩放时会直接下发 43MB 级的原图 */
const DETAIL_PREVIEW_MAX_EDGE = 2560;

/** 预览失败 / 无可用预览时的类型图标占位 */
function PreviewIconFallback({ type }: { type: ResourceType }) {
  return (
    <div className="flex items-center justify-center py-16">
      <ResourceTypeIcon type={type} className="h-24 w-24 text-muted-foreground" />
    </div>
  );
}

/** 详情页视频静音自动循环：补写 muted 并主动起播，与列表卡片行为一致，无需再点一次 */
function handleDetailVideoRef(el: HTMLVideoElement | null) {
  if (!el) return;
  el.muted = true;
  try {
    void Promise.resolve(el.play()).catch(() => undefined);
  } catch {
    // 浏览器不支持该视频格式时保持 poster 展示，交给 onError 兜底
  }
}

/** 文本在线预览：流式拉取原文件内容以 <pre> 展示（React 自动转义，避免 XSS） */
function TextViewer({
  url,
  resourceType,
  onError,
}: {
  url: string;
  resourceType: ResourceType;
  onError?: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState(false);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  });

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setText(null);
    setTruncated(false);
    setFailed(false);

    const read = async (): Promise<{ text: string; truncated: boolean }> => {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error('Empty response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let result = '';
      // 按 Unicode 码点计数：emoji 等代理对不会被重复计数，截断时也不会拆散代理对
      let charCount = 0;
      let truncated = false;
      for (;;) {
        if (cancelled) return { text: result, truncated };
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        result += chunk;
        charCount += Array.from(chunk).length;
        if (charCount >= TEXT_PREVIEW_MAX_CHARS) {
          truncated = charCount > TEXT_PREVIEW_MAX_CHARS;
          if (!truncated) {
            // 恰好达到上限：再多读一次确认是否还有内容，避免误判截断
            const next = await reader.read();
            truncated = !next.done;
          }
          // 已读到显示上限，停止拉取，避免大文件占用内存
          controller.abort();
          break;
        }
      }
      result += decoder.decode();
      return { text: result, truncated };
    };

    void read()
      .then(({ text: raw, truncated: isTruncated }) => {
        if (!cancelled) {
          // 截断时按码点边界截取，避免拆散代理对产生乱码
          setText(isTruncated ? Array.from(raw).slice(0, TEXT_PREVIEW_MAX_CHARS).join('') : raw);
          setTruncated(isTruncated);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
          onErrorRef.current?.();
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url]);

  if (failed) {
    return <PreviewIconFallback type={resourceType} />;
  }

  if (text === null) {
    return (
      <div className="flex items-center justify-center py-16">
        <span className="text-sm text-muted-foreground">正在加载文本内容…</span>
      </div>
    );
  }

  return (
    <div className="w-full">
      <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-4 font-mono text-xs leading-relaxed">
        {text}
      </pre>
      {truncated && (
        <p className="px-4 pb-4 pt-2 text-center text-xs text-muted-foreground">
          文件过大，仅显示前 {TEXT_PREVIEW_MAX_CHARS.toLocaleString()}{' '}
          个字符。请使用「下载」查看完整内容。
        </p>
      )}
    </div>
  );
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.4;
/** 页内画布最大高度，避免超大屏上图片把页面撑得太长 */
const MAX_FRAME_HEIGHT = 760;

type ZoomView = { scale: number; x: number; y: number };

/**
 * 可缩放图片查看器：
 * - 滚轮 / 触控板捏合 / 双指捏合缩放，均以操作点为锚（1x ~ 8x）
 * - 放大后按住拖拽平移
 * - 双击在「适应窗口」与 2x 之间切换
 * - 大图加载时显示转圈，加载完成后淡入
 * 缩放用 CSS transform 实现（不改变布局盒尺寸），平移边界按图片实际布局尺寸计算，
 * 保证图片不会被拖出可视区域。
 */
function ZoomableImage({
  src,
  alt,
  referrerPolicy,
  onError,
  className,
  fitToImage = false,
  enableEscapeReset = true,
  onRequestFullscreen,
}: {
  src: string;
  alt: string;
  referrerPolicy?: 'no-referrer';
  onError?: () => void;
  /** 外层容器尺寸类，默认 65vh 视口高度；全屏查看时传 h-full */
  className?: string;
  /** 让画布尺寸贴合图片比例（页内查看用）：小图不放大、比例不符不留大片空白 */
  fitToImage?: boolean;
  /** 全屏场景下 Esc 交给外层弹层关闭，不再拦截 */
  enableEscapeReset?: boolean;
  /** 传入即显示「全屏查看」按钮 */
  onRequestFullscreen?: () => void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<ZoomView>({ scale: MIN_ZOOM, x: 0, y: 0 });
  const viewRef = useRef(view);
  const [dragging, setDragging] = useState(false);
  // 加载态：大图首屏先显示转圈，加载完成后淡入
  const [loaded, setLoaded] = useState(false);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [fitSize, setFitSize] = useState<{ width: number; height: number } | null>(null);
  // 当前按下的指针（用于识别双指捏合）
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{
    distance: number;
    scale: number;
    x: number;
    y: number;
    midX: number;
    midY: number;
  } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  // 统一入口：写入前把平移量约束在可拖动范围内
  const commit = useCallback((next: ZoomView) => {
    const frame = frameRef.current;
    const img = imgRef.current;
    let { scale, x, y } = next;
    if (scale <= MIN_ZOOM) {
      // 回到原始比例时完全居中
      scale = MIN_ZOOM;
      x = 0;
      y = 0;
    } else if (frame && img) {
      // offsetWidth/offsetHeight 是未经 transform 的布局尺寸
      const maxX = Math.max(0, (img.offsetWidth * scale - frame.clientWidth) / 2);
      const maxY = Math.max(0, (img.offsetHeight * scale - frame.clientHeight) / 2);
      x = Math.min(Math.max(x, -maxX), maxX);
      y = Math.min(Math.max(y, -maxY), maxY);
    }
    viewRef.current = { scale, x, y };
    setView({ scale, x, y });
  }, []);

  // 切换资源（上一个/下一个）时复位
  useEffect(() => {
    const reset = { scale: MIN_ZOOM, x: 0, y: 0 };
    viewRef.current = reset;
    setView(reset);
    dragRef.current = null;
    pinchRef.current = null;
    pointersRef.current.clear();
    setDragging(false);
    setLoaded(false);
    // 保留上一张图的 natural/fitSize：切换相邻资源时画布不会先塌回 65vh 再撑开，
    // 新图加载完成后再按实际比例重算
    // 命中缓存时 onLoad 可能早于挂载，补一次状态同步
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth > 0) {
      setLoaded(true);
      setNatural({ width: img.naturalWidth, height: img.naturalHeight });
    }
  }, [src]);

  // 页内查看时按图片比例计算画布尺寸：小图保持原始尺寸，极宽/极窄图不再留大片空白
  useEffect(() => {
    if (!fitToImage || !natural) {
      setFitSize(null);
      return;
    }
    const update = () => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const availableWidth = wrapper.clientWidth;
      if (!availableWidth) return;
      const ratio = natural.width / natural.height;
      const maxHeight = Math.min(window.innerHeight * 0.65, MAX_FRAME_HEIGHT);
      // 先受高度限制，再受原始像素与可用宽度限制：小图不放大，大图不留黑边
      const height = Math.min(maxHeight, natural.height, availableWidth / ratio);
      const width = Math.min(availableWidth, natural.width, height * ratio);
      if (height < 1 || width < 1) return;
      setFitSize({ width: Math.round(width), height: Math.round(height) });
    };
    update();
    window.addEventListener('resize', update);
    if (typeof ResizeObserver === 'undefined') {
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    if (wrapperRef.current) observer.observe(wrapperRef.current);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [fitToImage, natural]);

  // 滚轮缩放：必须用非 passive 监听，否则无法阻止整页滚动
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const { scale, x, y } = viewRef.current;
      // deltaMode: 0=像素(Chrome)、1=行(Firefox)、2=页，先归一到像素再算缩放
      const delta =
        event.deltaMode === 1
          ? event.deltaY * 16
          : event.deltaMode === 2
            ? event.deltaY * 100
            : event.deltaY;
      // 触控板捏合会以 ctrlKey + 小 deltaY 的形式派发，灵敏度需要单独放大
      const sensitivity = event.ctrlKey ? 0.01 : 0.0015;
      const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale * Math.exp(-delta * sensitivity)));
      if (Math.abs(target - scale) < 0.001) return;
      const rect = frame.getBoundingClientRect();
      // 光标相对容器中心的坐标，缩放后该点保持不动
      const px = event.clientX - rect.left - rect.width / 2;
      const py = event.clientY - rect.top - rect.height / 2;
      const ratio = target / scale;
      commit({
        scale: target,
        x: px - (px - x) * ratio,
        y: py - (py - y) * ratio,
      });
    };
    frame.addEventListener('wheel', handleWheel, { passive: false });
    return () => frame.removeEventListener('wheel', handleWheel);
  }, [commit]);

  // 容器尺寸变化（窗口缩放、侧栏折叠）后重新约束平移量，避免图片被留在视口外
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => commit(viewRef.current));
    observer.observe(frame);
    return () => observer.disconnect();
  }, [commit]);

  // 双指手势必须阻止页面滚动，否则捏合会被页面滚动手势打断
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length >= 2) event.preventDefault();
    };
    frame.addEventListener('touchmove', handleTouchMove, { passive: false });
    return () => frame.removeEventListener('touchmove', handleTouchMove);
  }, []);

  // 按钮 / 双击缩放：未指定坐标时以容器中心为锚点
  const zoomAt = useCallback(
    (nextScale: number, clientX?: number, clientY?: number) => {
      const frame = frameRef.current;
      if (!frame) return;
      const { scale, x, y } = viewRef.current;
      const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextScale));
      if (Math.abs(target - scale) < 0.001) return;
      const rect = frame.getBoundingClientRect();
      const px = (clientX ?? rect.left + rect.width / 2) - rect.left - rect.width / 2;
      const py = (clientY ?? rect.top + rect.height / 2) - rect.top - rect.height / 2;
      const ratio = target / scale;
      commit({
        scale: target,
        x: px - (px - x) * ratio,
        y: py - (py - y) * ratio,
      });
    },
    [commit],
  );

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const frame = event.currentTarget;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    frame.setPointerCapture(event.pointerId);

    // 第二根手指落下 → 进入捏合，放弃单指拖拽
    if (pointersRef.current.size === 2) {
      const [a, b] = Array.from(pointersRef.current.values());
      const rect = frame.getBoundingClientRect();
      const { scale, x, y } = viewRef.current;
      dragRef.current = null;
      setDragging(false);
      pinchRef.current = {
        distance: Math.hypot(b.x - a.x, b.y - a.y) || 1,
        scale,
        x,
        y,
        // 两指中点（相对容器中心）
        midX: (a.x + b.x) / 2 - rect.left - rect.width / 2,
        midY: (a.y + b.y) / 2 - rect.top - rect.height / 2,
      };
      return;
    }

    // 只响应主键拖拽；原始比例下无需拖动，保持图片居中
    if (event.button !== 0 || viewRef.current.scale <= MIN_ZOOM) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: viewRef.current.x,
      originY: viewRef.current.y,
    };
    setDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const tracked = pointersRef.current.get(event.pointerId);
    if (!tracked) return;
    tracked.x = event.clientX;
    tracked.y = event.clientY;

    // 双指捏合：距离比决定缩放倍数，中点位移决定平移，锚点保持在中点下方
    const pinch = pinchRef.current;
    if (pinch && pointersRef.current.size >= 2) {
      const [a, b] = Array.from(pointersRef.current.values());
      const rect = event.currentTarget.getBoundingClientRect();
      const distance = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const scale = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, (pinch.scale * distance) / pinch.distance),
      );
      const ratio = scale / pinch.scale;
      const midX = (a.x + b.x) / 2 - rect.left - rect.width / 2;
      const midY = (a.y + b.y) / 2 - rect.top - rect.height / 2;
      commit({
        scale,
        x: midX - (pinch.midX - pinch.x) * ratio,
        y: midY - (pinch.midY - pinch.y) * ratio,
      });
      return;
    }

    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    commit({
      scale: viewRef.current.scale,
      x: drag.originX + (event.clientX - drag.startX),
      y: drag.originY + (event.clientY - drag.startY),
    });
  };

  const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      setDragging(false);
    }
    // 松开一根手指后，剩下那根继续可以拖动，避免手势中断
    const remaining = Array.from(pointersRef.current.entries());
    if (remaining.length === 1 && viewRef.current.scale > MIN_ZOOM) {
      const [pointerId, point] = remaining[0];
      dragRef.current = {
        pointerId,
        startX: point.x,
        startY: point.y,
        originX: viewRef.current.x,
        originY: viewRef.current.y,
      };
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  // 键盘操作：+/- 缩放、0/Esc 复位（容器可聚焦，配合 tabIndex 使用）
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const { scale } = viewRef.current;
    switch (event.key) {
      case '+':
      case '=':
        event.preventDefault();
        zoomAt(scale * ZOOM_STEP);
        break;
      case '-':
      case '_':
        event.preventDefault();
        zoomAt(scale / ZOOM_STEP);
        break;
      case '0':
        event.preventDefault();
        zoomAt(MIN_ZOOM);
        break;
      case 'Escape':
        // 仅在放大时拦截，未放大时不吞掉 Esc（可能用于关闭外层弹层）
        if (enableEscapeReset && scale > MIN_ZOOM) {
          event.preventDefault();
          zoomAt(MIN_ZOOM);
        }
        break;
    }
  };

  const zoomed = view.scale > MIN_ZOOM + 0.001;

  return (
    <div
      ref={wrapperRef}
      className={cn(
        'relative flex w-full flex-col',
        // 页内查看跟随画布高度；全屏用传入的 h-full
        fitToImage ? null : (className ?? 'h-[65vh] max-h-[760px] min-h-[320px]'),
      )}
      // 键盘事件挂在容器上：焦点在控制栏按钮时也能继续用 +/- 缩放
      onKeyDown={handleKeyDown}
    >
      <div
        ref={frameRef}
        tabIndex={0}
        role="group"
        aria-label="图片预览，可滚轮、加减键或双指缩放，放大后拖拽移动，双击或按 0 复位"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onDoubleClick={(event) => zoomAt(zoomed ? MIN_ZOOM : 2, event.clientX, event.clientY)}
        className={cn(
          'relative flex w-full select-none items-center justify-center overflow-hidden rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          fitToImage ? 'mx-auto h-[65vh] shrink-0' : 'min-h-0 flex-1',
          zoomed ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in',
        )}
        style={{
          // 页内查看：画布尺寸贴合图片比例（优先于类名里的兜底高度）
          ...(fitToImage && fitSize ? { width: fitSize.width, height: fitSize.height } : null),
          // 未放大时保留竖向滚动，双指捏合由 touchmove 拦截
          touchAction: zoomed ? 'none' : 'pan-y',
        }}
      >
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          referrerPolicy={referrerPolicy}
          draggable={false}
          onError={onError}
          onLoad={(event) => {
            setLoaded(true);
            setNatural({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            });
          }}
          className={cn(
            'max-h-full max-w-full object-contain transition-opacity duration-300 will-change-transform',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        />
        {!loaded && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
      {/* 控制条放在图片下方，不遮挡画面 */}
      <div className="flex items-center justify-between gap-2 pt-1.5">
        <span className="hidden pl-1 text-xs text-muted-foreground sm:inline">
          滚轮或双指缩放 · 拖拽移动 · 双击复位 · +/- 键缩放
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-1.5"
            title="缩小"
            aria-label="缩小"
            disabled={!zoomed}
            onClick={() => zoomAt(viewRef.current.scale / ZOOM_STEP)}
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <span className="w-11 text-center text-xs tabular-nums text-muted-foreground">
            {Math.round(view.scale * 100)}%
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-1.5"
            title="放大"
            aria-label="放大"
            disabled={view.scale >= MAX_ZOOM}
            onClick={() => zoomAt(viewRef.current.scale * ZOOM_STEP)}
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-1.5"
            title="适应窗口"
            aria-label="适应窗口"
            disabled={!zoomed}
            onClick={() => zoomAt(MIN_ZOOM)}
          >
            <Maximize2 className="h-4 w-4" />
          </Button>
          {onRequestFullscreen && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-1.5"
              title="全屏查看"
              aria-label="全屏查看"
              onClick={onRequestFullscreen}
            >
              <Expand className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 页内查看 + 全屏查看：两处图片预览（本地原文件、外部资源）共用同一套缩放交互。
 * 全屏态用 Dialog 承载，Esc 或右上角关闭；两个实例各自持有缩放状态，
 * 关闭全屏后回到页内仍是原来的视图。
 */
function ImageViewer({
  src,
  alt,
  referrerPolicy,
  onError,
}: {
  src: string;
  alt: string;
  referrerPolicy?: 'no-referrer';
  onError?: () => void;
}) {
  const [fullscreenOpen, setFullscreenOpen] = useState(false);

  return (
    <>
      <ZoomableImage
        src={src}
        alt={alt}
        referrerPolicy={referrerPolicy}
        onError={onError}
        fitToImage
        onRequestFullscreen={() => setFullscreenOpen(true)}
      />
      <Dialog open={fullscreenOpen} onOpenChange={setFullscreenOpen}>
        <DialogContent className="flex h-[100dvh] max-w-none flex-col gap-0 rounded-none border-0 bg-background p-0 sm:rounded-none">
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          {/* 全屏态 Esc 直接关闭弹层，缩放复位用 0 键或双击 */}
          <ZoomableImage
            src={src}
            alt={alt}
            referrerPolicy={referrerPolicy}
            onError={onError}
            className="h-full"
            enableEscapeReset={false}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * 内联预览查看器：按资源类型渲染对应元素
 * - 图片 → 可缩放查看器（滚轮/键盘缩放、拖拽平移、可全屏）
 * - 视频 → <video>（HTML5 播放器，可显示封面）
 * - 音频 → <audio>
 * - PDF → <iframe>（浏览器内置 PDF 查看器）
 * - 文本 → <pre>（拉取内容渲染）
 * - 其他 / 预览失败 → 类型图标
 */
function InlinePreview({
  resource,
  previewUrl,
  posterUrl,
  onError,
}: {
  resource: ResourceDetail;
  previewUrl: string | null;
  posterUrl?: string | null;
  onError?: () => void;
}) {
  const type = resource.resourceType;
  const mimeType = resource.mimeType.toLowerCase();
  // MIME 可能带参数（如 application/pdf; charset=binary），用前缀匹配
  const isPdf = type === 'document' && mimeType.startsWith('application/pdf');
  const isText = type === 'text';
  const isVideo = type === 'video';
  const isAudio = type === 'audio';

  if (!previewUrl) {
    return <PreviewIconFallback type={type} />;
  }

  if (isText) {
    return <TextViewer url={previewUrl} resourceType={type} onError={onError} />;
  }

  if (isPdf) {
    return (
      <div className="w-full pt-4">
        <iframe
          src={previewUrl}
          title="PDF 预览"
          className="h-[70vh] w-full rounded-md border border-border"
        />
        <p className="px-4 pb-4 pt-2 text-center text-xs text-muted-foreground">
          如果 PDF 未正常显示，请使用右上角「下载」查看原文件。
        </p>
      </div>
    );
  }

  if (isVideo) {
    return (
      <div className="flex w-full items-center justify-center py-8">
        <video
          ref={handleDetailVideoRef}
          controls
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          src={previewUrl}
          poster={posterUrl ?? undefined}
          className="max-h-[65vh] max-w-full rounded-md bg-black/5"
          onError={onError}
        />
      </div>
    );
  }

  if (isAudio) {
    return (
      <div className="flex w-full items-center justify-center py-16">
        <audio
          controls
          preload="metadata"
          src={previewUrl}
          className="w-full max-w-md"
          onError={onError}
        />
      </div>
    );
  }

  if (type === 'image') {
    return (
      <ImageViewer
        src={previewUrl}
        alt={resource.title || resource.originalFilename}
        onError={onError}
      />
    );
  }

  return <PreviewIconFallback type={type} />;
}

/**
 * 外部资源预览：根据预览定位器的实际 Content-Type 决定查看器
 * 图片/未知类型用可缩放查看器（多为缩略图），video/audio/pdf 用对应播放器
 */
function ExternalPreview({
  url,
  resource,
  onError,
}: {
  url: string;
  resource: ResourceDetail;
  onError?: () => void;
}) {
  const locator = resource.locators?.find((l) => l.locatorType === 'preview');
  const contentType = (locator?.contentType ?? '').toLowerCase();

  if (contentType.startsWith('video/')) {
    return (
      <div className="flex w-full items-center justify-center py-8">
        <video
          ref={handleDetailVideoRef}
          controls
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          src={url}
          className="max-h-[65vh] max-w-full rounded-md bg-black/5"
          onError={onError}
        />
      </div>
    );
  }

  if (contentType.startsWith('audio/')) {
    return (
      <div className="flex w-full items-center justify-center py-16">
        <audio
          controls
          preload="metadata"
          src={url}
          className="w-full max-w-md"
          onError={onError}
        />
      </div>
    );
  }

  if (contentType.startsWith('application/pdf')) {
    return (
      <div className="w-full pt-4">
        <iframe
          src={url}
          title="PDF 预览"
          className="h-[70vh] w-full rounded-md border border-border"
        />
      </div>
    );
  }

  // 图片缩略图 / 未知类型：用可缩放查看器展示
  return (
    <ImageViewer
      src={url}
      alt={resource.title || resource.originalFilename}
      referrerPolicy="no-referrer"
      onError={onError}
    />
  );
}

/**
 * 从详情页 URL 的查询串还原"相邻资源"接口所需的筛选/排序参数。
 * 直接用资源库列表页的同一套 URL ↔ 筛选状态规则（含根目录/全库作用域推导），
 * 保证左右箭头始终在列表当前展示的那个结果集里切换（关键词、类型、来源、
 * 作者、时间范围、文件大小、排序全部生效）。
 */
function neighborsParamsFromUrl(searchParams: URLSearchParams) {
  return buildFilterParams(filtersFromSearchParams(searchParams));
}

/** 返回资源库按钮 */
function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" className="gap-1" onClick={onClick}>
      <ArrowLeft className="h-4 w-4" />
      返回资源库
    </Button>
  );
}

export default function ResourceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  // 来自资源库列表的筛选/排序上下文（跟随 URL，切换相邻资源时保持）
  const contextQuery = searchParams.toString();

  // 相邻资源导航（上一个/下一个）
  const [previousId, setPreviousId] = useState<string | null>(null);
  const [nextId, setNextId] = useState<string | null>(null);
  const [neighborsPosition, setNeighborsPosition] = useState<{
    current: number;
    total: number;
  } | null>(null);

  const handleBack = useCallback(() => {
    if (window.history.length > 1) {
      router.back();
      return;
    }
    router.push('/resources');
  }, [router]);

  // 在筛选上下文中切换相邻资源：保留当前查询串，使箭头状态与列表持续性保持一致
  const neighborUrl = useCallback(
    (neighborId: string) => `/resources/${neighborId}${contextQuery ? `?${contextQuery}` : ''}`,
    [contextQuery],
  );

  const goToNeighbor = useCallback(
    (neighborId: string) => {
      router.push(neighborUrl(neighborId));
    },
    [router, neighborUrl],
  );

  const [resource, setResource] = useState<ResourceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [externalPreviewError, setExternalPreviewError] = useState(false);
  const [mirroring, setMirroring] = useState(false);
  const [mirrorJob, setMirrorJob] = useState<IngestionJobItem | null>(null);
  const [snapshotJob, setSnapshotJob] = useState<IngestionJobItem | null>(null);
  const [snapshotting, setSnapshotting] = useState(false);
  const hadMirrorJobRef = useRef(false);
  const hadSnapshotJobRef = useRef(false);

  // 编辑 Dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editSource, setEditSource] = useState('');
  const [editAuthor, setEditAuthor] = useState('');
  const [editCategoryId, setEditCategoryId] = useState('');

  // 分类
  const [categories, setCategories] = useState<CategoryTreeNode[]>([]);
  const flatCategories = useMemo(() => flattenCategories(categories), [categories]);

  /**
   * 拉取详情。
   * silent=true：保存/恢复/重新处理/任务结束后的补偿刷新。保留当前页面与预览节点，
   * 不切 loading，否则整页会被骨架替换、图片重新请求和解码（大图尤其明显）。
   */
  const resourceSeqRef = useRef(0);
  const fetchResource = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      const seq = ++resourceSeqRef.current;
      if (!silent) {
        setLoading(true);
        setError(null);
        setPreviewError(false);
        setExternalPreviewError(false);
      }
      try {
        const data = await getResource(id);
        if (seq !== resourceSeqRef.current) return;
        setResource(data);
        setError(null);
      } catch (e) {
        if (seq !== resourceSeqRef.current) return;
        // 静默刷新失败时保留当前内容，避免把已有页面替换成错误页
        if (!silent) setError(e instanceof Error ? e.message : '加载失败');
      } finally {
        if (seq === resourceSeqRef.current) setLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    fetchResource();
    listCategories()
      .then((d) => setCategories(d.items))
      .catch(() => {});
  }, [fetchResource]);

  // 拉取相邻资源（携带列表的筛选/排序上下文）。失败时静默隐藏箭头，不影响当前详情。
  // 以序列化后的查询串 contextQuery 为依赖（而非 searchParams 对象），避免每次渲染重复请求。
  useEffect(() => {
    let cancelled = false;
    setPreviousId(null);
    setNextId(null);
    setNeighborsPosition(null);
    getResourceNeighbors(id, neighborsParamsFromUrl(new URLSearchParams(contextQuery)))
      .then((result) => {
        if (cancelled) return;
        setPreviousId(result.previousId);
        setNextId(result.nextId);
        if (result.currentIndex !== null) {
          setNeighborsPosition({ current: result.currentIndex, total: result.total });
        }
      })
      .catch(() => {
        // 忽略：上下文不适用（如其他入口直达详情）时仅不显示箭头
      });
    return () => {
      cancelled = true;
    };
  }, [id, contextQuery]);

  const fetchRemoteJobs = useCallback(async () => {
    try {
      const [pending, processing, snapshotPending, snapshotRunning] = await Promise.all([
        listIngestionJobs({
          resourceId: id,
          jobType: IngestionJobType.download_file,
          status: IngestionJobStatus.pending,
          pageSize: 1,
        }),
        listIngestionJobs({
          resourceId: id,
          jobType: IngestionJobType.download_file,
          status: IngestionJobStatus.processing,
          pageSize: 1,
        }),
        listIngestionJobs({
          resourceId: id,
          jobType: IngestionJobType.capture_page,
          status: IngestionJobStatus.pending,
          pageSize: 1,
        }),
        listIngestionJobs({
          resourceId: id,
          jobType: IngestionJobType.capture_page,
          status: IngestionJobStatus.processing,
          pageSize: 1,
        }),
      ]);
      setMirrorJob(processing.items[0] ?? pending.items[0] ?? null);
      setSnapshotJob(snapshotRunning.items[0] ?? snapshotPending.items[0] ?? null);
    } catch {
      // Resource viewing remains available if background-job polling fails.
    }
  }, [id]);

  useEffect(() => {
    void fetchRemoteJobs();
  }, [fetchRemoteJobs]);

  useEffect(() => {
    if (!mirrorJob && !snapshotJob) return;
    const timer = window.setInterval(() => void fetchRemoteJobs(), 3000);
    return () => window.clearInterval(timer);
  }, [fetchRemoteJobs, mirrorJob, snapshotJob]);

  useEffect(() => {
    if (mirrorJob) {
      hadMirrorJobRef.current = true;
      return;
    }
    if (hadMirrorJobRef.current) {
      hadMirrorJobRef.current = false;
      void fetchResource({ silent: true });
    }
  }, [fetchResource, mirrorJob]);

  // 快照任务结束后重新拉取资源，文件列表才会出现快照
  useEffect(() => {
    if (snapshotJob) {
      hadSnapshotJobRef.current = true;
      return;
    }
    if (hadSnapshotJobRef.current) {
      hadSnapshotJobRef.current = false;
      void fetchResource({ silent: true });
    }
  }, [fetchResource, snapshotJob]);

  const openEdit = () => {
    if (!resource) return;
    setEditTitle(resource.title || '');
    setEditDescription(resource.description || '');
    setEditSource(resource.source || '');
    setEditAuthor(resource.author || '');
    setEditCategoryId(resource.categoryId || '');
    setEditOpen(true);
  };

  const handleSave = async () => {
    try {
      await updateResource(id, {
        title: editTitle || undefined,
        description: editDescription || null,
        source: editSource || null,
        author: editAuthor || null,
        categoryId: editCategoryId === NO_FOLDER_VALUE ? null : editCategoryId || undefined,
      });
      toast.success('已更新');
      setEditOpen(false);
      await fetchResource({ silent: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败');
    }
  };

  // 收藏/取消收藏：没有单条接口，复用批量接口只传当前 id，成功后就地更新，不重拉整页
  const favoritePendingRef = useRef(false);
  const handleToggleFavorite = async () => {
    if (!resource || favoritePendingRef.current) return;
    const next = !resource.isFavorite;
    favoritePendingRef.current = true;
    try {
      const result = await batchSetResourceFavorite([resource.id], next);
      // 批量接口对「资源已被删除/不存在」返回 200 + updated=0，不能当成功处理。
      if (result.updated < 1) {
        toast.error('收藏失败：资源可能已被删除');
        await fetchResource({ silent: true });
        return;
      }
      setResource((current) => (current ? { ...current, isFavorite: next } : current));
      toast.success(next ? '已收藏' : '已取消收藏');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '收藏操作失败');
    } finally {
      favoritePendingRef.current = false;
    }
  };

  /** 删除后的「撤销」：直接恢复，不打断当前浏览位置 */
  const handleUndoDelete = async () => {
    try {
      await restoreResource(id);
      toast.success('已恢复');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '撤销失败，请到回收站手动恢复');
    }
  };

  // 删除：不再二次确认，直接执行并给出可撤销的提示
  const deletingRef = useRef(false);
  const handleDelete = async () => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    try {
      await softDeleteResource(id);
      toast.success('已移到回收站', {
        action: { label: '撤销', onClick: () => void handleUndoDelete() },
      });
      // 删除后留在浏览流里，而不是弹回列表：优先跳下一个资源，没有下一个就跳上一个。
      // 都没有（筛选结果中仅此一条、或相邻资源接口尚未返回）才回列表，并带上当前筛选串 ——
      // 否则用户会被踢出所在分类，落到未筛选的全量列表。
      // 两条路径都用 replace：push 会把刚删掉的详情页留在历史里，后退会落回去。
      const adjacentId = nextId ?? previousId;
      if (adjacentId) {
        router.replace(neighborUrl(adjacentId));
        return;
      }
      router.replace(contextQuery ? `/resources?${contextQuery}` : '/resources');
    } catch (e) {
      // 失败时允许重试；成功时页面会离开，无需重置
      deletingRef.current = false;
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  const handleRestore = async () => {
    try {
      await restoreResource(id);
      toast.success('已恢复');
      await fetchResource({ silent: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '恢复失败');
    }
  };

  const handleReprocess = async () => {
    try {
      await reprocessResource(id);
      toast.success('已提交重新处理');
      // 重新处理可能产出新的缩略图/预览：清掉旧的失败态，让预览重新尝试
      setPreviewError(false);
      setExternalPreviewError(false);
      await fetchResource({ silent: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '重新处理失败');
    }
  };

  const handleCheckLocators = async () => {
    try {
      const result = await checkResourceLocators(id);
      toast.success(result.message);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '检查失败');
    }
  };

  const handleMirror = async () => {
    setMirroring(true);
    try {
      const job = await mirrorRemoteResource(id);
      setMirrorJob(job);
      toast.success('已提交本地下载任务');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '提交下载任务失败');
    } finally {
      setMirroring(false);
    }
  };

  const handleSnapshot = async () => {
    setSnapshotting(true);
    try {
      const job = await captureResourceSnapshot(id);
      setSnapshotJob(job);
      toast.success('已提交页面快照任务');
      void fetchRemoteJobs();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '提交快照任务失败');
    } finally {
      setSnapshotting(false);
    }
  };

  const handleCancelMirror = async () => {
    if (!mirrorJob) return;
    try {
      const job = await cancelIngestionJob(mirrorJob.id);
      setMirrorJob(job);
      toast.info('已停止本地下载任务');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '停止下载失败');
    }
  };

  const hasBrokenLinks = resource?.locators?.some(
    (l) => (l.httpStatus ?? 0) >= 400 || l.lastError !== null,
  );

  const primaryLocator = resource?.locators?.find((locator) => locator.isPrimary);
  const previewLocator = resource?.locators?.find((locator) => locator.locatorType === 'preview');
  const downloadLocator = resource?.locators?.find((locator) => locator.locatorType === 'download');
  const isExternalResource =
    !!resource?.acquisitionMode && resource.acquisitionMode !== 'local_upload';
  // 是否有本地原文件（下载镜像、本地上传）。有本地文件的资源优先展示本地预览/下载按钮。
  const hasLocalOriginalFile = (resource?.files ?? []).some((f) => f.fileRole === 'original');
  // 是否已生成缩略图（作为视频预览封面）
  const hasThumbnail = (resource?.files ?? []).some((f) => f.fileRole === 'thumbnail');
  const hasSnapshot = (resource?.files ?? []).some((f) => f.fileRole === 'snapshot');

  if (loading) {
    return (
      <div>
        <div className="mb-6">
          <BackButton onClick={handleBack} />
        </div>
        <LoadingState variant="card" count={3} />
      </div>
    );
  }

  if (error || !resource) {
    return (
      <div>
        <div className="mb-6">
          <BackButton onClick={handleBack} />
        </div>
        <ErrorState message={error ?? '未找到资源'} onRetry={() => void fetchResource()} />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <BackButton onClick={handleBack} />
          {/* 相邻资源导航：在相同的筛选/排序上下文中快速查看上一个/下一个资源。
              仅当资源属于某列表上下文时显示（neighborsPosition 非空），否则（直接深链等）隐藏。 */}
          {neighborsPosition && (
            <div className="flex items-center gap-1 rounded-md border px-1 py-1">
              <Button
                variant="ghost"
                size="sm"
                className="gap-1 px-2"
                disabled={!previousId}
                onClick={() => previousId && goToNeighbor(previousId)}
                title="上一个资源"
                aria-label="上一个资源"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="px-1 text-xs tabular-nums text-muted-foreground">
                {neighborsPosition.current} / {neighborsPosition.total}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1 px-2"
                disabled={!nextId}
                onClick={() => nextId && goToNeighbor(nextId)}
                title="下一个资源"
                aria-label="下一个资源"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {hasLocalOriginalFile ? (
            <Button variant="outline" size="sm" className="gap-1" asChild>
              <a href={getResourceDownloadUrl(id)} download>
                <Download className="h-4 w-4" />
                下载
              </a>
            </Button>
          ) : isExternalResource && primaryLocator ? (
            <>
              {resource.acquisitionMode === 'metadata_only' &&
                (mirrorJob ? (
                  <>
                    <Button variant="outline" size="sm" className="gap-1" disabled>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {mirrorJob.status === IngestionJobStatus.processing ? '下载中' : '等待中'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCancelMirror}
                      title="停止下载"
                      className="text-destructive hover:text-destructive"
                    >
                      <Square className="h-4 w-4" />
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    onClick={handleMirror}
                    disabled={mirroring}
                  >
                    <Download className="h-4 w-4" />
                    {mirroring ? '正在提交' : '下载到本地'}
                  </Button>
                ))}
              <Button variant="outline" size="sm" className="gap-1" asChild>
                <a href={primaryLocator.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  打开链接
                </a>
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" className="gap-1" asChild>
              <a href={getResourceDownloadUrl(id)} download>
                <Download className="h-4 w-4" />
                下载
              </a>
            </Button>
          )}
          {isExternalResource &&
            primaryLocator &&
            (snapshotJob ? (
              <Button variant="outline" size="sm" className="gap-1" disabled>
                <Loader2 className="h-4 w-4 animate-spin" />
                {snapshotJob.status === IngestionJobStatus.processing ? '快照中' : '等待中'}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="gap-1"
                onClick={handleSnapshot}
                disabled={snapshotting}
                title="抓取页面 HTML 存档，不含 JavaScript 渲染结果"
              >
                <Camera className="h-4 w-4" />
                {snapshotting ? '正在提交' : hasSnapshot ? '更新快照' : '生成快照'}
              </Button>
            ))}
          {isDesignMediaType(resource) && !resource.deletedAt && (
            <Button variant="outline" size="sm" className="gap-1" asChild>
              <Link href={designMediaHref(resource.id)}>
                <Wand2 className="h-4 w-4" />
                用于设计
              </Link>
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            title={resource.isFavorite ? '取消收藏' : '收藏这个资源'}
            onClick={() => void handleToggleFavorite()}
          >
            <Heart
              className={cn('h-4 w-4', resource.isFavorite && 'fill-rose-500 text-rose-500')}
            />
            {resource.isFavorite ? '已收藏' : '收藏'}
          </Button>
          <Button variant="outline" size="sm" className="gap-1" onClick={openEdit}>
            <Pencil className="h-4 w-4" />
            编辑
          </Button>
          {resource.deletedAt ? (
            <Button variant="outline" size="sm" className="gap-1" onClick={handleRestore}>
              <RotateCcw className="h-4 w-4" />
              恢复
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={() => void handleDelete()}
            >
              <Trash2 className="h-4 w-4 text-destructive" />
              删除
            </Button>
          )}
          {hasLocalOriginalFile && (
            <Button variant="outline" size="sm" className="gap-1" onClick={handleReprocess}>
              <RefreshCw className="h-4 w-4" />
              重新处理
            </Button>
          )}
        </div>
      </div>

      {/* 预览：整行铺满，图片/视频/PDF 才有足够的展示空间 */}
      <div className="mb-6">
        {/* 有本地文件优先显示本地预览，否则外部链接资源显示远端预览 */}
        {hasLocalOriginalFile || !isExternalResource ? (
          <Card>
            <CardContent className="p-3 pt-3">
              {!previewError ? (
                <InlinePreview
                  resource={resource}
                  previewUrl={getResourcePreviewUrl(
                    resource.id,
                    resource.resourceType === 'image' ? DETAIL_PREVIEW_MAX_EDGE : undefined,
                  )}
                  posterUrl={hasThumbnail ? getResourceThumbnailUrl(resource.id) : null}
                  onError={() => setPreviewError(true)}
                />
              ) : (
                <PreviewIconFallback type={resource.resourceType} />
              )}
            </CardContent>
          </Card>
        ) : isExternalResource && (previewLocator || primaryLocator) ? (
          <Card>
            <CardContent className="p-3 pt-3">
              {!externalPreviewError ? (
                <ExternalPreview
                  url={(previewLocator ?? primaryLocator)!.url}
                  resource={resource}
                  onError={() => setExternalPreviewError(true)}
                />
              ) : (
                <PreviewIconFallback type={resource.resourceType} />
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* 左侧：文件列表（占 3/5，与右侧元数据 2/5 搭配，信息列更舒展） */}
        <div className="lg:col-span-3 space-y-6">
          {/* 文件列表 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">文件列表</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {resource.files.map((f) => {
                  const RoleIcon = FILE_ROLE_ICONS[f.fileRole] ?? FileText;
                  return (
                    <div key={f.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
                      <RoleIcon className="h-5 w-5 text-muted-foreground" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">
                          {FILE_ROLE_LABELS[f.fileRole] ?? f.fileRole}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {f.mimeType} · {formatByteString(f.sizeBytes)}
                          {f.width && f.height ? ` · ${f.width}×${f.height}` : ''}
                        </p>
                      </div>
                      {f.fileRole !== 'original' && (
                        <Button variant="ghost" size="sm" className="gap-1 px-2" asChild>
                          <a href={getResourceFileDownloadUrl(id, f.fileRole)} download>
                            <Download className="h-3.5 w-3.5" />
                            <span className="text-xs">取回</span>
                          </a>
                        </Button>
                      )}
                    </div>
                  );
                })}
                {resource.files.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-4">暂无文件</p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 右侧：元数据 */}
        <div className="lg:col-span-2 space-y-6">
          {/* 基本信息 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">基本信息</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between gap-3">
                <span className="shrink-0 text-muted-foreground">标题</span>
                <span className="text-right">{resource.title || resource.originalFilename}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">类型</span>
                <ResourceTypeBadge type={resource.resourceType} />
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">文件名</span>
                <span className="font-mono text-xs">{resource.originalFilename}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">MIME</span>
                <span className="font-mono text-xs">{resource.mimeType}</span>
              </div>
              {resource.acquisitionMode === 'link_only' ? (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">获取方式</span>
                  <span>链接</span>
                </div>
              ) : resource.acquisitionMode === 'metadata_only' ? (
                <>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">获取方式</span>
                    <span>远程元数据</span>
                  </div>
                  {downloadLocator?.lastError && (
                    <div className="flex justify-between gap-3">
                      <span className="shrink-0 text-muted-foreground">下载状态</span>
                      <span
                        className="text-right text-destructive"
                        title={downloadLocator.lastError}
                      >
                        下载失败
                        {downloadLocator.downloadAttempts
                          ? `（已尝试 ${downloadLocator.downloadAttempts} 次）`
                          : ''}
                      </span>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">大小</span>
                  <span>{formatByteString(resource.sizeBytes)}</span>
                </div>
              )}
              {resource.width && resource.height && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">尺寸</span>
                  <span>
                    {resource.width} × {resource.height}
                  </span>
                </div>
              )}
              {resource.durationSeconds && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">时长</span>
                  <span>{resource.durationSeconds} 秒</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">处理状态</span>
                <Badge
                  variant={
                    resource.processingStatus === 'failed'
                      ? 'destructive'
                      : resource.processingStatus === 'completed'
                        ? 'success'
                        : 'secondary'
                  }
                >
                  {PROCESSING_STATUS_LABELS[resource.processingStatus] ?? resource.processingStatus}
                </Badge>
              </div>
              {resource.description && (
                <>
                  <Separator />
                  <p className="text-muted-foreground">{resource.description}</p>
                </>
              )}
            </CardContent>
          </Card>

          {/* 元数据 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">其他信息</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {resource.sourceRecord && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">来源配置</span>
                  <span>{resource.sourceRecord.name}</span>
                </div>
              )}
              {resource.source && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">来源说明</span>
                  <span>{resource.source}</span>
                </div>
              )}
              {resource.author && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">作者</span>
                  <span>{resource.author}</span>
                </div>
              )}
              {primaryLocator && (
                <div className="flex justify-between gap-3">
                  <span className="shrink-0 text-muted-foreground">外部链接</span>
                  <a
                    href={primaryLocator.url}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate text-primary hover:underline"
                  >
                    {primaryLocator.url}
                  </a>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">SHA256</span>
                <span className="font-mono text-xs max-w-32 truncate">
                  {resource.sha256 ?? '-'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">创建时间</span>
                <span>{formatDateTime(resource.createdAt)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">更新时间</span>
                <span>{formatDateTime(resource.updatedAt)}</span>
              </div>
              {resource.isDuplicate && resource.duplicateOf && (
                <div className="rounded-md bg-warning/10 p-2 text-xs text-warning">
                  此文件可能与 "{resource.duplicateOf.title}" 重复
                </div>
              )}
            </CardContent>
          </Card>

          {/* 链接健康（仅外部资源显示） */}
          {isExternalResource && resource.locators && resource.locators.length > 0 && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">链接健康</CardTitle>
                <Button variant="outline" size="sm" className="gap-1" onClick={handleCheckLocators}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  重新检查
                </Button>
              </CardHeader>
              <CardContent className="space-y-2">
                {hasBrokenLinks && (
                  <div className="rounded-md bg-amber-50 border border-amber-200 p-2 text-xs text-amber-800">
                    ⚠ 此资源存在失效链接
                  </div>
                )}
                {resource.locators.map((locator) => (
                  <div
                    key={locator.id}
                    className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <Badge variant="outline" className="text-xs shrink-0">
                      {LOCATOR_TYPE_LABELS[locator.locatorType] ?? locator.locatorType}
                    </Badge>
                    {locator.httpStatus !== null ? (
                      <Badge
                        variant={
                          locator.httpStatus >= 200 && locator.httpStatus < 300
                            ? 'default'
                            : locator.httpStatus >= 300 && locator.httpStatus < 400
                              ? 'secondary'
                              : 'destructive'
                        }
                        className="text-xs shrink-0"
                      >
                        {locator.httpStatus}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs shrink-0 text-muted-foreground">
                        未检查
                      </Badge>
                    )}
                    <a
                      href={locator.url}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-primary hover:underline flex-1 min-w-0"
                    >
                      {locator.url}
                    </a>
                    {locator.lastError && (
                      <span className="text-xs text-destructive shrink-0">{locator.lastError}</span>
                    )}
                    {locator.lastCheckedAt && (
                      <span className="text-xs text-muted-foreground shrink-0">
                        {formatDateTime(locator.lastCheckedAt)}
                      </span>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* 来源追溯（仅外部资源显示） */}
          {isExternalResource && resource.provenance && resource.provenance.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">来源追溯</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {resource.provenance.map((p) => (
                  <div key={p.id} className="space-y-1.5 rounded-md border px-3 py-2">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">连接器</span>
                      <span>
                        {p.connectorType} v{p.connectorVersion}
                      </span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="shrink-0 text-muted-foreground">原始 URL</span>
                      <a
                        href={p.originalUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate text-primary hover:underline"
                      >
                        {p.originalUrl}
                      </a>
                    </div>
                    {p.publisher && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">发布者</span>
                        <span>{p.publisher}</span>
                      </div>
                    )}
                    {p.authorName && (
                      <div className="flex justify-between gap-3">
                        <span className="shrink-0 text-muted-foreground">作者</span>
                        {p.authorUrl ? (
                          <a
                            href={p.authorUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="truncate text-primary hover:underline"
                          >
                            {p.authorName}
                          </a>
                        ) : (
                          <span>{p.authorName}</span>
                        )}
                      </div>
                    )}
                    {p.attributionText && (
                      <div>
                        <span className="text-muted-foreground">署名要求：</span>
                        <p className="mt-1 text-xs">{p.attributionText}</p>
                      </div>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* 编辑 Dialog */}
      <Dialog
        open={editOpen}
        onOpenChange={(open) => {
          setEditOpen(open);
          if (!open) {
            setEditTitle('');
            setEditDescription('');
            setEditSource('');
            setEditAuthor('');
            setEditCategoryId('');
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>编辑资源</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 max-h-96 overflow-y-auto">
            <div className="space-y-1">
              <Label>标题</Label>
              <Input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                maxLength={255}
              />
            </div>
            <div className="space-y-1">
              <Label>描述</Label>
              <Textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                maxLength={2000}
                rows={3}
              />
            </div>
            <div className="space-y-1">
              <Label>来源</Label>
              <Input
                value={editSource}
                onChange={(e) => setEditSource(e.target.value)}
                maxLength={255}
              />
            </div>
            <div className="space-y-1">
              <Label>作者</Label>
              <Input
                value={editAuthor}
                onChange={(e) => setEditAuthor(e.target.value)}
                maxLength={255}
              />
            </div>
            <div className="space-y-1">
              <Label>分类</Label>
              <Select
                value={editCategoryId || NO_FOLDER_VALUE}
                onValueChange={(value) => setEditCategoryId(value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="无分类" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_FOLDER_VALUE}>无分类</SelectItem>
                  {flatCategories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.parentId ? `- ${c.name}` : c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSave}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
