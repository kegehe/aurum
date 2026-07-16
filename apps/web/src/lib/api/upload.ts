import { upload } from '../api-client';
import type { UploadResult, BatchUploadResult } from '../types';

/** 单文件上传 */
export function uploadFile(
  file: File,
  metadata?: Record<string, string>,
): Promise<UploadResult> {
  const formData = new FormData();
  formData.append('file', file);
  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      formData.append(key, value);
    }
  }
  return upload<UploadResult>('/upload', formData);
}

/** 批量上传（最多 20 个文件） */
export function uploadBatch(
  files: File[],
  metadata?: Record<string, string>,
): Promise<BatchUploadResult> {
  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file);
  }
  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      formData.append(key, value);
    }
  }
  return upload<BatchUploadResult>('/upload/batch', formData);
}
