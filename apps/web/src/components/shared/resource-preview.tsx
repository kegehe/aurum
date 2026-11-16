'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { ResourceTypeIcon } from './resource-type-icon';
import { getResourcePreviewUrl, getResourceThumbnailUrl } from '@/lib/api/resources';
import { hasLocalThumbnail, isRemoteResource } from '@/lib/resource';
import type { ResourceListItem } from '@/lib/types';

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v', 'ogv'] as const;
const ANIMATED_IMAGE_EXTENSIONS = ['gif', 'apng'] as const;

/** 起播阈值：卡片进入视口外 200px 就开始加载/播放 */
const PLAY_ROOT_MARGIN = '200px 0px';
/** 卸载阈值：离开视口 600px 才卸载。两档阈值之间留出 400px 迟滞区，贴边慢滚不会来回抖动 */
const STOP_ROOT_MARGIN = '600px 0px';

/**
 * 缩略图重试退避：下载刚完成时缩略图可能还在队列里，首次请求必然 404。
 * 不重试会把失败状态粘在卡片上，缩略图后来生成了也要刷新页面才看得到。
 * 总计约 4 分钟：按改后吞吐（每张约 0.085s）覆盖几千张的单批，再大的批次才会落图标。
 */
const THUMB_RETRY_DELAYS_MS = [
  2_000, 5_000, 10_000, 20_000, 30_000, 60_000, 60_000, 60_000,
] as const;

