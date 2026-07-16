import { get, post, patch, del } from '../api-client';
import type {
  CollectionItem,
  CollectionDetail,
  CreateCollectionData,
  UpdateCollectionData,
} from '../types';

/** 集合列表（含封面和资源数量） */
export function listCollections(): Promise<{ items: CollectionItem[] }> {
  return get('/collections');
}

/** 集合详情（含资源） */
export function getCollection(id: string): Promise<CollectionDetail> {
  return get(`/collections/${id}`);
}

/** 创建集合 */
export function createCollection(data: CreateCollectionData): Promise<CollectionItem> {
  return post('/collections', data);
}

/** 更新集合 */
export function updateCollection(id: string, data: UpdateCollectionData): Promise<CollectionItem> {
  return patch(`/collections/${id}`, data);
}

/** 删除集合（软删除） */
export function deleteCollection(id: string): Promise<CollectionItem> {
  return del(`/collections/${id}`);
}

/** 添加资源到集合 */
export function addResourceToCollection(
  collectionId: string,
  resourceId: string,
): Promise<{ collectionId: string; resourceId: string; action: string }> {
  return post(`/collections/${collectionId}/resources/${resourceId}`);
}

/** 从集合移除资源 */
export function removeResourceFromCollection(
  collectionId: string,
  resourceId: string,
): Promise<{ collectionId: string; resourceId: string; action: string }> {
  return del(`/collections/${collectionId}/resources/${resourceId}`);
}

/** 批量添加资源到集合 */
export function batchAddToCollection(
  collectionId: string,
  resourceIds: string[],
): Promise<{ collectionId: string; resourceIds: string[]; added: number }> {
  return post(`/collections/${collectionId}/resources`, { resourceIds });
}

/** 更新集合内资源排序 */
export function updateCollectionResourceSort(
  collectionId: string,
  resourceId: string,
  sortOrder: number,
): Promise<{ collectionId: string; resourceId: string; sortOrder: number }> {
  return patch(`/collections/${collectionId}/resources/${resourceId}/sort`, { sortOrder });
}
