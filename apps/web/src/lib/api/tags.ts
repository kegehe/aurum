import { get, post, patch, del } from '../api-client';
import type { TagWithUsage, TagItem, CreateTagData, UpdateTagData } from '../types';

/** 标签列表（含使用次数） */
export function listTags(): Promise<{ items: TagWithUsage[] }> {
  return get('/tags');
}

/** 创建标签 */
export function createTag(data: CreateTagData): Promise<TagItem> {
  return post('/tags', data);
}

/** 更新标签 */
export function updateTag(id: string, data: UpdateTagData): Promise<TagItem> {
  return patch(`/tags/${id}`, data);
}

/** 删除标签 */
export function deleteTag(id: string): Promise<{ id: string; deleted: true; previousUsage: number }> {
  return del(`/tags/${id}`);
}
