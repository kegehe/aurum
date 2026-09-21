import { upload, get } from '../api-client';
import type { StyleAnalyzeResult, StyleHealth } from '../types';

/** 样式分析：上传图片 → StyleProfile + 布局变体 + 导出包 */
export function analyzeStyle(file: File): Promise<StyleAnalyzeResult> {
  const formData = new FormData();
  formData.append('image', file);
  return upload<StyleAnalyzeResult>('/style/analyze', formData);
}

/** AI 功能可用性 */
export function getStyleHealth(): Promise<StyleHealth> {
  return get<StyleHealth>('/style/health');
}
