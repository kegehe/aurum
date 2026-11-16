import { get, patch, del, post, BASE_URL, type PaginatedResponse } from '../api-client';
import type {
  ResourceListItem,
  ResourceDetail,
  UpdateResourceData,
  SearchResourcesParams,
  IngestionJobItem,
  EmptyTrashProgress,
  EmptyTrashResult,
  TrashStats,
} from '../types';

/** 资源列表（分页 + 搜索 + 筛选 + 排序） */
export function listResources(
  params?: SearchResourcesParams,
): Promise<PaginatedResponse<ResourceListItem>> {
  return get('/resources', params as Record<string, unknown>);
}

/**
 * 当前筛选范围内的全部资源 ID（不分页）。
 * “全选当前目录”靠它一次请求拿到完整选择集，不需要按页循环请求。
 */
export function listResourceIds(
  params?: SearchResourcesParams,
): Promise<{ ids: string[]; total: number }> {
  return get('/resources/ids', params as Record<string, unknown>);
}

/** 资源详情 */
export function getResource(id: string): Promise<ResourceDetail> {
  return get(`/resources/${id}`);
}

/**
 * 相邻资源导航：在相同筛选/排序上下文（关键字、类型、分类、来源、排序）中
 * 返回当前资源的上一个/下一个资源 ID，用于详情页左右箭头快速切换。
 */
export function getResourceNeighbors(
  id: string,
  params?: SearchResourcesParams,
): Promise<{
  previousId: string | null;
  nextId: string | null;
  currentIndex: number | null;
  total: number;
}> {
  return get(`/resources/${encodeURIComponent(id)}/neighbors`, params as Record<string, unknown>);
}

/** 更新资源元数据 */
export function updateResource(id: string, data: UpdateResourceData): Promise<ResourceListItem> {
  return patch(`/resources/${id}`, data);
}

export function batchSetResourceCategory(
  resourceIds: string[],
  categoryId: string | null,
): Promise<{ resourceIds: string[]; categoryId: string | null; updated: number; failed: number }> {
  return post('/resources/batch/category', { resourceIds, categoryId });
}

export function batchSetResourceFavorite(
  resourceIds: string[],
  isFavorite: boolean,
): Promise<{ resourceIds: string[]; isFavorite: boolean; updated: number; failed: number }> {
  return post('/resources/batch/favorite', { resourceIds, isFavorite });
}

export function batchDeleteResources(
  resourceIds: string[],
): Promise<{ resourceIds: string[]; deleted: number; failed: number }> {
  return post('/resources/batch/delete', { resourceIds });
}

/** 服务端通过响应头回传的打包结果；头被代理剥离时为 null（未知），不能当作 0 */
interface ResourceZipCounts {
  /** 实际打包进 ZIP 的资源数（只有带本地原文件的资源才会入包）；未知时为 null */
  foundResources: number | null;
  /** 因无本地原文件或已不存在而被跳过的资源数；未知时为 null */
  missingResources: number | null;
}

export interface ZipDownloadProgress {
  /** 已写入磁盘的字节数（流式下载时才有） */
  loadedBytes: number;
}

export type ZipDownloadResult =
  /** 边接收边写盘完成 */
  | ({ mode: 'saved' } & ResourceZipCounts)
  /** 用户取消了保存对话框，或中途取消了下载 */
  | { mode: 'cancelled' }
  /** 浏览器不支持流式写盘，已交给浏览器原生下载（进度与取消在浏览器的下载列表里） */
  | { mode: 'browser' };

export interface ZipDownloadOptions {
  /** 保存对话框里建议的文件名 */
  filename: string;
  signal?: AbortSignal;
  onProgress?: (progress: ZipDownloadProgress) => void;
}

/** File System Access API 的 showSaveFilePicker（TS 的 lib.dom 尚未内置声明） */
interface SaveFilePicker {
  (options?: {
    suggestedName?: string;
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
  }): Promise<FileSystemFileHandle>;
}

function getSaveFilePicker(): SaveFilePicker | null {
  if (typeof window === 'undefined') return null;
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  return typeof picker === 'function' ? picker : null;
}

/**
 * 浏览器是否支持边下载边写盘（File System Access API）。
 * 不支持时批量下载退化为浏览器原生下载，同样不会把整包读进 JS 内存。
 */
export function canStreamZipToDisk(): boolean {
  return getSaveFilePicker() !== null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

async function readZipErrorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { message?: string | string[] } | null;
  const message = Array.isArray(body?.message) ? body.message.join('，') : body?.message;
  return message?.trim() || response.statusText || '批量下载失败';
}

