import { upload, get, post } from '../api-client';
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

/**
 * 清除后端 AI 降级缓存，返回清除后的可用性。
 *
 * 注意它**不实际调用 AI**：真正重新尝试发生在下一次分析请求里。
 * 这里只是让退避窗口提前失效，用户不必干等（降级期内后端不会自动再调 AI）。
 */
export function retryStyleAi(): Promise<StyleHealth> {
  return post<StyleHealth>('/style/ai-retry');
}
