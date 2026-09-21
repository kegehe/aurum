'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { FolderOpen, Plus, Power, PowerOff, RefreshCw, Square } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  listSources,
  createSource,
  updateSource,
  deleteSource,
  syncSource,
  getIngestionJob,
  cancelIngestionJob,
  listIngestionJobs,
  listSourceDownloadDirectories,
} from '@/lib/api/sources';
import { SOURCE_TYPE_LABELS } from '@/lib/constants';
import { IngestionJobStatus, IngestionJobType } from '@aurum/shared-types';
import type { SourceItem, IngestionJobItem } from '@/lib/types';

const SOURCE_TYPES = Object.entries(SOURCE_TYPE_LABELS);

/** 定时自动同步间隔选项（小时）；'off' = 关闭 */
const AUTO_SYNC_INTERVAL_OPTIONS = [
  { value: 'off', label: '关闭' },
  { value: '1', label: '每小时' },
  { value: '6', label: '每 6 小时' },
  { value: '24', label: '每天' },
  { value: '168', label: '每周' },
];

/** 格式化自动同步间隔显示（支持预设之外的任意小时数） */
function autoSyncIntervalLabel(hours: number | null | undefined): string {
  if (!hours || hours < 1) return '关闭';
  if (hours === 1) return '每小时';
  if (hours === 6) return '每 6 小时';
  if (hours === 24) return '每天';
  if (hours === 168) return '每周';
  return `每 ${hours} 小时`;
}

const SYNC_TERMINAL = new Set<IngestionJobStatus>([
  IngestionJobStatus.completed,
  IngestionJobStatus.failed,
  IngestionJobStatus.canceled,
]);

interface SyncProgress {
  pagesProcessed?: number;
  itemsProcessed?: number;
  downloadedCount?: number;
  skippedCount?: number;
  failedCount?: number;
  totalItems?: number | null;
}

function parseSyncProgress(job: IngestionJobItem): SyncProgress | null {
  try {
    return job.result ? (JSON.parse(job.result) as SyncProgress) : null;
  } catch {
    return null;
  }
}

