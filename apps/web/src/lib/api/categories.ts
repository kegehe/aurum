import { get, post, patch, del } from '../api-client';
import type {
  CategoryTreeNode,
  CategoryItem,
  CreateCategoryData,
  UpdateCategoryData,
} from '../types';

/** 分类树 */
export function listCategories(): Promise<{ items: CategoryTreeNode[] }> {
  return get('/categories');
}

/** 创建分类 */
export function createCategory(data: CreateCategoryData): Promise<CategoryItem> {
  return post('/categories', data);
}

/** 更新分类 */
export function updateCategory(id: string, data: UpdateCategoryData): Promise<CategoryItem> {
  return patch(`/categories/${id}`, data);
}

/** 删除分类 */
export function deleteCategory(id: string): Promise<{ id: string; deleted: true }> {
  return del(`/categories/${id}`);
}
