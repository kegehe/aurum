'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
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
  Image,
  Video,
  Loader2,
  Square,
} from 'lucide-react';
import { LoadingState } from '@/components/shared/loading-state';
import { ErrorState } from '@/components/shared/error-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
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
  softDeleteResource,
  restoreResource,
  reprocessResource,
  getResourceDownloadUrl,
  getResourcePreviewUrl,
  getResourceThumbnailUrl,
  checkResourceLocators,
  mirrorRemoteResource,
} from '@/lib/api/resources';
import {
  cancelIngestionJob,
  listIngestionJobs,
} from '@/lib/api/ingestion';
import { listCategories } from '@/lib/api/categories';
import { formatByteString, formatDateTime } from '@/lib/format';
import { PROCESSING_STATUS_LABELS, LOCATOR_TYPE_LABELS } from '@/lib/constants';
import type { ResourceDetail, CategoryTreeNode, IngestionJobItem } from '@/lib/types';
import { IngestionJobStatus, IngestionJobType, type ResourceType } from '@aurum/shared-types';

const NO_FOLDER_VALUE = '__no_folder__';

function flattenCategories(categories: CategoryTreeNode[]): CategoryTreeNode[] {
  return categories.flatMap((category) => [category, ...flattenCategories(category.children)]);
}

const FILE_ROLE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  original: FileText,
  thumbnail: Image,
  preview: Image,
  extracted_text: FileText,
  transcode: Video,
};

const FILE_ROLE_LABELS: Record<string, string> = {
  original: '原文件',
  thumbnail: '缩略图',
  preview: '预览',
  extracted_text: '提取文本',
  transcode: '转码',
};

const TEXT_PREVIEW_MAX_CHARS = 200_000;

/** 预览失败 / 无可用预览时的类型图标占位 */
function PreviewIconFallback({ type }: { type: ResourceType }) {
  return (
    <div className="flex items-center justify-center py-16">
      <ResourceTypeIcon type={type} className="h-24 w-24 text-muted-foreground" />
    </div>
  );
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
          文件过大，仅显示前 {TEXT_PREVIEW_MAX_CHARS.toLocaleString()} 个字符。请使用「下载」查看完整内容。
        </p>
      )}
    </div>
  );
}

/**
 * 内联预览查看器：按资源类型渲染对应元素
 * - 图片 → <img>
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
          controls
          preload="metadata"
          src={previewUrl}
          poster={posterUrl ?? undefined}
          className="max-h-[480px] max-w-full rounded-md bg-black/5"
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
      <div className="flex items-center justify-center py-16">
        <img
          src={previewUrl}
          alt={resource.title || resource.originalFilename}
          className="max-h-[480px] max-w-full rounded object-contain"
          onError={onError}
        />
      </div>
    );
  }

  return <PreviewIconFallback type={type} />;
}

/**
 * 外部资源预览：根据预览定位器的实际 Content-Type 决定查看器
 * 图片/未知类型保持原有 <img> 行为（多为缩略图），video/audio/pdf 用对应播放器
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
          controls
          preload="metadata"
          src={url}
          className="max-h-[480px] max-w-full rounded-md bg-black/5"
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

  // 图片缩略图 / 未知类型：保持原有 <img> 行为
  return (
    <div className="flex items-center justify-center py-16">
      <img
        src={url}
        alt={resource.title || resource.originalFilename}
        referrerPolicy="no-referrer"
        className="max-h-[480px] max-w-full rounded object-contain"
        onError={onError}
      />
    </div>
  );
}

/**
 * 从详情页 URL 的查询串还原"相邻资源"接口所需的筛选/排序参数。
 * 与资源库列表页的 URL↔筛选状态映射保持一致：
 * - 有关键字/类型/categoryId/acquisitionMode 时原样传递；
 * - 无 categoryId 且 scope !== 'all'（即根目录默认视图）→ uncategorized=true；
 * - 排序参数缺省时保持默认（createdAt desc）。
 */
function neighborsParamsFromUrl(searchParams: URLSearchParams): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const keyword = searchParams.get('keyword');
  if (keyword) params.keyword = keyword;
  const resourceType = searchParams.get('resourceType');
  if (resourceType) params.resourceType = resourceType;
  const categoryId = searchParams.get('categoryId');
  const scope = searchParams.get('scope');
  if (categoryId) {
    params.categoryId = categoryId;
  } else if (scope !== 'all') {
    // 无分类且非"全部资源"：即根目录视图，与列表页对空 URL 的默认一致
    params.uncategorized = true;
  }
  const acquisitionMode = searchParams.get('acquisitionMode');
  if (acquisitionMode) params.acquisitionMode = acquisitionMode;
  const sortBy = searchParams.get('sortBy');
  const sortOrder = searchParams.get('sortOrder');
  if (sortBy) params.sortBy = sortBy;
  if (sortOrder) params.sortOrder = sortOrder;
  return params;
}