export default function SourcesPage() {
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 新建/编辑 Dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSource, setEditingSource] = useState<SourceItem | null>(null);
  const [formName, setFormName] = useState('');
  const [formSlug, setFormSlug] = useState('');
  const [formSourceType, setFormSourceType] = useState('link_metadata');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formEnabled, setFormEnabled] = useState(true);
  const [formMaxConcurrency, setFormMaxConcurrency] = useState('4');
  const [formRateLimit, setFormRateLimit] = useState('30');
  const [formDownloadInterval, setFormDownloadInterval] = useState('1000');

  // Civitai 配置：获取方式 / 排序 / 时间范围 / NSFW / 每次数量 / 页数
  const [formSyncMode, setFormSyncMode] = useState<'auto_download' | 'metadata_only'>(
    'auto_download',
  );
  const [formCivitaiSort, setFormCivitaiSort] = useState('Newest');
  const [formCivitaiPeriod, setFormCivitaiPeriod] = useState('AllTime');
  const [formCivitaiNsfw, setFormCivitaiNsfw] = useState(false);
  // GitHub 配置：仓库（owner/repo 或 github.com URL）
  const [formGithubRepo, setFormGithubRepo] = useState('');
  const [formLimit, setFormLimit] = useState('100');
  const [formMaxPages, setFormMaxPages] = useState('1');
  const [formAutoSyncInterval, setFormAutoSyncInterval] = useState('off');
  const [formDownloadDirectory, setFormDownloadDirectory] = useState('');
  // 可选的下载目录（已有来源目录 + 存储根下的自定义目录），供 datalist 建议
  const [availableDirectories, setAvailableDirectories] = useState<string[]>([]);

  // 可同步的来源类型（有后台连接器支持 sync_source）：civitai / github
  const isSyncSource = formSourceType === 'civitai' || formSourceType === 'github';

  // 同步状态
  const [activeSyncJobs, setActiveSyncJobs] = useState<Record<string, IngestionJobItem>>({});
  const [stoppingSyncSourceIds, setStoppingSyncSourceIds] = useState<string[]>([]);
  // 组件卸载后停止同步轮询（避免在其它页面弹出 toast / 更新已卸载组件）
  const syncPollCancelledRef = useRef(false);
  useEffect(() => {
    syncPollCancelledRef.current = false;
    return () => {
      syncPollCancelledRef.current = true;
    };
  }, []);

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<SourceItem | null>(null);

  const fetchSources = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, pendingJobs, processingJobs] = await Promise.all([
        listSources({ pageSize: 100 }),
        listIngestionJobs({
          status: IngestionJobStatus.pending,
          jobType: IngestionJobType.sync_source,
          pageSize: 100,
        }),
        listIngestionJobs({
          status: IngestionJobStatus.processing,
          jobType: IngestionJobType.sync_source,
          pageSize: 100,
        }),
      ]);
      const jobsBySource = [...pendingJobs.items, ...processingJobs.items].reduce<
        Record<string, IngestionJobItem>
      >((jobs, job) => (job.source ? { ...jobs, [job.source.id]: job } : jobs), {});
      setSources(data.items);
      setActiveSyncJobs(jobsBySource);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSources();
  }, [fetchSources]);

  // 加载可选的下载目录（编辑弹窗“选择目录”用）
  useEffect(() => {
    let cancelled = false;
    listSourceDownloadDirectories()
      .then((dirs) => {
        if (!cancelled) setAvailableDirectories(dirs);
      })
      .catch(() => {
        /* 目录建议加载失败不阻塞弹窗，仅少一组建议 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const activeJobs = Object.values(activeSyncJobs);
    if (activeJobs.length === 0) return;

    const refreshActiveJobs = async () => {
      try {
        const latestJobs = await Promise.all(activeJobs.map((job) => getIngestionJob(job.id)));
        const terminalSourceIds = latestJobs
          .filter((job) => SYNC_TERMINAL.has(job.status) && job.source)
          .map((job) => job.source!.id);

        setActiveSyncJobs((jobs) => {
          const next = { ...jobs };
          for (const job of latestJobs) {
            const sourceId = job.source?.id;
            if (!sourceId || jobs[sourceId]?.id !== job.id) continue;
            if (SYNC_TERMINAL.has(job.status)) delete next[sourceId];
            else next[sourceId] = job;
          }
          return next;
        });
        if (terminalSourceIds.length > 0) {
          setStoppingSyncSourceIds((ids) => ids.filter((id) => !terminalSourceIds.includes(id)));
          await fetchSources();
        }
      } catch {
        // Keep the current display on transient polling failures and retry shortly.
      }
    };

    const timer = window.setInterval(() => void refreshActiveJobs(), 3000);
    return () => window.clearInterval(timer);
  }, [activeSyncJobs, fetchSources]);

  const resetForm = () => {
    setFormName('');
    setFormSlug('');
    setFormSourceType('link_metadata');
    setFormBaseUrl('');
    setFormEnabled(true);
    setFormMaxConcurrency('4');
    setFormRateLimit('30');
    setFormDownloadInterval('1000');
    setFormSyncMode('auto_download');
    setFormCivitaiSort('Newest');
    setFormCivitaiPeriod('AllTime');
    setFormCivitaiNsfw(false);
    setFormGithubRepo('');
    setFormLimit('100');
    setFormMaxPages('1');
    setFormAutoSyncInterval('off');
    setFormDownloadDirectory('');
  };

  const openCreate = () => {
    setEditingSource(null);
    resetForm();
    setDialogOpen(true);
  };

  const openEdit = (source: SourceItem) => {
    setEditingSource(source);
    setFormName(source.name);
    setFormSlug(source.slug);
    setFormSourceType(source.sourceType);
    setFormBaseUrl(source.baseUrl ?? '');
    setFormEnabled(source.enabled);
    // 历史默认 maxConcurrency=1 视为"未配置"（后端回退到内置默认 4），这里显示实际生效值；
    // 超出 DTO 上限（10）的值也钳回合法区间，避免保存时触发后端 @Max(10) 校验失败
    setFormMaxConcurrency(
      source.maxConcurrency >= 2 ? String(Math.min(source.maxConcurrency, 10)) : '4',
    );
    setFormRateLimit(String(Math.min(1000, Math.max(1, source.rateLimitPerMinute || 30))));
    setFormDownloadInterval(
      String(Math.min(60000, Math.max(0, source.downloadIntervalMs ?? 1000))),
    );
    // 获取方式：需要人工审核 = 仅保存元数据，否则自动下载图片
    setFormSyncMode(source.requiresReview ? 'metadata_only' : 'auto_download');
    // 重置 Civitai 配置，然后按需从 config 解析
    setFormCivitaiSort('Newest');
    setFormCivitaiPeriod('AllTime');
    setFormCivitaiNsfw(false);
    setFormGithubRepo('');
    setFormLimit('100');
    setFormMaxPages('1');
    if (source.sourceType === 'civitai' && source.config) {
      try {
        const config = JSON.parse(source.config);
        setFormCivitaiSort(config.filters?.sort ?? config.sort ?? 'Newest');
        setFormCivitaiPeriod(config.filters?.period ?? config.period ?? 'AllTime');
        setFormCivitaiNsfw(config.filters?.nsfw ?? config.nsfw ?? false);
        setFormLimit(String(config.limit ?? 100));
        setFormMaxPages(String(config.maxPages ?? 1));
      } catch {
        // keep defaults
      }
    }
    if (source.sourceType === 'github' && source.config) {
      try {
        const config = JSON.parse(source.config);
        setFormGithubRepo(typeof config.repo === 'string' ? config.repo : '');
        setFormLimit(String(config.limit ?? 30));
        setFormMaxPages(String(config.maxPages ?? 1));
      } catch {
        // keep defaults
      }
    }
    // 定时自动同步间隔是独立的 DB 字段（非 civitai config）
    setFormAutoSyncInterval(
      source.autoSyncIntervalHours && source.autoSyncIntervalHours > 0
        ? String(source.autoSyncIntervalHours)
        : 'off',
    );
    setFormDownloadDirectory(source.downloadDirectory ?? '');
    setDialogOpen(true);
  };

  const buildConfig = (existingConfig?: string | null): string | undefined => {
    if (formSourceType === 'civitai') {
      // 编辑时：仅当筛选条件（sort/period/nsfw）未变化时保留 cursor，
      // 否则 cursor 与新的筛选不匹配（civitai 的 cursor 绑定排序/范围），应从头拉取。
      // limit / maxPages 变更不影响 cursor，总是写入。
      let cursor: string | undefined;
      let existingSort: string | undefined;
      let existingPeriod: string | undefined;
      let existingNsfw: boolean | undefined;
      if (existingConfig) {
        try {
          const parsed = JSON.parse(existingConfig);
          if (typeof parsed.cursor === 'string') cursor = parsed.cursor;
          // 兼容历史嵌套 filters 格式：sort/period/nsfw 可能在 parsed.filters 里
          const filters = (parsed.filters ?? {}) as Record<string, unknown>;
          if (typeof parsed.sort === 'string') existingSort = parsed.sort;
          else if (typeof filters.sort === 'string') existingSort = filters.sort;
          if (typeof parsed.period === 'string') existingPeriod = parsed.period;
          else if (typeof filters.period === 'string') existingPeriod = filters.period;
          if (typeof parsed.nsfw === 'boolean') existingNsfw = parsed.nsfw;
          else if (typeof filters.nsfw === 'boolean') existingNsfw = filters.nsfw;
        } catch {
          // malformed config — ignore
        }
      }
      const filtersChanged =
        (existingSort !== undefined && existingSort !== formCivitaiSort) ||
        (existingPeriod !== undefined && existingPeriod !== formCivitaiPeriod) ||
        (existingNsfw !== undefined && existingNsfw !== formCivitaiNsfw);
      const limit = Number.parseInt(formLimit, 10);
      const maxPages = Number.parseInt(formMaxPages, 10);
      return JSON.stringify({
        sort: formCivitaiSort,
        period: formCivitaiPeriod,
        nsfw: formCivitaiNsfw,
        limit: Number.isFinite(limit) && limit > 0 ? limit : 100,
        maxPages: Number.isFinite(maxPages) && maxPages > 0 ? maxPages : 1,
        ...(cursor && !filtersChanged ? { cursor } : {}),
      });
    }
    if (formSourceType === 'github') {
      // 编辑时保留分页游标；仓库变化则从头拉取
      let cursor: string | undefined;
      let existingRepo: string | undefined;
      if (existingConfig) {
        try {
          const parsed = JSON.parse(existingConfig);
          if (typeof parsed.cursor === 'string') cursor = parsed.cursor;
          if (typeof parsed.repo === 'string') existingRepo = parsed.repo;
        } catch {
          // malformed config — ignore
        }
      }
      const repo = formGithubRepo.trim();
      const limit = Number.parseInt(formLimit, 10);
      const maxPages = Number.parseInt(formMaxPages, 10);
      return JSON.stringify({
        repo,
        limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 30,
        maxPages: Number.isFinite(maxPages) && maxPages > 0 ? maxPages : 1,
        ...(cursor && existingRepo === repo ? { cursor } : {}),
      });
    }
    return undefined;
  };

  const handleSave = async () => {
    if (!formName.trim() || !formSlug.trim()) return;
    if (formSourceType === 'github' && !formGithubRepo.trim()) {
      toast.error('GitHub 来源需要填写仓库（owner/repo）');
      return;
    }
    // 仅同步型来源按表单重写 config；其它类型保留原有 config，
    // 避免编辑（改个名字）时误把已有 config（如同步 cursor）清空。
    const config = isSyncSource
      ? buildConfig(editingSource?.config)
      : (editingSource?.config ?? undefined);
    // 获取方式决定 allowedModes / requiresReview（仅同步型来源生效；
    // link_only 始终保留，链接导入功能依赖它）。maxConcurrency 只对同步有意义，
    // 一并放进 syncPolicy，避免编辑非同步来源时误改这个死字段。
    const metadataOnly = formSyncMode === 'metadata_only';
    const syncPolicy = isSyncSource
      ? {
          // Metadata-only sources do not download during sync, but a user may
          // explicitly review an item and mirror it later from its detail page.
          allowedModes: metadataOnly
            ? 'link_only,metadata_only,mirror_file'
            : 'link_only,mirror_file',
          requiresReview: metadataOnly,
          // 与输入框 min=2/max=10 及后端 DTO 约束保持一致，避免 1 或超限值落库
          maxConcurrency: Math.min(10, Math.max(2, parseInt(formMaxConcurrency) || 4)),
          rateLimitPerMinute: Math.min(1000, Math.max(1, parseInt(formRateLimit) || 30)),
          downloadIntervalMs: Math.min(60000, Math.max(0, parseInt(formDownloadInterval) || 0)),
        }
      : {};
    // 定时自动同步间隔（小时）：仅同步型来源（civitai/github）可配置。
    // 'off' = 关闭（创建时省略字段，更新时置 null 清除）。
    // 非同步来源不发送该字段：创建时省略、更新时保留原值，
    // 避免在创建对话框里把同步间隔残留写到不支持同步的来源上。
    const autoSyncIntervalHours = isSyncSource
      ? formAutoSyncInterval === 'off'
        ? null
        : Number.parseInt(formAutoSyncInterval, 10)
      : undefined;
    // 下载目录：仅同步型来源可配置。规整用户输入（反斜杠转正斜杠、去首尾斜杠、去空白），
    // 与后端 DTO 规则一致：由 / 分隔的若干段，每段为字母/数字/下划线/连字符。
    // 同步来源：填了写目录、留空传 null 清除（回到默认存储布局）；非同步来源：不发送字段。
    const rawDir = formDownloadDirectory
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    const downloadDirectoryValue = !isSyncSource
      ? undefined
      : rawDir
        ? rawDir
            .split('/')
            .map((seg) => seg.replace(/[^a-zA-Z0-9_-]/g, ''))
            .filter(Boolean)
            .join('/') || null
        : null;
    try {
      if (editingSource) {
        // 更新：null 表示清除字段，undefined 表示不更新
        await updateSource(editingSource.id, {
          name: formName.trim(),
          slug: formSlug.trim(),
          sourceType: formSourceType,
          baseUrl: formBaseUrl.trim() || null,
          enabled: formEnabled,
          ...syncPolicy,
          config: config ?? null,
          autoSyncIntervalHours,
          downloadDirectory: downloadDirectoryValue,
        });
        toast.success('来源已更新');
      } else {
        // 创建：undefined 表示省略字段
        await createSource({
          name: formName.trim(),
          slug: formSlug.trim(),
          sourceType: formSourceType,
          baseUrl: formBaseUrl.trim() || undefined,
          enabled: formEnabled,
          ...syncPolicy,
          config,
          autoSyncIntervalHours: autoSyncIntervalHours ?? undefined,
          ...(downloadDirectoryValue !== undefined
            ? { downloadDirectory: downloadDirectoryValue || undefined }
            : {}),
        });
        toast.success('来源已创建');
      }
      setDialogOpen(false);
      await fetchSources();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败');
    }
  };

  const handleToggleEnabled = async (source: SourceItem) => {
    try {
      await updateSource(source.id, { enabled: !source.enabled });
      toast.success(source.enabled ? '来源已禁用' : '来源已启用');
      await fetchSources();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败');
    }
  };

  /**
   * 轮询 ingestion 任务直到终态（completed/failed/canceled），
   * 返回最终任务；超时（默认 10 分钟）返回当前状态。
   * 组件卸载后抛出 AbortError 结束轮询。
   */
  const waitForJobTerminal = async (
    jobId: string,
    onProgress: (job: IngestionJobItem) => void,
    maxWaitMs = 10 * 60 * 1000,
  ): Promise<IngestionJobItem> => {
    const startedAt = Date.now();
    let consecutiveErrors = 0;
    while (Date.now() - startedAt < maxWaitMs) {
      if (syncPollCancelledRef.current) throw new DOMException('cancelled', 'AbortError');
      try {
        const job = await getIngestionJob(jobId);
        consecutiveErrors = 0;
        onProgress(job);
        if (SYNC_TERMINAL.has(job.status)) return job;
      } catch {
        // 瞬时网络错误：连续失败 3 次才放弃，避免误报同步失败
        consecutiveErrors++;
        if (consecutiveErrors >= 3) throw new Error('无法查询同步任务状态');
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return getIngestionJob(jobId);
  };

  const handleSync = async (source: SourceItem) => {
    try {
      const job = await syncSource(source.id);
      setActiveSyncJobs((jobs) => ({ ...jobs, [source.id]: job }));
      const terminal = await waitForJobTerminal(job.id, (currentJob) => {
        setActiveSyncJobs((jobs) => ({ ...jobs, [source.id]: currentJob }));
      });

      if (syncPollCancelledRef.current) return;

      if (terminal.status === IngestionJobStatus.completed) {
        let detail = '';
        try {
          const data = JSON.parse(terminal.result ?? '{}');
          const items = data.itemsProcessed ?? 0;
          const downloaded = data.downloadedCount ?? 0;
          const failed = data.failedCount ?? 0;
          const parts = [`已同步 ${items} 条`];
          if (downloaded > 0) parts.push(`下载 ${downloaded}`);
          if (failed > 0) parts.push(`失败 ${failed}`);
          detail = parts.join('，');
        } catch {
          // 解析失败时只显示通用文案
        }
        toast.success(`来源 "${source.name}" 同步完成${detail ? `：${detail}` : ''}`);
      } else if (terminal.status === IngestionJobStatus.canceled) {
        toast.info(`来源 "${source.name}" 下载已停止`);
      } else if (SYNC_TERMINAL.has(terminal.status)) {
        const reason = terminal.errorMessage || terminal.errorCode || '未知错误';
        toast.error(`来源 "${source.name}" 同步失败：${reason}`);
      } else {
        // 超过轮询时限仍未结束 → 任务在后台继续，不要误报失败
        toast.info(`来源 "${source.name}" 仍在下载中，可稍后刷新查看结果`);
      }
      await fetchSources();
    } catch (e) {
      // 组件卸载导致的取消不提示
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        toast.error(e instanceof Error ? e.message : '同步失败');
      }
    } finally {
      if (!syncPollCancelledRef.current) {
        setActiveSyncJobs((jobs) => {
          const activeJob = jobs[source.id];
          if (activeJob && !SYNC_TERMINAL.has(activeJob.status)) return jobs;
          const remainingJobs = { ...jobs };
          delete remainingJobs[source.id];
          return remainingJobs;
        });
        setStoppingSyncSourceIds((ids) => ids.filter((id) => id !== source.id));
      }
    }
  };

  const handleStopSync = async (source: SourceItem) => {
    const job = activeSyncJobs[source.id];
    if (!job) return;
    setStoppingSyncSourceIds((ids) => [...ids, source.id]);
    try {
      await cancelIngestionJob(job.id);
      toast.info(`正在停止来源 "${source.name}" 的下载`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '停止下载失败');
      setStoppingSyncSourceIds((ids) => ids.filter((id) => id !== source.id));
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteSource(deleteTarget.id);
      toast.success(`已删除来源 "${deleteTarget.name}"`);
      setDeleteTarget(null);
      await fetchSources();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  const columns: Column<SourceItem>[] = [
    {
      key: 'name',
      header: '来源名称',
      render: (s) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{s.name}</span>
          <span className="text-xs text-muted-foreground">{s.slug}</span>
        </div>
      ),
    },
    {
      key: 'sourceType',
      header: '类型',
      className: 'w-28',
      render: (s) => (
        <Badge variant="secondary">{SOURCE_TYPE_LABELS[s.sourceType] ?? s.sourceType}</Badge>
      ),
    },
    {
      key: 'enabled',
      header: '状态',
      className: 'w-20',
      render: (s) => (
        <Badge variant={s.enabled ? 'default' : 'outline'}>{s.enabled ? '启用' : '禁用'}</Badge>
      ),
    },
    {
      key: 'syncMode',
      header: '同步方式',
      className: 'w-28',
      render: (s) => {
        // 同步仅 civitai 类型支持；其它来源显示占位符
        if (s.sourceType !== 'civitai' && s.sourceType !== 'github') {
          return (
            <Badge variant="outline" className="text-xs">
              —
            </Badge>
          );
        }
        return s.requiresReview ? (
          <Badge variant="secondary" className="text-xs">
            仅元数据
          </Badge>
        ) : (
          <Badge variant="default" className="text-xs">
            自动下载
          </Badge>
        );
      },
    },
    {
      key: 'autoSync',
      header: '自动同步',
      className: 'w-24',
      render: (s) => {
        if (!s.autoSyncIntervalHours || s.autoSyncIntervalHours < 1) {
          return (
            <Badge variant="outline" className="text-xs">
              —
            </Badge>
          );
        }
        return (
          <Badge variant="secondary" className="text-xs">
            {autoSyncIntervalLabel(s.autoSyncIntervalHours)}
          </Badge>
        );
      },
    },
    {
      key: 'lastSyncedAt',
      header: '上次同步',
      className: 'w-40',
      render: (s) => {
        const activeJob = activeSyncJobs[s.id];
        const isSyncing = Boolean(activeJob);
        const syncProgress = activeJob ? parseSyncProgress(activeJob) : null;
        const stoppingSync = stoppingSyncSourceIds.includes(s.id);
        if (isSyncing) {
          const progressParts: string[] = [];
          if (syncProgress?.itemsProcessed !== undefined) {
            progressParts.push(`已处理 ${syncProgress.itemsProcessed}`);
          }
          if (syncProgress?.downloadedCount !== undefined) {
            progressParts.push(`下载 ${syncProgress.downloadedCount}`);
          }
          if (syncProgress?.failedCount) progressParts.push(`失败 ${syncProgress.failedCount}`);
          return (
            <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <RefreshCw className="h-3 w-3 animate-spin" />
                {stoppingSync ? '正在停止…' : '下载中…'}
              </span>
              {progressParts.length > 0 && <span>{progressParts.join('，')}</span>}
            </div>
          );
        }
        if (s.lastSyncStatus === 'failed') {
          return (
            <div className="flex flex-col gap-0.5">
              <Badge variant="destructive" className="w-fit text-xs">
                同步失败
              </Badge>
              {s.lastSyncedAt && (
                <span className="text-xs text-muted-foreground">
                  {new Date(s.lastSyncedAt).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              )}
              {s.lastSyncError && (
                <span className="text-xs text-destructive line-clamp-1" title={s.lastSyncError}>
                  {s.lastSyncError}
                </span>
              )}
            </div>
          );
        }
        if (s.lastSyncStatus === 'completed') {
          return (
            <div className="flex flex-col gap-0.5">
              <Badge variant="success" className="w-fit text-xs">
                成功
              </Badge>
              {s.lastSyncedAt && (
                <span className="text-xs text-muted-foreground">
                  {new Date(s.lastSyncedAt).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              )}
            </div>
          );
        }
        if (s.lastSyncStatus === 'canceled') {
          return (
            <Badge variant="outline" className="w-fit text-xs">
              已停止
            </Badge>
          );
        }
        return (
          <span className="text-xs text-muted-foreground">
            {s.lastSyncedAt
              ? new Date(s.lastSyncedAt).toLocaleString('zh-CN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : '从未'}
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: '操作',
      className: 'w-40 text-right',
      render: (s) => (
        <div className="flex justify-end gap-1">
          {(s.sourceType === 'civitai' || s.sourceType === 'github') && activeSyncJobs[s.id] ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleStopSync(s)}
              disabled={stoppingSyncSourceIds.includes(s.id)}
              title="停止下载"
              className="text-destructive hover:text-destructive"
            >
              <Square className="h-3.5 w-3.5" />
            </Button>
          ) : (
            (s.sourceType === 'civitai' || s.sourceType === 'github') && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleSync(s)}
                disabled={!s.enabled}
                title="开始下载"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            )
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleToggleEnabled(s)}
            title={s.enabled ? '禁用' : '启用'}
          >
            {s.enabled ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => openEdit(s)}>
            编辑
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDeleteTarget(s)}
            className="text-destructive hover:text-destructive"
          >
            删除
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="来源管理" description="管理外部资源来源配置和策略">
        <Button size="sm" className="gap-1" onClick={openCreate}>
          <Plus className="h-4 w-4" />
          新建来源
        </Button>
      </PageHeader>

      <DataTable
        columns={columns}
        data={sources}
        loading={loading}
        error={error ?? undefined}
        onRetry={fetchSources}
        emptyTitle="暂无来源"
        emptyDescription="创建来源配置来管理外部资源导入策略"
        keyExtractor={(s) => s.id}
      />

      {/* 新建/编辑 Dialog */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setEditingSource(null);
            resetForm();
          }
        }}
      >
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingSource ? '编辑来源' : '新建来源'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="source-name">名称 *</Label>
                <Input
                  id="source-name"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="来源名称"
                  maxLength={100}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="source-slug">标识符 *</Label>
                <Input
                  id="source-slug"
                  value={formSlug}
                  onChange={(e) => setFormSlug(e.target.value.replace(/[^a-z0-9-]/g, ''))}
                  placeholder="my-source"
                  maxLength={50}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>来源类型 *</Label>
                <Select value={formSourceType} onValueChange={setFormSourceType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SOURCE_TYPES.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="source-base-url">Base URL</Label>
                <Input
                  id="source-base-url"
                  value={formBaseUrl}
                  onChange={(e) => setFormBaseUrl(e.target.value)}
                  placeholder="https://example.com"
                />
              </div>
            </div>
            {/* 同步来源（civitai / github）设置 */}
            {isSyncSource && (
              <div className="space-y-3 border rounded-md p-3">
                <Label className="text-sm font-medium">同步设置</Label>
                {formSourceType === 'github' && (
                  <div className="space-y-2">
                    <Label htmlFor="source-github-repo" className="text-xs">
                      仓库 *
                    </Label>
                    <Input
                      id="source-github-repo"
                      value={formGithubRepo}
                      onChange={(e) => setFormGithubRepo(e.target.value)}
                      placeholder="owner/repo 或 https://github.com/owner/repo"
                      maxLength={200}
                      className="h-8 text-xs"
                    />
                    <p className="text-xs text-muted-foreground">
                      同步该仓库的 Release 资产（无资产的 Release 回退到 tag
                      源码包）。私有仓库需配置 GITHUB_TOKEN。
                    </p>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">获取方式</Label>
                    <Select
                      value={formSyncMode}
                      onValueChange={(value) =>
                        setFormSyncMode(value as 'auto_download' | 'metadata_only')
                      }
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto_download">
                          {formSourceType === 'github' ? '自动下载文件' : '自动下载图片'}
                        </SelectItem>
                        <SelectItem value="metadata_only">仅保存元数据</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="source-concurrency" className="text-xs">
                      下载并发
                    </Label>
                    <Input
                      id="source-concurrency"
                      type="number"
                      value={formMaxConcurrency}
                      onChange={(e) => setFormMaxConcurrency(e.target.value)}
                      min={2}
                      max={10}
                      className="h-8 text-xs"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="source-rate-limit" className="text-xs">
                      每分钟请求上限
                    </Label>
                    <Input
                      id="source-rate-limit"
                      type="number"
                      value={formRateLimit}
                      onChange={(e) => setFormRateLimit(e.target.value)}
                      min={1}
                      max={1000}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="source-download-interval" className="text-xs">
                      下载间隔（毫秒）
                    </Label>
                    <Input
                      id="source-download-interval"
                      type="number"
                      value={formDownloadInterval}
                      onChange={(e) => setFormDownloadInterval(e.target.value)}
                      min={0}
                      max={60000}
                      step={100}
                      className="h-8 text-xs"
                    />
                  </div>
                </div>
                {formSourceType === 'civitai' && (
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <Label className="text-xs">排序</Label>
                      <Select value={formCivitaiSort} onValueChange={setFormCivitaiSort}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Newest">最新</SelectItem>
                          <SelectItem value="Most Reactions">最多反应</SelectItem>
                          <SelectItem value="Most Comments">最多评论</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs">时间范围</Label>
                      <Select value={formCivitaiPeriod} onValueChange={setFormCivitaiPeriod}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="AllTime">全部</SelectItem>
                          <SelectItem value="Year">一年</SelectItem>
                          <SelectItem value="Month">一月</SelectItem>
                          <SelectItem value="Week">一周</SelectItem>
                          <SelectItem value="Day">一天</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-end gap-2 pb-1">
                      <label className="flex items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          checked={formCivitaiNsfw}
                          onChange={(e) => setFormCivitaiNsfw(e.target.checked)}
                          className="rounded border-gray-300"
                        />
                        NSFW
                      </label>
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">每次同步数量</Label>
                    <Select value={formLimit} onValueChange={setFormLimit}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="10">10</SelectItem>
                        <SelectItem value="50">50</SelectItem>
                        <SelectItem value="100">100</SelectItem>
                        <SelectItem value="200">200</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">同步页数</Label>
                    <Select value={formMaxPages} onValueChange={setFormMaxPages}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">1 页</SelectItem>
                        <SelectItem value="3">3 页</SelectItem>
                        <SelectItem value="5">5 页</SelectItem>
                        <SelectItem value="10">10 页</SelectItem>
                        <SelectItem value="20">20 页</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">定时自动同步</Label>
                    <Select value={formAutoSyncInterval} onValueChange={setFormAutoSyncInterval}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {AUTO_SYNC_INTERVAL_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                        {/* 兼容非预设间隔值（如 API 直接设置的 12 小时） */}
                        {formAutoSyncInterval !== 'off' &&
                          !AUTO_SYNC_INTERVAL_OPTIONS.some(
                            (o) => o.value === formAutoSyncInterval,
                          ) && (
                            <SelectItem value={formAutoSyncInterval}>
                              每 {formAutoSyncInterval} 小时
                            </SelectItem>
                          )}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-end pb-1">
                    <p className="text-xs text-muted-foreground">
                      到点自动拉取新内容；关闭则仅手动同步。
                    </p>
                  </div>
                </div>
                {/* 下载目录：相对存储根目录的子目录，下拉可复选已有目录，也可手动输入新子目录 */}
                <div className="space-y-2">
                  <Label htmlFor="source-download-directory" className="text-xs">
                    下载目录
                  </Label>
                  <div className="relative">
                    <FolderOpen className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="source-download-directory"
                      value={formDownloadDirectory}
                      onChange={(e) => setFormDownloadDirectory(e.target.value)}
                      placeholder={
                        formSourceType === 'github'
                          ? '如 github/owner-repo'
                          : '如 civitai/my-images'
                      }
                      list="source-download-directory-options"
                      maxLength={200}
                      className="h-8 pl-8 text-xs"
                    />
                    <datalist id="source-download-directory-options">
                      {availableDirectories.map((dir) => (
                        <option key={dir} value={dir} />
                      ))}
                    </datalist>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    下载的原文件将保存到指定子目录；留空则使用默认存储布局。
                  </p>
                </div>
              </div>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={formEnabled}
                onChange={(e) => setFormEnabled(e.target.checked)}
                className="rounded border-gray-300"
              />
              启用
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={!formName.trim() || !formSlug.trim()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null);
        }}
        title="删除来源"
        description={`确定要删除来源 "${deleteTarget?.name}" 吗？其名下的资源仍会保留，但与其关联的定位器/溯源记录将失去来源归属，已接受的条款记录及限流配额会被一并清除。此操作不可撤销。`}
        variant="destructive"
        confirmLabel="删除"
        onConfirm={handleDelete}
      />
    </div>
  );
}
