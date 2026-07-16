import { get, post, patch, del } from '../api-client';
import type { PaginatedResponse } from '../api-client';
import type { SourceItem, SourceDetail, CreateSourceData, UpdateSourceData } from '../types';

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

/** 删除来源 */
export function deleteSource(id: string): Promise<{ id: string; deleted: true }> {
  return del(`/sources/${id}`);
}
