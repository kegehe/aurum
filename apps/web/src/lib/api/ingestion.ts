import { del, get, post, type PaginatedResponse } from '../api-client';
import type {
  CreateLinkImportData,
  IngestionJobItem,
  IngestionJobStats,
  ListIngestionJobsParams,
} from '../types';

export function createLinkImport(data: CreateLinkImportData): Promise<IngestionJobItem> {
  return post('/imports/link', data);
}

export function getIngestionJob(id: string): Promise<IngestionJobItem> {
  return get(`/ingestion/jobs/${id}`);
}

export function retryIngestionJob(id: string): Promise<IngestionJobItem> {
  return post(`/ingestion/jobs/${id}/retry`);
}

export function cancelIngestionJob(id: string): Promise<IngestionJobItem> {
  return post(`/ingestion/jobs/${id}/cancel`);
}

/** 导入任务列表（导入任务中心） */
export function listIngestionJobs(
  params?: ListIngestionJobsParams,
): Promise<PaginatedResponse<IngestionJobItem>> {
  return get('/ingestion/jobs', params as Record<string, unknown>);
}

/** 导入任务统计（各状态数量） */
export function getIngestionJobStats(): Promise<IngestionJobStats> {
  return get('/ingestion/stats');
}

/** 删除指定已结束（terminal）的导入任务记录 */
export function deleteIngestionJob(id: string): Promise<{ id: string; deleted: boolean }> {
  return del(`/ingestion/jobs/${id}`);
}

/** 清空所有已结束（terminal）的导入任务记录 */
export function clearIngestionJobs(): Promise<{ deleted: number }> {
  return del('/ingestion/jobs');
}
