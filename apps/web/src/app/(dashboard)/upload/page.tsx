'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Upload, X, FileText, CheckCircle2, AlertCircle, Loader2, FolderPlus } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { uploadFile, uploadBatch } from '@/lib/api/upload';
import { createCategory, listCategories } from '@/lib/api/categories';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { CategoryTreeNode, UploadResult } from '@/lib/types';

interface QueueItem {
  /** 稳定标识：上传过程中用户可能删除队列行，按下标回写会错位到别的文件 */
  id: string;
  file: File;
  status: 'pending' | 'uploading' | 'success' | 'error';
  /** 该文件已发送字节占比 0-1 */
  progress?: number;
  result?: UploadResult['resource'];
  error?: string;
}

/** 整轮上传的汇总进度 */
interface RoundProgress {
  loaded: number;
  total: number;
  /** 字节/秒，0 表示尚未测出速度 */
  speed: number;
}

const NO_FOLDER_VALUE = '__no_folder__';
const ROOT_FOLDER_VALUE = '__root_folder__';

/** 后端单次批量上传最多允许的文件数（超出部分自动分批） */
const BATCH_UPLOAD_LIMIT = 20;

/** 进度事件高频触发（大文件每秒数十次），限流到约 10 次/秒 */
const PROGRESS_THROTTLE_MS = 100;

/** 队列行的稳定 id：上传期间按下标回写会因删除行而错位，一律按 id 定位 */
let queueIdSeq = 0;
function nextQueueId(): string {
  queueIdSeq += 1;
  return `upload-${queueIdSeq}-${Date.now().toString(36)}`;
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError';
}