function readZipCounts(response: Response, requested: number): ResourceZipCounts {
  const readCount = (name: string): number | null => {
    const raw = response.headers.get(name);
    if (raw === null || raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : null;
  };
  const foundResources = readCount('X-Resource-Found-Count');
  const missingResources = readCount('X-Resource-Missing-Count');

  // 两个头都没有（反向代理剥离、旧版 API）→ 保持“未知”。绝不能回退成
  // “requested 个全部成功”——那会在资源被跳过时给出完全相反的结论。
  if (foundResources === null && missingResources === null) {
    return { foundResources: null, missingResources: null };
  }
  // 只缺一个头时用另一个推算：服务端按请求里的资源总数统计。
  if (foundResources === null) {
    return {
      foundResources: Math.max(0, requested - (missingResources ?? 0)),
      missingResources,
    };
  }
  if (missingResources === null) {
    return {
      foundResources,
      missingResources: Math.max(0, requested - foundResources),
    };
  }
  return { foundResources, missingResources };
}

/** 把响应的字节流原样写进磁盘，逐块 await 写盘以形成背压，内存里只留一个分片 */
async function writeZipStream(
  body: ReadableStream<Uint8Array>,
  writable: FileSystemWritableFileStream,
  options: ZipDownloadOptions,
): Promise<void> {
  const reader = body.getReader();
  let loadedBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      loadedBytes += value.byteLength;
      options.onProgress?.({ loadedBytes });
    }
    await writable.close();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
}

/**
 * 用隐藏表单 POST 触发浏览器原生下载。
 * 响应流由浏览器自己写盘，JS 里不保留任何分片，因此选中几 GB 资源也不会撑爆内存；
 * 进度与取消都交给浏览器的下载列表。
 */
function startBrowserZipDownload(resourceIds: string[]): void {
  if (typeof document === 'undefined') return;

  const target = 'aurum-zip-download';
  if (!document.querySelector(`iframe[name="${target}"]`)) {
    const frame = document.createElement('iframe');
    frame.name = target;
    frame.hidden = true;
    frame.setAttribute('aria-hidden', 'true');
    document.body.appendChild(frame);
  }

  const form = document.createElement('form');
  form.method = 'POST';
  form.action = `${BASE_URL}/resources/batch/download`;
  form.target = target;
  form.hidden = true;

  // 全部 ID 放进一个字段：urlencoded 里“一个 ID 一个参数”，
  // 选中上千个资源会撞上服务端解析器的参数条数上限（413），整个下载就静默失败了
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'resourceIds';
  input.value = resourceIds.join(',');
  form.appendChild(input);

  document.body.appendChild(form);
  form.submit();
  form.remove();
}

/**
 * 批量下载原文件 ZIP。
 *
 * 边接收边写盘：不把压缩包读进内存，中途可看进度、可取消。
 * 浏览器不支持 File System Access API 时退化为原生表单下载（同样不占内存）。
 */
export async function downloadResourcesZip(
  resourceIds: string[],
  options: ZipDownloadOptions,
): Promise<ZipDownloadResult> {
  const picker = getSaveFilePicker();
  if (!picker) {
    startBrowserZipDownload(resourceIds);
    return { mode: 'browser' };
  }

  // 注意：picker 必须在用户手势里同步调用，调用方不能先 await 网络请求
  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await picker({
      suggestedName: options.filename,
      types: [{ description: 'ZIP 压缩包', accept: { 'application/zip': ['.zip'] } }],
    });
  } catch (error) {
    if (isAbortError(error)) return { mode: 'cancelled' };
    throw error;
  }

  // 先确认服务端能打包、拿到数量，再去动用户选的文件：
  // 服务端拒绝时不该让保存位置上的文件被截断
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/resources/batch/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceIds }),
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) return { mode: 'cancelled' };
    throw error;
  }
  if (!response.ok) throw new Error(await readZipErrorMessage(response));
  if (!response.body) throw new Error('当前浏览器不支持流式接收响应');
  // 服务端按去重后的 ID 统计；这里也用去重数量推算，避免重复 ID 让缺失数偏小
  const counts = readZipCounts(response, new Set(resourceIds).size);
  const body = response.body;

  let writable: FileSystemWritableFileStream;
  try {
    writable = await fileHandle.createWritable();
  } catch (error) {
    // 拿不到写句柄就别继续往浏览器里拉整个压缩包
    await body.cancel().catch(() => {});
    throw error;
  }

  try {
    await writeZipStream(body, writable, options);
  } catch (error) {
    // 中途失败或被取消：丢弃写了一半的内容，避免留下一个损坏的 zip
    await writable.abort().catch(() => {});
    if (options.signal?.aborted) return { mode: 'cancelled' };
    throw error;
  }
  return { mode: 'saved', ...counts };
}

/** 软删除（移到回收站） */
export function softDeleteResource(id: string): Promise<{ id: string; deletedAt: string }> {
  return del(`/resources/${id}`);
}

/** 从回收站恢复 */
export function restoreResource(id: string): Promise<{ id: string; deletedAt: string | null }> {
  return post(`/resources/${id}/restore`);
}

/** 批量从回收站恢复：一次请求恢复多个资源，并返回未恢复成功的资源 ID */
export function batchRestoreResources(resourceIds: string[]): Promise<{
  resourceIds: string[];
  restored: number;
  failed: number;
  failedResourceIds: string[];
}> {
  return post('/resources/batch/restore', { resourceIds });
}

