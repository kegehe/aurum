import { get, patch, del, post, BASE_URL, type PaginatedResponse } from '../api-client';
import type {
  ResourceListItem,
  ResourceDetail,
  UpdateResourceData,
  SearchResourcesParams,
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

export function batchAddTagsToResources(
  resourceIds: string[],
  tagIds: string[],
): Promise<{ resourceIds: string[]; tagIds: string[]; added: number }> {
  return post('/resources/batch/tags/add', { resourceIds, tagIds });
}

export function batchRemoveTagsFromResources(
  resourceIds: string[],
  tagIds: string[],
): Promise<{ resourceIds: string[]; tagIds: string[]; removed: number }> {
  return post('/resources/batch/tags/remove', { resourceIds, tagIds });
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
export function reprocessResource(
  id: string,
): Promise<{ id: string; processingStatus: string }> {
  return post(`/resources/${id}/reprocess`);
}

/** 为资源添加标签 */
export function addTagToResource(
  resourceId: string,
  tagId: string,
): Promise<{ resourceId: string; tagId: string; action: string }> {
  return post(`/resources/${resourceId}/tags/${tagId}`);
}

/** 从资源移除标签 */
export function removeTagFromResource(
  resourceId: string,
  tagId: string,
): Promise<{ resourceId: string; tagId: string; action: string }> {
  return del(`/resources/${resourceId}/tags/${tagId}`);
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