/** 剩余秒数 → 中文可读文案 */
function formatRemaining(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  // 先取整再拆分：否则 119.6s 会被拆成“1 分 60 秒”
  const total = Math.ceil(seconds);
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const restSeconds = total % 60;
  if (minutes < 60) {
    return restSeconds > 0 ? `${minutes} 分 ${restSeconds} 秒` : `${minutes} 分`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
}

function flattenCategories(categories: CategoryTreeNode[]): CategoryTreeNode[] {
  return categories.flatMap((category) => [category, ...flattenCategories(category.children)]);
}

export default function UploadPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  // 防重入：防止“开始上传”被快速重复点击导致同一批文件并发上传两次
  const uploadingRef = useRef(false);

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragover, setDragover] = useState(false);
  const [round, setRound] = useState<RoundProgress | null>(null);
  // 取消上传用：abort 后 XHR 立刻中断，不必等整批传完
  const abortRef = useRef<AbortController | null>(null);
  // 测速采样点（时间 / 已发送字节 / 平滑后的速度）
  const speedSampleRef = useRef({ time: 0, loaded: 0, speed: 0 });

  // 元数据
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [source, setSource] = useState('');
  const [author, setAuthor] = useState('');
  const [categories, setCategories] = useState<CategoryTreeNode[]>([]);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [folderParentId, setFolderParentId] = useState<string | null>(null);
  const flatCategories = useMemo(() => flattenCategories(categories), [categories]);

  // 加载分类列表
  const loadCategories = useCallback(async () => {
    try {
      const data = await listCategories();
      setCategories(data.items);
      return data.items;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    void loadCategories();
  }, [loadCategories]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initialCategoryId = params.get('categoryId');
    if (initialCategoryId) {
      setCategoryId(initialCategoryId);
    }
  }, []);

  // 离开页面时中止进行中的上传：大文件传一半切走，请求会一直挂在后台
  useEffect(() => () => abortRef.current?.abort(), []);

  const addFiles = (files: FileList | File[]) => {
    const newItems: QueueItem[] = Array.from(files).map((file) => ({
      id: nextQueueId(),
      file,
      status: 'pending' as const,
    }));
    setQueue((prev) => [...prev, ...newItems]);
  };

  const removeFile = (id: string) => {
    setQueue((prev) => prev.filter((item) => item.id !== id));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragover(false);
    if (uploading) return;
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      if (!uploading) addFiles(e.target.files);
      e.target.value = '';
    }
  };

  /** 用时间窗口内的瞬时速度做指数平滑：网络卡住时速度能快速掉下来，不会被历史平均掩盖 */
  const sampleSpeed = (loaded: number) => {
    const now = performance.now();
    const prev = speedSampleRef.current;
    if (prev.time === 0) {
      speedSampleRef.current = { time: now, loaded, speed: 0 };
      return 0;
    }
    const elapsed = (now - prev.time) / 1000;
    if (elapsed < 0.3) return prev.speed;
    const instant = Math.max(0, (loaded - prev.loaded) / elapsed);
    const speed = prev.speed > 0 ? prev.speed * 0.6 + instant * 0.4 : instant;
    speedSampleRef.current = { time: now, loaded, speed };
    return speed;
  };

  /** 取消本轮上传：中断进行中的请求，未传完的文件退回待上传 */
  const cancelUpload = () => {
    abortRef.current?.abort();
  };

  const startUpload = async () => {
    if (uploadingRef.current) return;

    // 只处理待上传（pending）与失败（error）的文件；已成功的跳过，避免重复上传
    const targets = queue.filter(
      (item) => item.status === 'pending' || item.status === 'error',
    );
    if (targets.length === 0) return;

    uploadingRef.current = true;
    // 用队列行的稳定 id 而不是下标：上传期间用户仍可移除其它行，下标会整体前移
    const targetIds = targets.map((item) => item.id);
    const targetIdSet = new Set(targetIds);
    const totalBytes = targets.reduce((sum, item) => sum + item.file.size, 0);
    const controller = new AbortController();
    abortRef.current = controller;
    // 已完成批次的字节数：批次内进度要加上它才是整轮进度
    let completedBytes = 0;
    // 当前请求里的文件及其在 multipart body 中的字节偏移，
    // 这样批量上传时每行显示各自的百分比，而不是整批同一个数
    let activeFiles: Array<{ id: string; offset: number; size: number }> = [];
    let lastEmit = 0;

    /** 当前请求内进度 → 整轮进度 + 每一行的百分比 */
    const reportProgress = (batchLoaded: number, batchTotal: number) => {
      const loaded = Math.min(completedBytes + batchLoaded, totalBytes);
      const speed = sampleSpeed(loaded);
      const now = performance.now();
      // 限流：只在传完或超过间隔时更新，避免大文件上传时每秒重渲染几十次
      if (now - lastEmit < PROGRESS_THROTTLE_MS && batchLoaded < batchTotal) return;
      lastEmit = now;

      setRound({ loaded, total: totalBytes, speed });
      setQueue((prev) =>
        prev.map((item) => {
          const entry = activeFiles.find((f) => f.id === item.id);
          if (!entry) return item;
          // 浏览器按 FormData 顺序连续发送，用偏移量切出当前文件已传的部分
          const sent = Math.min(Math.max(batchLoaded - entry.offset, 0), entry.size);
          return { ...item, progress: entry.size > 0 ? sent / entry.size : 1 };
        }),
      );
    };

    try {
      setUploading(true);
      setRound({ loaded: 0, total: totalBytes, speed: 0 });
      speedSampleRef.current = { time: 0, loaded: 0, speed: 0 };

      // 加载分类（如果还没加载）
      if (categories.length === 0) await loadCategories();

      const metadata: Record<string, string> = {};
      if (title) metadata.title = title;
      if (description) metadata.description = description;
      if (categoryId) metadata.categoryId = categoryId;
      if (source) metadata.source = source;
      if (author) metadata.author = author;
      const meta = Object.keys(metadata).length > 0 ? metadata : undefined;

      if (targets.length === 1) {
        // 单文件上传
        const id = targetIds[0];
        const file = targets[0].file;
        activeFiles = [{ id, offset: 0, size: file.size }];
        setQueue((prev) =>
          prev.map((item) =>
            item.id === id ? { ...item, status: 'uploading' as const, progress: 0 } : item,
          ),
        );
        try {
          const result = await uploadFile(file, meta, {
            signal: controller.signal,
            onProgress: (p) => reportProgress(p.loaded, p.total || file.size),
          });
          setQueue((prev) =>
            prev.map((item) =>
              item.id === id
                ? { ...item, status: 'success' as const, progress: 1, result: result.resource }
                : item,
            ),
          );
          toast.success('上传成功');
        } catch (e) {
          if (isAbortError(e)) {
            setQueue((prev) =>
              prev.map((item) =>
                item.id === id
                  ? { ...item, status: 'pending' as const, progress: undefined }
                  : item,
              ),
            );
            toast.info('已取消上传');
          } else {
            const msg = e instanceof Error ? e.message : '上传失败';
            setQueue((prev) =>
              prev.map((item) =>
                item.id === id
                  ? { ...item, status: 'error' as const, progress: undefined, error: msg }
                  : item,
              ),
            );
          }
        }
      } else {
        // 批量上传：每批最多 BATCH_UPLOAD_LIMIT 个文件，超出部分自动拆分成多批依次上传
        const files = targets.map((item) => item.file);
        // 仅将本轮参与上传的文件标记为 uploading，已成功的保持原状
        setQueue((prev) =>
          prev.map((item) =>
            targetIdSet.has(item.id)
              ? { ...item, status: 'uploading' as const, progress: 0 }
              : item,
          ),
        );

        let successCount = 0;
        let failCount = 0;
        let canceled = false;
        const resultsById = new Map<
          string,
          | { status: 'success'; result: UploadResult['resource'] }
          | { status: 'error'; error: string }
        >();

        /**
         * 把已知结果写回队列。
         * resetUnfinished 为真时把仍在“上传中”的行退回待上传——取消时这些文件只是没传完，不算失败。
         */
        const applyResults = (resetUnfinished: boolean) => {
          setQueue((prev) =>
            prev.map((item) => {
              const r = resultsById.get(item.id);
              if (r) {
                return r.status === 'success'
                  ? { ...item, status: 'success' as const, progress: 1, result: r.result }
                  : { ...item, status: 'error' as const, progress: undefined, error: r.error };
              }
              if (resetUnfinished && item.status === 'uploading') {
                return { ...item, status: 'pending' as const, progress: undefined };
              }
              return item;
            }),
          );
        };

        for (let i = 0; i < files.length; i += BATCH_UPLOAD_LIMIT) {
          const batch = files.slice(i, i + BATCH_UPLOAD_LIMIT);
          const batchIds = targetIds.slice(i, i + BATCH_UPLOAD_LIMIT);
          const batchBytes = batch.reduce((sum, f) => sum + f.size, 0);
          let offset = 0;
          activeFiles = batchIds.map((id, k) => {
            const entry = { id, offset, size: batch[k].size };
            offset += batch[k].size;
            return entry;
          });
          try {
            const result = await uploadBatch(batch, meta, {
              signal: controller.signal,
              onProgress: (p) => reportProgress(p.loaded, p.total || batchBytes),
            });
            result.results.forEach((r, j) => {
              const id = batchIds[j];
              if (r.success) {
                successCount += 1;
                resultsById.set(id, { status: 'success', result: r.resource });
              } else {
                failCount += 1;
                resultsById.set(id, { status: 'error', error: r.error });
              }
            });
          } catch (e) {
            if (isAbortError(e)) {
              // 用户取消了：不再继续后面的批次，未传完的文件退回待上传
              canceled = true;
              break;
            }
            // 整批上传失败（如网络错误/后端拒绝），该批所有文件标记失败
            const msg = e instanceof Error ? e.message : '上传失败';
            batchIds.forEach((id) => {
              failCount += 1;
              resultsById.set(id, { status: 'error', error: msg });
            });
          }
          completedBytes += batchBytes;
          // 逐批落库：否则前一批已完成的行会一直停在“校验中”，直到整轮结束
          applyResults(false);
        }

        // 兜底：已发送但未返回结果的文件如实标注，避免卡在“上传中”。
        // 取消属于用户主动中断，未传完的文件退回待上传即可，不算失败。
        if (!canceled) {
          for (const id of targetIds) {
            if (!resultsById.has(id)) {
              failCount += 1;
              resultsById.set(id, { status: 'error' as const, error: '服务器未返回处理结果' });
            }
          }
        }

        // 应用最终结果；取消时把尚未传完的行退回待上传（用户主动中断不算失败）
        applyResults(canceled);

        if (canceled) {
          toast.info(
            successCount > 0
              ? `已取消上传，本轮已成功 ${successCount} 个`
              : '已取消上传',
          );
        } else if (failCount === 0) {
          toast.success(`上传完成：${successCount} 个文件全部成功`);
        } else {
          toast.error(`上传完成：${successCount} 成功，${failCount} 失败`);
        }
      }
    } finally {
      uploadingRef.current = false;
      abortRef.current = null;
      setUploading(false);
      // 进度条只在传输过程中有意义，结束后收起
      setRound(null);
    }
  };

  const reset = () => {
    setQueue([]);
    setTitle('');
    setDescription('');
    setCategoryId('');
    setSource('');
    setAuthor('');
  };

  const doneCount = queue.filter((q) => q.status === 'success').length;
  const pendingCount = queue.filter((q) => q.status === 'pending').length;
  const errorCount = queue.filter((q) => q.status === 'error').length;
  const canUpload = pendingCount + errorCount > 0;
  // 队列已无待上传/失败项且至少成功过一个，视为本轮完成，可清空开始新一批
  const queueFinished = doneCount > 0 && !canUpload;

  const uploadedPercent =
    round && round.total > 0 ? Math.min(100, Math.round((round.loaded / round.total) * 100)) : 0;
  const remainingSeconds = round && round.speed > 0 ? (round.total - round.loaded) / round.speed : 0;
  // 速度/剩余时间分开拼：总字节为 0（全是空文件）时不该渲染出空的“剩余 ”
  const transferDetail =
    round && round.speed > 0
      ? [`${formatBytes(round.speed)}/s`, remainingSeconds > 0 ? `剩余 ${formatRemaining(remainingSeconds)}` : '']
          .filter(Boolean)
          .join(' · ')
      : '';
  // 字节已发完但响应还没回来：后端在算哈希/落库，明确提示，避免用户以为卡死
  const serverProcessing = !!round && round.total > 0 && round.loaded >= round.total;

  const handleCreateFolder = async () => {
    const name = folderName.trim();
    if (!name) return;

    try {
      const created = await createCategory({
        name,
        parentId: folderParentId ?? undefined,
      });
      toast.success('文件夹已创建');
      setFolderDialogOpen(false);
      setFolderName('');
      setFolderParentId(null);
      await loadCategories();
      setCategoryId(created.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '创建文件夹失败');
    }
  };

  return (
    <div>
      <PageHeader title="上传" description="上传文件到资源库">
        {queueFinished && (
          <Button variant="outline" size="sm" onClick={reset}>
            继续上传
          </Button>
        )}
      </PageHeader>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 拖拽区域 */}
        <div className="lg:col-span-2 space-y-4">
          <div
            ref={dropZoneRef}
            role="button"
            tabIndex={uploading ? -1 : 0}
            onDragOver={(e) => { e.preventDefault(); if (!uploading) setDragover(true); }}
            onDragLeave={() => setDragover(false)}
            onDrop={handleDrop}
            onClick={() => { if (!uploading) fileInputRef.current?.click(); }}
            onKeyDown={(e) => {
              if (uploading) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            aria-disabled={uploading}
            className={cn(
              'flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-12 transition-colors',
              uploading
                ? 'cursor-not-allowed border-muted-foreground/20'
                : 'cursor-pointer border-muted-foreground/25 hover:border-muted-foreground/50',
              dragover ? 'border-primary bg-primary/5' : '',
            )}
          >
            <Upload className="mb-4 h-12 w-12 text-muted-foreground" />
            <p className="mb-1 text-lg font-medium">拖拽文件到此处</p>
            <p className="text-sm text-muted-foreground">或点击选择文件</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {uploading
                ? '上传中，暂时无法添加文件'
                : `支持多选，超过 ${BATCH_UPLOAD_LIMIT} 个文件将自动分批上传`}
            </p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
          </div>

          {/* 上传队列 */}
          {queue.length > 0 && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">上传队列 ({queue.length})</CardTitle>
                {!uploading && canUpload && (
                  <Button onClick={startUpload} className="gap-1">
                    <Upload className="h-4 w-4" />
                    {errorCount > 0 ? '重新上传' : '开始上传'}
                  </Button>
                )}
                {uploading && (
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium tabular-nums text-muted-foreground">
                      {serverProcessing ? '服务端处理中…' : `${uploadedPercent}%`}
                    </span>
                    <Button variant="outline" size="sm" onClick={cancelUpload} className="gap-1">
                      <X className="h-4 w-4" />
                      取消
                    </Button>
                  </div>
                )}
              </CardHeader>
              <CardContent className="space-y-2">
                {/* 整轮进度：百分比 + 已传/总量 + 速度 + 剩余时间 */}
                {uploading && round && (
                  <div className="space-y-1 pb-1">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-[width] duration-300"
                        style={{ width: `${uploadedPercent}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-xs tabular-nums text-muted-foreground">
                      <span>
                        {formatBytes(round.loaded)} / {formatBytes(round.total)}
                      </span>
                      <span>
                        {serverProcessing ? '已传完，等待服务端校验' : transferDetail || '正在测速…'}
                      </span>
                    </div>
                  </div>
                )}

                {queue.map((item) => {
                  const filePercent = Math.round((item.progress ?? 0) * 100);
                  // 字节发完、响应未回：后端在算哈希/落库
                  const fileSending = (item.progress ?? 0) >= 0.999;
                  return (
                    <div key={item.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
                      {item.status === 'pending' && <FileText className="h-5 w-5 text-muted-foreground" />}
                      {item.status === 'uploading' && <Loader2 className="h-5 w-5 animate-spin text-primary" />}
                      {item.status === 'success' && <CheckCircle2 className="h-5 w-5 text-success" />}
                      {item.status === 'error' && <AlertCircle className="h-5 w-5 text-destructive" />}

                      <div className="flex-1 min-w-0">
                        <p className="truncate text-sm font-medium">{item.file.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatBytes(item.file.size)}
                          {item.status === 'error' && item.error && (
                            <span className="ml-2 text-destructive">{item.error}</span>
                          )}
                          {item.status === 'success' && item.result && (
                            <span
                              className="ml-2 cursor-pointer text-primary hover:underline"
                              onClick={() => router.push(`/resources/${item.result!.id}`)}
                            >
                              查看资源 →
                            </span>
                          )}
                        </p>
                        {item.status === 'uploading' && (
                          <div className="mt-1.5 flex items-center gap-2">
                            <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-primary transition-[width] duration-200"
                                style={{ width: `${filePercent}%` }}
                              />
                            </div>
                            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                              {fileSending ? '校验中' : `${filePercent}%`}
                            </span>
                          </div>
                        )}
                      </div>

                      {(item.status === 'pending' || item.status === 'error') && (
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeFile(item.id)}>
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}
        </div>

        {/* 元数据设置 */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">上传设置</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label>标题</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="可选" maxLength={255} />
            </div>
            <div className="space-y-1">
              <Label>描述</Label>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="可选" maxLength={2000} rows={2} />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <Label>目标文件夹</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  onClick={() => {
                    setFolderName('');
                    setFolderParentId(null);
                    setFolderDialogOpen(true);
                  }}
                >
                  <FolderPlus className="h-3 w-3" />
                  新建
                </Button>
              </div>
              <Select
                value={categoryId || NO_FOLDER_VALUE}
                onValueChange={(value) => setCategoryId(value === NO_FOLDER_VALUE ? '' : value)}
                onOpenChange={(open) => { if (open) void loadCategories(); }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择文件夹" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_FOLDER_VALUE}>不放入文件夹</SelectItem>
                  {flatCategories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.parentId ? `- ${c.name}` : c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>来源</Label>
              <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="可选" maxLength={255} />
            </div>
            <div className="space-y-1">
              <Label>作者</Label>
              <Input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="可选" maxLength={255} />
            </div>
            <p className="text-xs text-muted-foreground">
              设置将应用于所有上传的文件
            </p>
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={folderDialogOpen}
        onOpenChange={(open) => {
          setFolderDialogOpen(open);
          if (!open) {
            setFolderName('');
            setFolderParentId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建文件夹</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="upload-folder-name">名称</Label>
              <Input
                id="upload-folder-name"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                placeholder="文件夹名称"
                maxLength={100}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void handleCreateFolder();
                  }
                }}
              />
            </div>
            <div className="space-y-2">
              <Label>上级文件夹</Label>
              <Select
                value={folderParentId ?? ROOT_FOLDER_VALUE}
                onValueChange={(value) => setFolderParentId(value === ROOT_FOLDER_VALUE ? null : value)}
                onOpenChange={(open) => { if (open) void loadCategories(); }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="无（作为根文件夹）" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ROOT_FOLDER_VALUE}>无（作为根文件夹）</SelectItem>
                  {flatCategories.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.parentId ? `- ${category.name}` : category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFolderDialogOpen(false)}>取消</Button>
            <Button onClick={handleCreateFolder} disabled={!folderName.trim()}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