/** 返回资源库按钮 */
function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" className="gap-1" onClick={onClick}>
      <ArrowLeft className="h-4 w-4" />返回资源库
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
  const [neighborsPosition, setNeighborsPosition] = useState<{ current: number; total: number } | null>(null);

  const handleBack = useCallback(() => {
    if (window.history.length > 1) {
      router.back();
      return;
    }
    router.push('/resources');
  }, [router]);

  // 在筛选上下文中切换相邻资源：保留当前查询串，使箭头状态与列表持续性保持一致
  const goToNeighbor = useCallback(
    (neighborId: string) => {
      router.push(`/resources/${neighborId}${contextQuery ? `?${contextQuery}` : ''}`);
    },
    [router, contextQuery],
  );

  const [resource, setResource] = useState<ResourceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [externalPreviewError, setExternalPreviewError] = useState(false);
  const [mirroring, setMirroring] = useState(false);
  const [mirrorJob, setMirrorJob] = useState<IngestionJobItem | null>(null);
  const hadMirrorJobRef = useRef(false);

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

  // 确认
  const [deleteOpen, setDeleteOpen] = useState(false);

  const fetchResource = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPreviewError(false);
    setExternalPreviewError(false);
    try {
      const data = await getResource(id);
      setResource(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchResource();
    listCategories().then((d) => setCategories(d.items)).catch(() => {});
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

  const fetchMirrorJob = useCallback(async () => {
    try {
      const [pending, processing] = await Promise.all([
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
      ]);
      setMirrorJob(processing.items[0] ?? pending.items[0] ?? null);
    } catch {
      // Resource viewing remains available if background-job polling fails.
    }
  }, [id]);

  useEffect(() => {
    void fetchMirrorJob();
  }, [fetchMirrorJob]);

  useEffect(() => {
    if (!mirrorJob) return;
    const timer = window.setInterval(() => void fetchMirrorJob(), 3000);
    return () => window.clearInterval(timer);
  }, [fetchMirrorJob, mirrorJob]);

  useEffect(() => {
    if (mirrorJob) {
      hadMirrorJobRef.current = true;
      return;
    }
    if (hadMirrorJobRef.current) {
      hadMirrorJobRef.current = false;
      void fetchResource();
    }
  }, [fetchResource, mirrorJob]);

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
      await fetchResource();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败');
    }
  };

  const handleDelete = async () => {
    try {
      await softDeleteResource(id);
      toast.success('已移到回收站');
      router.push('/resources');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  const handleRestore = async () => {
    try {
      await restoreResource(id);
      toast.success('已恢复');
      await fetchResource();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '恢复失败');
    }
  };

  const handleReprocess = async () => {
    try {
      await reprocessResource(id);
      toast.success('已提交重新处理');
      await fetchResource();
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
  const isExternalResource = !!resource?.acquisitionMode && resource.acquisitionMode !== 'local_upload';
  // 是否有本地原文件（下载镜像、本地上传）。有本地文件的资源优先展示本地预览/下载按钮。
  const hasLocalOriginalFile = (resource?.files ?? []).some((f) => f.fileRole === 'original');
  // 是否已生成缩略图（作为视频预览封面）
  const hasThumbnail = (resource?.files ?? []).some((f) => f.fileRole === 'thumbnail');

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
        <ErrorState message={error ?? '未找到资源'} onRetry={fetchResource} />
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
                <Download className="h-4 w-4" />下载
              </a>
            </Button>
          ) : isExternalResource && primaryLocator ? (
            <>
              {resource.acquisitionMode === 'metadata_only' && (
                mirrorJob ? (
                  <>
                    <Button variant="outline" size="sm" className="gap-1" disabled>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {mirrorJob.status === IngestionJobStatus.processing ? '下载中' : '等待中'}
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleCancelMirror} title="停止下载" className="text-destructive hover:text-destructive">
                      <Square className="h-4 w-4" />
                    </Button>
                  </>
                ) : (
                  <Button variant="outline" size="sm" className="gap-1" onClick={handleMirror} disabled={mirroring}>
                    <Download className="h-4 w-4" />{mirroring ? '正在提交' : '下载到本地'}
                  </Button>
                )
              )}
              <Button variant="outline" size="sm" className="gap-1" asChild>
                <a href={primaryLocator.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />打开链接
                </a>
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" className="gap-1" asChild>
              <a href={getResourceDownloadUrl(id)} download>
                <Download className="h-4 w-4" />下载
              </a>
            </Button>
          )}
          <Button variant="outline" size="sm" className="gap-1" onClick={openEdit}>
            <Pencil className="h-4 w-4" />编辑
          </Button>
          {resource.deletedAt ? (
            <Button variant="outline" size="sm" className="gap-1" onClick={handleRestore}>
              <RotateCcw className="h-4 w-4" />恢复
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="gap-1" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="h-4 w-4 text-destructive" />删除
            </Button>
          )}
          {hasLocalOriginalFile && (
            <Button variant="outline" size="sm" className="gap-1" onClick={handleReprocess}>
              <RefreshCw className="h-4 w-4" />重新处理
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 左侧：预览 + 信息 */}
        <div className="lg:col-span-2 space-y-6">
          {/* 预览：有本地文件优先显示本地预览，否则外部链接资源显示远端预览 */}
          {hasLocalOriginalFile || !isExternalResource ? (
            <Card>
              <CardContent>
                {!previewError ? (
                  <InlinePreview
                    resource={resource}
                    previewUrl={getResourcePreviewUrl(resource.id)}
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
              <CardContent>
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
                        <p className="text-sm font-medium">{FILE_ROLE_LABELS[f.fileRole] ?? f.fileRole}</p>
                        <p className="text-xs text-muted-foreground">
                          {f.mimeType} · {formatByteString(f.sizeBytes)}
                          {f.width && f.height ? ` · ${f.width}×${f.height}` : ''}
                        </p>
                      </div>
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
        <div className="space-y-6">
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
                <div className="flex justify-between">
                  <span className="text-muted-foreground">获取方式</span>
                  <span>远程元数据</span>
                </div>
              ) : (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">大小</span>
                  <span>{formatByteString(resource.sizeBytes)}</span>
                </div>
              )}
              {resource.width && resource.height && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">尺寸</span>
                  <span>{resource.width} × {resource.height}</span>
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
                <Badge variant={resource.processingStatus === 'failed' ? 'destructive' : resource.processingStatus === 'completed' ? 'success' : 'secondary'}>
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
                  <a href={primaryLocator.url} target="_blank" rel="noreferrer" className="truncate text-primary hover:underline">
                    {primaryLocator.url}
                  </a>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">SHA256</span>
                <span className="font-mono text-xs max-w-32 truncate">{resource.sha256 ?? '-'}</span>
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
                  <RefreshCw className="h-3.5 w-3.5" />重新检查
                </Button>
              </CardHeader>
              <CardContent className="space-y-2">
                {hasBrokenLinks && (
                  <div className="rounded-md bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 p-2 text-xs text-amber-800 dark:text-amber-200">
                    ⚠ 此资源存在失效链接
                  </div>
                )}
                {resource.locators.map((locator) => (
                  <div key={locator.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
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
                      <Badge variant="outline" className="text-xs shrink-0 text-muted-foreground">未检查</Badge>
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
                      <span>{p.connectorType} v{p.connectorVersion}</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="shrink-0 text-muted-foreground">原始 URL</span>
                      <a href={p.originalUrl} target="_blank" rel="noreferrer" className="truncate text-primary hover:underline">
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
                          <a href={p.authorUrl} target="_blank" rel="noreferrer" className="truncate text-primary hover:underline">{p.authorName}</a>
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
      <Dialog open={editOpen} onOpenChange={(open) => {
        setEditOpen(open);
        if (!open) {
          setEditTitle('');
          setEditDescription('');
          setEditSource('');
          setEditAuthor('');
          setEditCategoryId('');
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>编辑资源</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 max-h-96 overflow-y-auto">
            <div className="space-y-1">
              <Label>标题</Label>
              <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} maxLength={255} />
            </div>
            <div className="space-y-1">
              <Label>描述</Label>
              <Textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} maxLength={2000} rows={3} />
            </div>
            <div className="space-y-1">
              <Label>来源</Label>
              <Input value={editSource} onChange={(e) => setEditSource(e.target.value)} maxLength={255} />
            </div>
            <div className="space-y-1">
              <Label>作者</Label>
              <Input value={editAuthor} onChange={(e) => setEditAuthor(e.target.value)} maxLength={255} />
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
            <Button variant="outline" onClick={() => setEditOpen(false)}>取消</Button>
            <Button onClick={handleSave}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="删除资源"
        description="确定要将此资源移到回收站吗？你可以从回收站恢复。"
        variant="destructive"
        confirmLabel="删除"
        onConfirm={handleDelete}
      />
    </div>
  );
}
