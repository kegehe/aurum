import { get, post, patch, del } from '../api-client';
import type { PaginatedResponse } from '../api-client';
import type { LicenseItem, LicenseDetail, CreateLicenseData, UpdateLicenseData } from '../types';

/** 许可证列表 */
export function listLicenses(params?: {
  requiresAttribution?: boolean;
  page?: number;
  pageSize?: number;
}): Promise<PaginatedResponse<LicenseItem>> {
  return get('/licenses', params as Record<string, unknown>);
}

/** 获取单个许可证 */
export function getLicense(id: string): Promise<LicenseDetail> {
  return get(`/licenses/${id}`);
}

/** 创建许可证 */
export function createLicense(data: CreateLicenseData): Promise<LicenseDetail> {
  return post('/licenses', data);
}

/** 更新许可证 */
export function updateLicense(id: string, data: UpdateLicenseData): Promise<LicenseDetail> {
  return patch(`/licenses/${id}`, data);
}

/** 删除许可证 */
export function deleteLicense(id: string): Promise<{ id: string; deleted: true }> {
  return del(`/licenses/${id}`);
}
