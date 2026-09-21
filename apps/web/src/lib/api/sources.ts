import { get, post, patch, del } from '../api-client';
import type { PaginatedResponse } from '../api-client';
import type { SourceItem, SourceDetail, CreateSourceData, UpdateSourceData, IngestionJobItem } from '../types';
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

/** 获取单个来源 */
export function getSource(id: string): Promise<SourceDetail> {
  return get(`/sources/${id}`);
}

/** 创建来源 */
export function createSource(data: CreateSourceData): Promise<SourceDetail> {
  return post('/sources', data);
}

/** 更新来源 */
export function updateSource(id: string, data: UpdateSourceData): Promise<SourceDetail> {
  return patch(`/sources/${id}`, data);
}

/** 列出可选的下载目录（已有来源目录 + 存储根下的自定义目录） */
export function listSourceDownloadDirectories(): Promise<string[]> {
  return get('/sources/directories');
}

/** 删除来源 */
export function deleteSource(id: string): Promise<{ id: string; deleted: true }> {
  return del(`/sources/${id}`);
}

/** 触发来源同步 */
export function syncSource(sourceId: string): Promise<IngestionJobItem> {
  return post(`/imports/sources/${sourceId}/sync`);
}

/** 获取单个 ingestion 任务（同步后轮询结果用） */
export function getIngestionJob(jobId: string): Promise<IngestionJobItem> {
  return get(`/ingestion/jobs/${jobId}`);
}
