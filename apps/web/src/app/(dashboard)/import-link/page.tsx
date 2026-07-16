'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Link as LinkIcon, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { createLinkImport, getIngestionJob, retryIngestionJob } from '@/lib/api/ingestion';
import { listCategories } from '@/lib/api/categories';
import { listTags } from '@/lib/api/tags';
import { listSources } from '@/lib/api/sources';
import type { CategoryTreeNode, IngestionJobItem, TagWithUsage, SourceItem } from '@/lib/types';

const NO_CATEGORY_VALUE = '__no_category__';

function flattenCategories(categories: CategoryTreeNode[]): CategoryTreeNode[] {
  return categories.flatMap((category) => [category, ...flattenCategories(category.children)]);
}

export default function ImportLinkPage() {
  const router = useRouter();
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [categoryId, setCategoryId] = useState(NO_CATEGORY_VALUE);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [categories, setCategories] = useState<CategoryTreeNode[]>([]);
  const [tags, setTags] = useState<TagWithUsage[]>([]);
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [sourceId, setSourceId] = useState('__none__');
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [job, setJob] = useState<IngestionJobItem | null>(null);
  const flatCategories = useMemo(() => flattenCategories(categories), [categories]);

  useEffect(() => () => {
    if (pollTimer.current) clearInterval(pollTimer.current);
  }, []);

  useEffect(() => {
    void listCategories().then((result) => setCategories(result.items)).catch(() => undefined);
    void listTags().then((result) => setTags(result.items)).catch(() => undefined);
    void listSources({ enabled: true, pageSize: 100 }).then((result) => setSources(result.items)).catch(() => undefined);
  }, []);

  const stopPolling = () => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  };

  const pollJob = (jobId: string) => {
    stopPolling();
    setPollError(null);
    pollTimer.current = setInterval(() => {
      void getIngestionJob(jobId)
        .then((nextJob) => {
          setJob(nextJob);
          if (nextJob.status === 'completed' && nextJob.resourceId) {
            stopPolling();
            router.push(`/resources/${nextJob.resourceId}`);
          }
          if (nextJob.status === 'failed' || nextJob.status === 'canceled') stopPolling();
        })
        .catch((err) => {
          setPollError(err instanceof Error ? err.message : '轮询任务状态失败');
          stopPolling();
        });
    }, 1000);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!url.trim()) return;
    setSubmitting(true);
    setPollError(null);
    try {
      const created = await createLinkImport({
        url: url.trim(),
        sourceId: sourceId && sourceId !== '__none__' ? sourceId : undefined,
        title: title.trim() || undefined,
        categoryId: categoryId === NO_CATEGORY_VALUE ? undefined : categoryId,
        tagIds: tagIds.length ? tagIds : undefined,
      });
      setJob(created);
      pollJob(created.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法创建链接导入任务');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleTag = (tagId: string) => {
    setTagIds((current) => (current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId]));
  };

  const retry = async () => {
    if (!job) return;
    setRetrying(true);
    try {
      const retried = await retryIngestionJob(job.id);
      setJob(retried);
      pollJob(retried.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法重试导入任务');
    } finally {
      setRetrying(false);
    }
  };

  const isRunning = job?.status === 'pending' || job?.status === 'processing';

  return (
    <div className="max-w-2xl">
      <PageHeader title="添加链接资源" />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">链接信息</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            {sources.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="resource-source">来源</Label>
                <Select value={sourceId} onValueChange={setSourceId} disabled={isRunning}>
                  <SelectTrigger id="resource-source">
                    <SelectValue placeholder="不指定来源" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">不指定来源</SelectItem>
                    {sources.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name} ({s.slug})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {sourceId && sourceId !== '__none__' && (() => {
                  const selected = sources.find((s) => s.id === sourceId);
                  return selected?.baseUrl ? (
                    <p className="text-xs text-muted-foreground">Base URL: {selected.baseUrl}</p>
                  ) : null;
                })()}
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="resource-url">网页地址</Label>
              <Input
                id="resource-url"
                type="url"
                placeholder="https://example.com/resource"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                maxLength={2048}
                required
                disabled={isRunning}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="resource-title">标题覆盖</Label>
              <Input
                id="resource-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={255}
                disabled={isRunning}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="resource-category">分类</Label>
              <Select value={categoryId} onValueChange={setCategoryId} disabled={isRunning}>
                <SelectTrigger id="resource-category">
                  <SelectValue placeholder="不设置分类" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CATEGORY_VALUE}>不设置分类</SelectItem>
                  {flatCategories.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.parentId ? `- ${category.name}` : category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {tags.length > 0 && (
              <div className="space-y-1.5">
                <Label>标签</Label>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {tags.map((tag) => (
                    <label key={tag.id} className="flex min-w-0 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={tagIds.includes(tag.id)}
                        onChange={() => toggleTag(tag.id)}
                        disabled={isRunning}
                        className="h-4 w-4 shrink-0 accent-primary"
                      />
                      {tag.color && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />}
                      <span className="truncate">{tag.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <Button type="submit" disabled={submitting || isRunning} className="gap-2">
              {submitting || isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <LinkIcon className="h-4 w-4" />}
              添加链接
            </Button>
          </form>

          {job && (
            <div className="mt-5 flex items-start gap-3 border-t pt-4 text-sm">
              {job.status === 'completed' ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" />
              ) : job.status === 'failed' ? (
                <AlertCircle className="mt-0.5 h-4 w-4 text-destructive" />
              ) : job.status === 'canceled' ? (
                <AlertCircle className="mt-0.5 h-4 w-4 text-muted-foreground" />
              ) : (
                <Loader2 className="mt-0.5 h-4 w-4 animate-spin text-muted-foreground" />
              )}
              <div>
                <p className="font-medium">
                  {job.status === 'failed' ? '导入失败' : job.status === 'completed' ? '导入完成' : job.status === 'canceled' ? '导入已取消' : '正在导入'}
                </p>
                {job.errorMessage && <p className="mt-1 text-destructive">{job.errorMessage}</p>}
                {pollError && !job.errorMessage && <p className="mt-1 text-destructive">网络错误：{pollError}</p>}
                {(job.status === 'failed' || job.status === 'canceled') && (
                  <Button variant="outline" size="sm" className="mt-2" onClick={retry} disabled={retrying}>
                    重试
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
