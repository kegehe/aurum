import { get } from '../api-client';
import type { StorageConsistencyReport } from '../types';

/**
 * 检查数据库记录与文件存储是否一致。
 *
 * 后端只读比对，不会删除或修复任何文件，因此可以放心反复触发。
 */
export function getConsistencyReport(): Promise<StorageConsistencyReport> {
  return get('/consistency/check');
}