/** 彻底删除（仅限回收站内资源）。deleted=false 表示记录刚被并发恢复/删除。 */
export function permanentDeleteResource(
  id: string,
): Promise<{ id: string; deleted: boolean; deletedFiles: number }> {
  return del(`/resources/${id}/permanent`);
}

/** 回收站统计：已删除资源数 / 可回收文件数 / 可释放空间 */
export function getTrashStats(): Promise<TrashStats> {
  return get('/resources/trash/stats');
}

/**
 * 清空回收站并实时接收进度（fetch + SSE）
 *
 * 后端按资源逐条删除并推送 progress 事件，全部完成后推送 done；
 * 删除中途失败推送 error。返回值是最终统计。
 */
export async function emptyTrashStream(
  handlers: {
    onProgress?: (progress: EmptyTrashProgress) => void;
  },
  signal?: AbortSignal,
): Promise<EmptyTrashResult> {
  const response = await fetch(`${BASE_URL}/resources/trash/empty/stream`, {
    method: 'POST',
    signal,
  });

  if (!response.ok) {
    let message = `清空回收站失败（${response.status}）`;
    try {
      const body = (await response.json()) as { message?: string | string[] };
      if (body?.message) {
        message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
      }
    } catch {
      // 非 JSON 错误体：保留默认文案
    }
    throw new Error(message);
  }
  if (!response.body) throw new Error('浏览器不支持流式响应');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: EmptyTrashResult | null = null;
  let failure: string | null = null;

  const dispatch = (block: string) => {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    let data: unknown;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    if (event === 'progress') {
      handlers.onProgress?.(data as EmptyTrashProgress);
    } else if (event === 'done') {
      result = data as EmptyTrashResult;
    } else if (event === 'error') {
      failure = (data as { message?: string }).message ?? '清空回收站失败';
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (block.trim()) dispatch(block);
      index = buffer.indexOf('\n\n');
    }
  }
  if (buffer.trim()) dispatch(buffer);

  if (failure) throw new Error(failure);
  // 流正常结束但没有 done：可能是网络中断，前端需提示重新确认实际结果
  if (!result) throw new Error('连接中断，请刷新页面确认回收站状态');
  return result;
}

/** 重新处理 */
export function reprocessResource(id: string): Promise<{ id: string; processingStatus: string }> {
  return post(`/resources/${id}/reprocess`);
}

/** 资源下载 URL */
export function getResourceDownloadUrl(id: string): string {
  return `${BASE_URL}/resources/${encodeURIComponent(id)}/download`;
}

/**
 * 原图预览 URL（浏览器内联显示）。
 * maxEdge 仅对静态图片生效：后端会缩放成 WebP；动图/非图片忽略该参数。
 */
export function getResourcePreviewUrl(id: string, maxEdge?: number): string {
  const base = `${BASE_URL}/resources/${encodeURIComponent(id)}/preview`;
  return maxEdge ? `${base}?max=${maxEdge}` : base;
}

/** 缩略图 URL（WebP，用于卡片/列表） */
export function getResourceThumbnailUrl(id: string): string {
  return `${BASE_URL}/resources/${encodeURIComponent(id)}/thumbnail`;
}

/** 派生文件（页面快照等）下载地址 */
export function getResourceFileDownloadUrl(id: string, role: string): string {
  return `${BASE_URL}/resources/${encodeURIComponent(id)}/files/${encodeURIComponent(role)}/download`;
}

/** 手动触发资源定位器健康检查 */
export function checkResourceLocators(id: string): Promise<{ jobs: unknown[]; message: string }> {
  return post(`/resources/${id}/locators/check`);
}

/** 批量镜像时单个资源被跳过的原因 */
export type BatchMirrorSkipReason =
  'not_found' | 'deleted' | 'already_local' | 'no_source_url' | 'no_source' | 'policy' | 'error';

export interface BatchMirrorResult {
  resourceIds: string[];
  /** 成功加入下载队列（含此前已在队列中）的资源数 */
  queued: number;
  skipped: number;
  skippedResources: Array<{ id: string; reason: BatchMirrorSkipReason; message: string }>;
}

/**
 * 批量把选中的远程资源下载到本地。
 * 逐条复用单资源的入队与来源策略门禁，单个资源被拒绝不影响其余资源。
 */
export function batchMirrorResources(resourceIds: string[]): Promise<BatchMirrorResult> {
  return post('/resources/batch/mirror', { resourceIds });
}

/** Queue a user-approved download of a remote resource into local storage. */
export function mirrorRemoteResource(id: string): Promise<IngestionJobItem> {
  return post(`/resources/${id}/mirror`);
}

/** 抓取资源页面的 HTML 快照 */
export function captureResourceSnapshot(id: string): Promise<IngestionJobItem> {
  return post(`/resources/${id}/snapshot`);
}
