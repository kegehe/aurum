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
  file: File;
  status: 'pending' | 'uploading' | 'success' | 'error';
  result?: UploadResult['resource'];
  error?: string;
}

const NO_FOLDER_VALUE = '__no_folder__';
const ROOT_FOLDER_VALUE = '__root_folder__';

/** 后端单次批量上传最多允许的文件数（超出部分自动分批） */
const BATCH_UPLOAD_LIMIT = 20;

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

  const addFiles = (files: FileList | File[]) => {
    const newItems: QueueItem[] = Array.from(files).map((file) => ({
      file,
      status: 'pending' as const,
    }));
    setQueue((prev) => [...prev, ...newItems]);
  };

  const removeFile = (idx: number) => {
    setQueue((prev) => prev.filter((_, i) => i !== idx));
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

  const startUpload = async () => {
    if (uploadingRef.current) return;

    // 只处理待上传（pending）与失败（error）的文件；已成功的跳过，避免重复上传
    const targets = queue
      .map((item, idx) => ({ item, idx }))
      .filter(({ item }) => item.status === 'pending' || item.status === 'error');
    if (targets.length === 0) return;

    uploadingRef.current = true;
    const targetIndices = targets.map((t) => t.idx);

    try {
      setUploading(true);

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
        const idx = targetIndices[0];
        setQueue((prev) => prev.map((item, i) => (i === idx ? { ...item, status: 'uploading' as const } : item)));
        try {
          const result = await uploadFile(targets[0].item.file, meta);
          setQueue((prev) => prev.map((item, i) => (i === idx ? { ...item, status: 'success' as const, result: result.resource } : item)));
          toast.success('上传成功');
        } catch (e) {
          const msg = e instanceof Error ? e.message : '上传失败';
          setQueue((prev) => prev.map((item, i) => (i === idx ? { ...item, status: 'error' as const, error: msg } : item)));
        }
      } else {
        // 批量上传：每批最多 BATCH_UPLOAD_LIMIT 个文件，超出部分自动拆分成多批依次上传
        const files = targets.map((t) => t.item.file);
        // 仅将本轮参与上传的文件标记为 uploading，已成功的保持原状
        setQueue((prev) =>
          prev.map((item, i) => (targetIndices.includes(i) ? { ...item, status: 'uploading' as const } : item)),
        );

        let successCount = 0;
        let failCount = 0;
        const resultsByIndex = new Map<
          number,
          | { status: 'success'; result: UploadResult['resource'] }
          | { status: 'error'; error: string }
        >();

        for (let i = 0; i < files.length; i += BATCH_UPLOAD_LIMIT) {
          const batch = files.slice(i, i + BATCH_UPLOAD_LIMIT);
          const batchIndices = targetIndices.slice(i, i + BATCH_UPLOAD_LIMIT);
          try {
            const result = await uploadBatch(batch, meta);
            result.results.forEach((r, j) => {
              const idx = batchIndices[j];
              if (r.success) {
                successCount += 1;
                resultsByIndex.set(idx, { status: 'success', result: r.resource });
              } else {
                failCount += 1;
                resultsByIndex.set(idx, { status: 'error', error: r.error });
              }
            });
          } catch (e) {
            // 整批上传失败（如网络错误/后端拒绝），该批所有文件标记失败
            const msg = e instanceof Error ? e.message : '上传失败';
            batchIndices.forEach((idx) => {
              failCount += 1;
              resultsByIndex.set(idx, { status: 'error', error: msg });
            });
          }
        }

        // 兜底：已发送但未返回结果的文件如实标注，避免卡在“上传中”
        for (const idx of targetIndices) {
          if (!resultsByIndex.has(idx)) {
            failCount += 1;
            resultsByIndex.set(idx, { status: 'error' as const, error: '服务器未返回处理结果' });
          }
        }

        setQueue((prev) =>
          prev.map((item, i) => {
            const r = resultsByIndex.get(i);
            if (!r) return item;
            return r.status === 'success'
              ? { ...item, status: 'success' as const, result: r.result }
              : { ...item, status: 'error' as const, error: r.error };
          }),
        );
        if (failCount === 0) {
          toast.success(`上传完成：${successCount} 个文件全部成功`);
        } else {
          toast.error(`上传完成：${successCount} 成功，${failCount} 失败`);
        }
      }
    } finally {
      uploadingRef.current = false;
      setUploading(false);
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
            onDragOver={(e) => { e.preventDefault(); if (!uploading) setDragover(true); }}
            onDragLeave={() => setDragover(false)}
            onDrop={handleDrop}
            onClick={() => { if (!uploading) fileInputRef.current?.click(); }}
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
                  <Button disabled className="gap-1">
                    <Loader2 className="h-4 w-4 animate-spin" />上传中...
                  </Button>
                )}
              </CardHeader>
              <CardContent className="space-y-2">
                {queue.map((item, idx) => (
                  <div key={idx} className="flex items-center gap-3 rounded-md border px-3 py-2">
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
                    </div>

                    {(item.status === 'pending' || item.status === 'error') && (
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeFile(idx)}>
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
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
