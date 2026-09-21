import { get, post, patch, del } from '../api-client';
import type {
  AiProviderItem,
  AiProviderSummary,
  AiTestResult,
  CreateAiProviderData,
  UpdateAiProviderData,
  TestAiProviderData,
} from '../types';

/** AI 配置列表（密钥已掩码） */
export function listAiProviders(): Promise<AiProviderItem[]> {
  return get('/ai-settings');
}

/** 获取单个 AI 配置 */
export function getAiProvider(id: string): Promise<AiProviderItem> {
  return get(`/ai-settings/${id}`);
}

/** 当前生效配置摘要（含环境变量回退状态） */
export function getAiSettingsSummary(): Promise<AiProviderSummary> {
  return get('/ai-settings/summary');
}

/** 创建 AI 配置 */
export function createAiProvider(data: CreateAiProviderData): Promise<AiProviderItem> {
  return post('/ai-settings', data);
}

/** 更新 AI 配置（apiKey 留空/掩码值表示不修改） */
export function updateAiProvider(id: string, data: UpdateAiProviderData): Promise<AiProviderItem> {
  return patch(`/ai-settings/${id}`, data);
}

/** 删除 AI 配置 */
export function deleteAiProvider(id: string): Promise<{ id: string; deleted: true }> {
  return del(`/ai-settings/${id}`);
}

/** 设为当前生效配置 */
export function activateAiProvider(id: string): Promise<AiProviderItem> {
  return post(`/ai-settings/${id}/activate`);
}

/** 测试已保存的配置并记录结果 */
export function testAiProvider(id: string): Promise<AiTestResult> {
  return post(`/ai-settings/${id}/test`);
}

/** 测试未保存的临时配置（表单内测试） */
export function testAiProviderConfig(data: TestAiProviderData): Promise<AiTestResult> {
  return post('/ai-settings/test', data);
}
