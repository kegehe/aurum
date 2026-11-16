import { get, post, patch, del } from '../api-client';
import type { PaginatedResponse } from '../api-client';
import type {
  SourceItem,
  SourceDetail,
  CreateSourceData,
  UpdateSourceData,
  IngestionJobItem,
} from '../types';
import { listIngestionJobs } from './ingestion';
export { cancelIngestionJob } from './ingestion';

export { listIngestionJobs };

/** 来源列表 */
export function listSources(params?: {
  enabled?: boolean;
  sourceType?: string;
  page?: number;
  pageSize?: number;
}): Promise<PaginatedResponse<SourceItem>> {
  return get('/sources', params as Record<string, unknown>);
}

/** 创建来源 */
export function createSource(data: CreateSourceData): Promise<SourceDetail> {
  return post('/sources', data);
}

/** 更新来源 */
export function updateSource(id: string, data: UpdateSourceData): Promise<SourceDetail> {
  return patch(`/sources/${id}`, data);
}

/** 删除来源 */
export function deleteSource(id: string): Promise<{ id: string; deleted: true }> {
  return del(`/sources/${id}`);
}

/** 触发来源同步 */
export function syncSource(sourceId: string): Promise<IngestionJobItem> {
  return post(`/imports/sources/${sourceId}/sync`);
}

/**
 * 清除来源的下载记录（远端条目台账）。
 *
 * 台账让「已下载过的条目」在资源被彻底删除后也不会被重复下载；
 * 清除后下次同步会重新抓取并下载这些条目。
 */
export function clearSyncHistory(
  sourceId?: string,
): Promise<{ deleted: number; cursorReset: boolean }> {
  const qs = sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : '';
  return del(`/ingestion/sync-history${qs}`);
}

/** 获取单个 ingestion 任务（同步后轮询结果用） */
export function getIngestionJob(jobId: string): Promise<IngestionJobItem> {
  return get(`/ingestion/jobs/${jobId}`);
}
