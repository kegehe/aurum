'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Download,
  ExternalLink,
  Pencil,
  Trash2,
  RotateCcw,
  RefreshCw,
  FileText,
  Image,
  Video,
  Plus,
  X,
} from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
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
  updateResource,
  softDeleteResource,
  restoreResource,
  reprocessResource,
  addTagToResource,
  removeTagFromResource,
  getResourceDownloadUrl,
  getResourcePreviewUrl,
  checkResourceLocators,
} from '@/lib/api/resources';
import { listTags } from '@/lib/api/tags';
import { listCategories } from '@/lib/api/categories';
import { formatByteString, formatDateTime } from '@/lib/format';
import { PROCESSING_STATUS_LABELS, LICENSE_STATUS_LABELS, LOCATOR_TYPE_LABELS } from '@/lib/constants';
import type { ResourceDetail, TagWithUsage, CategoryTreeNode } from '@/lib/types';

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

export default function ResourceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [resource, setResource] = useState<ResourceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [externalPreviewError, setExternalPreviewError] = useState(false);

  // 编辑 Dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editSource, setEditSource] = useState('');
  const [editAuthor, setEditAuthor] = useState('');
  const [editCategoryId, setEditCategoryId] = useState('');

  // 标签
  const [allTags, setAllTags] = useState<TagWithUsage[]>([]);
  const [categories, setCategories] = useState<CategoryTreeNode[]>([]);
  const [addTagId, setAddTagId] = useState('');
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
    listTags().then((d) => setAllTags(d.items)).catch(() => {});
    listCategories().then((d) => setCategories(d.items)).catch(() => {});
  }, [fetchResource]);

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

  const handleAddTag = async () => {
    if (!addTagId) return;
    try {
      await addTagToResource(id, addTagId);
      toast.success('标签已添加');
      setAddTagId('');
      await fetchResource();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '添加标签失败');
    }
  };

  const handleRemoveTag = async (tagId: string) => {
    try {
      await removeTagFromResource(id, tagId);
      toast.success('标签已移除');
      await fetchResource();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '移除标签失败');
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

  const hasBrokenLinks = resource?.locators?.some(
    (l) => (l.httpStatus ?? 0) >= 400 || l.lastError !== null,
  );

  const primaryLocator = resource?.locators?.find((locator) => locator.isPrimary);
  const previewLocator = resource?.locators?.find((locator) => locator.locatorType === 'preview');
  const isExternalResource = !!resource?.acquisitionMode && resource.acquisitionMode !== 'local_upload';

  if (loading) {
    return (
      <div>
        <PageHeader title="资源详情" />
        <LoadingState variant="card" count={3} />
      </div>
    );
  }

  if (error || !resource) {
    return (
      <div>
        <PageHeader title="资源详情" />
        <ErrorState message={error ?? '未找到资源'} onRetry={fetchResource} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={resource.title || resource.originalFilename}>
        <div className="flex items-center gap-1">
          {isExternalResource && primaryLocator ? (
            <Button variant="outline" size="sm" className="gap-1" asChild>
              <a href={primaryLocator.url} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" />打开链接
              </a>
            </Button>
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
          {!isExternalResource && (
            <Button variant="outline" size="sm" className="gap-1" onClick={handleReprocess}>
              <RefreshCw className="h-4 w-4" />重新处理
            </Button>
          )}
        </div>
      </PageHeader>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 左侧：预览 + 信息 */}
        <div className="lg:col-span-2 space-y-6">
          {/* 预览 */}
          {isExternalResource && previewLocator ? (
            <Card>
              <CardContent className="flex items-center justify-center py-16">
                {externalPreviewError ? (
                  <ResourceTypeIcon type={resource.resourceType} className="h-24 w-24 text-muted-foreground" />
                ) : (
                  <img
                    src={previewLocator.url}
                    alt={resource.title || resource.originalFilename}
                    referrerPolicy="no-referrer"
                    className="max-h-[480px] max-w-full rounded object-contain"
                    onError={() => setExternalPreviewError(true)}
                  />
                )}
              </CardContent>
            </Card>
          ) : !isExternalResource ? (
            <Card>
              <CardContent className="flex items-center justify-center py-16">
                {resource.resourceType === 'image' && !previewError ? (
                  <img
                    src={getResourcePreviewUrl(resource.id)}
                    alt={resource.title || resource.originalFilename}
                    className="max-h-[480px] max-w-full rounded object-contain"
                    onError={() => setPreviewError(true)}
                  />
                ) : (
                  <ResourceTypeIcon type={resource.resourceType} className="h-24 w-24 text-muted-foreground" />
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

          {/* 标签 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">标签</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex flex-wrap gap-1">
                {resource.tags.map((tag) => (
                  <Badge key={tag.id} variant="secondary" className="gap-1">
                    {tag.color && (
                      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: tag.color }} />
                    )}
                    {tag.name}
                    <button onClick={() => handleRemoveTag(tag.id)} className="ml-1 hover:text-destructive">
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
                {resource.tags.length === 0 && (
                  <p className="text-sm text-muted-foreground">暂无标签</p>
                )}
              </div>
              <div className="flex gap-1">
                <Select value={addTagId} onValueChange={setAddTagId}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="添加标签" />
                  </SelectTrigger>
                  <SelectContent>
                    {allTags
                      .filter((t) => !resource.tags.some((rt) => rt.id === t.id))
                      .map((t) => (
                        <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <Button size="sm" variant="outline" className="h-8" onClick={handleAddTag} disabled={!addTagId}>
                  <Plus className="h-3 w-3" />
                </Button>
              </div>
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
              {isExternalResource && resource.licenseStatus && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">许可状态</span>
                  <Badge variant={resource.licenseStatus === 'verified' ? 'success' : resource.licenseStatus === 'restricted' || resource.licenseStatus === 'rejected' ? 'destructive' : 'secondary'}>
                    {LICENSE_STATUS_LABELS[resource.licenseStatus] ?? resource.licenseStatus}
                  </Badge>
                </div>
              )}
              {resource.license && (
                <div className="flex justify-between gap-3">
                  <span className="shrink-0 text-muted-foreground">许可证</span>
                  {resource.license.url ? (
                    <a href={resource.license.url} target="_blank" rel="noreferrer" className="truncate text-primary hover:underline">
                      {resource.license.spdxId ?? resource.license.name}
                    </a>
                  ) : (
                    <span className="truncate">{resource.license.spdxId ?? resource.license.name}</span>
                  )}
                </div>
              )}
              {resource.licenseNote && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">许可证备注</span>
                  <span>{resource.licenseNote}</span>
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
                    {p.licenseText && (
                      <div>
                        <span className="text-muted-foreground">许可文本：</span>
                        <p className="mt-1 text-xs text-muted-foreground line-clamp-3">{p.licenseText}</p>
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
