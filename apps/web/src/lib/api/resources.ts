import { get, patch, del, post, BASE_URL, type PaginatedResponse } from '../api-client';
import type {
  ResourceListItem,
  ResourceDetail,
  UpdateResourceData,
  SearchResourcesParams,
  IngestionJobItem,
} from '../types';

/** 资源列表（分页 + 搜索 + 筛选 + 排序） */
export function listResources(
  params?: SearchResourcesParams,
): Promise<PaginatedResponse<ResourceListItem>> {
  return get('/resources', params as Record<string, unknown>);
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

export async function downloadResourcesZip(resourceIds: string[]): Promise<Blob> {
  const response = await fetch(`${BASE_URL}/resources/batch/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resourceIds }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.message ?? response.statusText);
  }
  return response.blob();
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
export function batchRestoreResources(
  resourceIds: string[],
): Promise<{
  resourceIds: string[];
  restored: number;
  failed: number;
  failedResourceIds: string[];
}> {
  return post('/resources/batch/restore', { resourceIds });
}

/** 彻底删除（仅限回收站内资源） */
export function permanentDeleteResource(
  id: string,
): Promise<{ id: string; deleted: true; deletedFiles: number }> {
  return del(`/resources/${id}/permanent`);
}

/** 清空回收站 */
export function emptyTrash(): Promise<{ deletedResources: number; deletedFiles: number }> {
  return del('/resources/trash/empty');
}

/** 重新处理 */
export function reprocessResource(id: string): Promise<{ id: string; processingStatus: string }> {
  return post(`/resources/${id}/reprocess`);
}

/** 资源下载 URL */
export function getResourceDownloadUrl(id: string): string {
  return `${BASE_URL}/resources/${encodeURIComponent(id)}/download`;
}

/** 原图预览 URL（浏览器内联显示） */
export function getResourcePreviewUrl(id: string): string {
  return `${BASE_URL}/resources/${encodeURIComponent(id)}/preview`;
}

/** 缩略图 URL（WebP，用于卡片/列表） */
export function getResourceThumbnailUrl(id: string): string {
  return `${BASE_URL}/resources/${encodeURIComponent(id)}/thumbnail`;
}

/** 手动触发资源定位器健康检查 */
export function checkResourceLocators(id: string): Promise<{ jobs: unknown[]; message: string }> {
  return post(`/resources/${id}/locators/check`);
}

/** Queue a user-approved download of a remote resource into local storage. */
export function mirrorRemoteResource(id: string): Promise<IngestionJobItem> {
  return post(`/resources/${id}/mirror`);
}