/** 本地缩略图重试时带 cache-busting；远端预览可能是签名 URL，不能随意追加参数 */
function withThumbAttempt(
  url: string | null,
  localUrl: string | null,
  attempt: number,
): string | null {
  if (!url || attempt === 0 || url !== localUrl) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${attempt}`;
}

/**
 * 后缀判定：originalFilename 带点（clip.mp4），独立的 extension 字段可能不带点（mp4）。
 * 两个字段必须分开判——拼成一个字符串再匹配，结尾的 $ 锚点会被后面的字段顶掉。
 */
function hasExtension(
  filename: string | null | undefined,
  extension: string | null | undefined,
  extensions: readonly string[],
): boolean {
  return [filename, extension].some((value) => {
    if (!value) return false;
    const lowered = value.toLowerCase();
    return extensions.some((ext) => lowered === ext || lowered.endsWith('.' + ext));
  });
}

// WebCodecs 的 ImageDecoder 还没进 lib.dom，这里只声明用到的部分
interface DecoderFrame {
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly duration: number | null;
  close: () => void;
}

interface ImageDecoderInstance {
  readonly tracks: {
    ready: Promise<void>;
    selectedTrack: { frameCount: number } | null;
  };
  decode: (options: { frameIndex: number }) => Promise<{ image: DecoderFrame }>;
  close: () => void;
}

type ImageDecoderCtor = new (init: { data: ArrayBuffer; type: string }) => ImageDecoderInstance;

function getImageDecoder(): ImageDecoderCtor | null {
  const ctor = (globalThis as { ImageDecoder?: ImageDecoderCtor }).ImageDecoder;
  return typeof ctor === 'function' ? ctor : null;
}

/**
 * 用 ImageDecoder + canvas 自己驱动循环。
 *
 * 原生 <img> 的循环次数由 GIF 文件头里的 loop count 决定，只写了一次的 GIF 播完就停；
 * 这里按帧解码、画到 canvas 上再自己排下一帧，循环次数不受文件限制。
 * 浏览器不支持 ImageDecoder（Firefox）或跨域取不到字节时，保持 <img> 兜底。
 */
function useAnimatedCanvas(src: string, mimeType: string, active: boolean) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!active) return;
    const Ctor = getImageDecoder();
    const canvas = canvasRef.current;
    if (!Ctor || !canvas) return;

    let cancelled = false;
    let painted = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let decoder: ImageDecoderInstance | null = null;
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok) throw new Error(String(response.status));
        const data = await response.arrayBuffer();
        if (cancelled) return;

        decoder = new Ctor({ data, type: mimeType });
        await decoder.tracks.ready;
        const frameCount = decoder.tracks.selectedTrack?.frameCount ?? 0;
        const context = canvas.getContext('2d');
        if (cancelled || !frameCount || !context) return;

        const drawFrame = async (index: number) => {
          if (cancelled || !decoder) return;
          const { image } = await decoder.decode({ frameIndex: index });
          if (cancelled) {
            image.close();
            return;
          }
          if (!canvas.width || !canvas.height) {
            canvas.width = image.displayWidth;
            canvas.height = image.displayHeight;
          }
          context.drawImage(
            image as unknown as CanvasImageSource,
            0,
            0,
            canvas.width,
            canvas.height,
          );
          const delay = Math.max(16, (image.duration ?? 100_000) / 1000);
          image.close();
          if (!painted) {
            painted = true;
            setReady(true);
          }
          // 卸载时 decoder 会被 close，正在解码的帧可能 reject，这里兜住避免未处理异常
          timer = setTimeout(() => {
            void drawFrame((index + 1) % frameCount).catch(() => undefined);
          }, delay);
        };

        await drawFrame(0);
      } catch {
        // 取不到字节（CORS/格式不支持）就继续用 <img>，不动画也比空白好
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      decoder?.close();
    };
  }, [src, mimeType, active]);

  return { canvasRef, ready };
}

interface AnimatedImageProps {
  src: string;
  mimeType: string;
  active: boolean;
  referrerPolicy?: 'no-referrer';
  draggable?: boolean;
  onReady: () => void;
  onError: () => void;
}

/** 动图前景：能自己驱动循环就用 canvas，否则退回原生 <img>（循环次数受文件限制） */
function AnimatedImage({
  src,
  mimeType,
  active,
  referrerPolicy,
  draggable,
  onReady,
  onError,
}: AnimatedImageProps) {
  const { canvasRef, ready } = useAnimatedCanvas(src, mimeType, active);

  useEffect(() => {
    if (ready) onReady();
  }, [ready, onReady]);

  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        // 首帧画好才显示，和 <img> 的切换是同一次渲染，不加过渡，否则会先淡出成模糊底再淡入
        className={cn(
          'absolute inset-0 h-full w-full object-contain',
          ready ? 'opacity-100' : 'opacity-0',
        )}
      />
      {!ready && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy={referrerPolicy}
          draggable={draggable}
          className="relative h-full w-full object-contain"
          // 没有 ImageDecoder（Firefox）时靠这张 img 兜底，同样要结束加载占位
          onLoad={onReady}
          onError={onError}
        />
      )}
    </>
  );
}

export interface ResourcePreviewProps {
  resource: ResourceListItem;
  /** compact：表格行里的小缩略图，不加载原文件、不自动播放 */
  variant?: 'card' | 'compact';
  /** 批量编辑模式：缩略图禁用原生拖拽，避免和扫选手势打架 */
  selectMode?: boolean;
  className?: string;
}

export function ResourcePreview({
  resource,
  variant = 'card',
  selectMode = false,
  className,
}: ResourcePreviewProps) {
  /** 重试预算用完才置 true，之后永久显示类型图标 */
  const [thumbFailed, setThumbFailed] = useState(false);
  /** 正在等待下一次重试：期间收起坏图，先显示占位/图标 */
  const [thumbRetrying, setThumbRetrying] = useState(false);
  const [thumbAttempt, setThumbAttempt] = useState(0);
  const thumbRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [thumbLoaded, setThumbLoaded] = useState(false);
  const [originalFailed, setOriginalFailed] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [inView, setInView] = useState(false);

  const isRemote = isRemoteResource(resource);
  const hasLocal = hasLocalThumbnail(resource);
  const localThumbSrc = hasLocal ? getResourceThumbnailUrl(resource.id) : null;
  // 空串按缺失处理，避免 <img src=""> 反而去请求当前页面
  const remotePreview = resource.previewUrl || null;
  // 真实远端媒体地址（下载定位器）。视频卡片必须用它播放：previewUrl 可能是缩略图。
  const remoteMedia = resource.downloadUrl || remotePreview;
  const mimeType = resource.mimeType ?? '';

  useEffect(() => {
    return () => {
      if (thumbRetryTimerRef.current) clearTimeout(thumbRetryTimerRef.current);
    };
  }, []);

  // 列表静默刷新不会换 key：同一资源可能从远端预览变成本地缩略图、或重新处理完成。
  // 这些变化必须重置重试状态，否则上一次的终态失败会一直粘到卡片卸载为止。
  useEffect(() => {
    if (thumbRetryTimerRef.current) {
      clearTimeout(thumbRetryTimerRef.current);
      thumbRetryTimerRef.current = null;
    }
    setThumbFailed(false);
    setThumbRetrying(false);
    setThumbAttempt(0);
  }, [resource.id, localThumbSrc, remotePreview, remoteMedia, resource.processingStatus]);

  // 稳定引用：AnimatedImage 用它标记首帧就绪，闭包每次新建会让 effect 白跑一遍
  const handleFirstFrame = useCallback(() => setThumbLoaded(true), []);

  const handleThumbError = useCallback(() => {
    // 远端预览的失败与缩略图生成队列无关，不重试，避免反复打远端主机
    if (!localThumbSrc) {
      setThumbFailed(true);
      return;
    }
    const delay = THUMB_RETRY_DELAYS_MS[thumbAttempt];
    if (delay === undefined) {
      setThumbRetrying(false);
      setThumbFailed(true);
      return;
    }
    setThumbRetrying(true);
    thumbRetryTimerRef.current = setTimeout(() => {
      thumbRetryTimerRef.current = null;
      setThumbRetrying(false);
      setThumbAttempt((attempt) => attempt + 1);
    }, delay);
  }, [localThumbSrc, thumbAttempt]);

  // 脏数据防御：MIME 说是图片就不再当视频，两条判定互斥，避免同一张卡同时走两个分支
  const isImageMime = mimeType.startsWith('image/');
  const isVideo =
    !isImageMime &&
    (resource.resourceType === 'video' ||
      mimeType.startsWith('video/') ||
      hasExtension(resource.originalFilename, resource.extension, VIDEO_EXTENSIONS));
  const isAnimatedImage =
    !isVideo &&
    (mimeType === 'image/gif' ||
      mimeType === 'image/apng' ||
      hasExtension(resource.originalFilename, resource.extension, ANIMATED_IMAGE_EXTENSIONS));

  // 只有视频和动图需要观察视口：视频按视口挂载，动图按视口解码循环
  const needsInView = isVideo || isAnimatedImage;

  /**
   * 视口观察：进入 200px 就播，离开 600px 才停。
   * 单实例在两张阈值之间来回切换，贴边慢滚时不会反复挂载/卸载、重发媒体请求。
   * 用 callback ref 是因为批量编辑模式会把缩略图容器重建，observer 必须跟着换节点。
   */
  const mediaRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || !needsInView) return;
      if (typeof IntersectionObserver === 'undefined') {
        setInView(true);
        return;
      }

      let playing = false;
      let observer: IntersectionObserver | null = null;

      const attach = (margin: string) => {
        observer?.disconnect();
        observer = new IntersectionObserver(
          (entries) => {
            const visible = entries[entries.length - 1]?.isIntersecting ?? false;
            // 切到更宽的阈值后新 observer 会立刻回调一次，状态没变就别再切换
            if (visible === playing) return;
            playing = visible;
            setInView(visible);
            attach(visible ? STOP_ROOT_MARGIN : PLAY_ROOT_MARGIN);
          },
          { rootMargin: margin },
        );
        observer.observe(el);
      };

      attach(PLAY_ROOT_MARGIN);
      return () => observer?.disconnect();
    },
    [needsInView],
  );

  const animatedSrc =
    isAnimatedImage && !originalFailed
      ? hasLocal
        ? getResourcePreviewUrl(resource.id)
        : remoteMedia
      : null;

  // 远端缩略图：来源单独提供的缩略图对视频/音频等任意类型都适用；
  // 图片/动图没有独立缩略图时，媒体本身就可以当预览。
  const remoteThumb =
    remotePreview ??
    (resource.resourceType === 'image' || isImageMime || isAnimatedImage ? remoteMedia : null);

  // 缩略图地址：动图取原文件，其余本地缩略图优先，其次才是远端缩略图。
  // 本地缩略图仍只给视觉类资源（图片/视频/动图）；来源单独提供的远端缩略图
  // 对音频等类型也可作为封面展示。
  const canShowThumb =
    isVideo ||
    resource.resourceType === 'image' ||
    isImageMime ||
    isAnimatedImage ||
    remotePreview !== null;
  const thumbSrc: string | null = withThumbAttempt(
    animatedSrc ?? (canShowThumb ? (localThumbSrc ?? remoteThumb) : null),
    localThumbSrc,
    thumbAttempt,
  );
  const showThumb = !thumbFailed && thumbSrc !== null;
  // 退避等待期间不渲染已失败的 <img>，避免浏览器把坏图图标画在卡片上
  const showThumbImage = showThumb && !thumbRetrying;
  // 背景虚化层：动图用静态缩略图，避免同一张 GIF 被解码两遍；破图或没有静态图就不铺背景。
  // 退避等待期间也收起，避免同一张失败图在背景层留下一个破图节点。
  const blurSrc = thumbFailed || thumbRetrying ? null : animatedSrc ? localThumbSrc : thumbSrc;

  // 视频源：本地视频走 /preview（支持 Range 分段加载）；远端资源没有本地文件，
  // 只有 MIME 明确是 video/* 时才敢直连——仅凭扩展名没法确认那个 URL 真是视频。
  const videoSrc =
    isVideo && !videoError
      ? hasLocal
        ? getResourcePreviewUrl(resource.id)
        : remoteMedia && mimeType.startsWith('video/')
          ? remoteMedia
          : null
      : null;
  const isPlaying = videoSrc !== null && inView;

  if (variant === 'compact') {
    // 表格行：只给静态缩略图，一页 100 行不能每行都去解码视频/动图
    const compactSrc = withThumbAttempt(
      localThumbSrc ?? remotePreview ?? (isImageMime || isAnimatedImage ? remoteMedia : null),
      localThumbSrc,
      thumbAttempt,
    );
    return (
      <div
        className={cn(
          'relative flex shrink-0 items-center justify-center overflow-hidden rounded border bg-muted',
          className,
        )}
      >
        {compactSrc && showThumbImage ? (
          <img
            src={compactSrc}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy={isRemote ? 'no-referrer' : undefined}
            className="h-full w-full object-cover"
            onError={handleThumbError}
          />
        ) : (
          <ResourceTypeIcon
            type={resource.resourceType}
            className="h-4 w-4 text-muted-foreground"
          />
        )}
      </div>
    );
  }

  return (
    <div
      ref={mediaRef}
      className={cn(
        'relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-muted',
        className,
      )}
    >
      {/* 加载占位：轻微呼吸的底色，避免弱网下缩略图区域一片空白。
          视频接管缩略图后前景不再触发 onLoad，没有这个判断占位动画会一直跑下去 */}
      {showThumb && thumbSrc && !thumbLoaded && !isPlaying && (
        <div className="pointer-events-none absolute inset-0 animate-pulse bg-muted-foreground/10" />
      )}
      {/* 背景虚化层：同一张图先 cover 铺满并按比例裁切，再做模糊/压暗当作背景，
          这样竖图两侧不再是大片空白，同时前景仍完整显示整张图片 */}
      {blurSrc && (
        <img
          src={blurSrc}
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
          referrerPolicy={isRemote ? 'no-referrer' : undefined}
          draggable={false}
          className={cn(
            'pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover blur-lg transition-opacity duration-300',
            // 视频接管后前景不再触发 onLoad，按 isPlaying 直接铺上，避免留黑边、也避免每次进视口视觉跳一下
            thumbLoaded || isPlaying ? 'opacity-50' : 'opacity-0',
          )}
        />
      )}
      {isPlaying ? (
        // 自动播放：静音 + 循环，以缩略图作为 poster，避免首帧到达前黑屏闪一下；
        // 缩略图 404 时不再把坏 URL 当 poster，否则进视口那一刻是黑底
        <video
          ref={handleVideoRef}
          src={videoSrc ?? undefined}
          poster={showThumb ? (thumbSrc ?? undefined) : undefined}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          draggable={false}
          aria-hidden="true"
          className="relative h-full w-full object-contain"
          onError={() => setVideoError(true)}
        />
      ) : animatedSrc && !thumbFailed ? (
        <AnimatedImage
          src={animatedSrc}
          mimeType={mimeType}
          active={inView}
          referrerPolicy={isRemote ? 'no-referrer' : undefined}
          draggable={selectMode ? false : undefined}
          onReady={handleFirstFrame}
          // 有静态缩略图（本地或来源单独提供的远端缩略图）就退回它；
          // 没有（远端动图本身就是唯一可展示的图）就直接标记缩略图失败，别在同一张破图上打转
          onError={() =>
            localThumbSrc || (remoteThumb && remoteThumb !== animatedSrc)
              ? setOriginalFailed(true)
              : setThumbFailed(true)
          }
        />
      ) : showThumbImage && thumbSrc ? (
        <img
          src={thumbSrc}
          alt={resource.title || resource.originalFilename}
          loading="lazy"
          decoding="async"
          referrerPolicy={isRemote ? 'no-referrer' : undefined}
          draggable={selectMode ? false : undefined}
          className={cn(
            'relative h-full w-full object-contain transition-opacity duration-300',
            thumbLoaded ? 'opacity-100' : 'opacity-0',
          )}
          onLoad={() => setThumbLoaded(true)}
          onError={handleThumbError}
        />
      ) : (
        <ResourceTypeIcon
          type={resource.resourceType}
          className="h-12 w-12 text-muted-foreground"
        />
      )}
    </div>
  );
}

/** 视频挂载时：补写 muted（React 的属性设置在部分浏览器下不生效）并主动起播 */
function handleVideoRef(el: HTMLVideoElement | null) {
  if (!el) return;
  el.muted = true;
  try {
    // play() 在部分环境不返回 Promise 或直接抛错，统一兜一层
    void Promise.resolve(el.play()).catch(() => undefined);
  } catch {
    // 浏览器不支持该视频格式时保持 poster 展示，交给 onError 兜底
  }
}
