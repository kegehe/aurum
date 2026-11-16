/**
 * AI 供应商配置相关类型
 */

/** 当前运行时可用的供应商解析结果（来自数据库生效配置或环境变量回退） */
export interface ResolvedAiProvider {
  /** 数据库配置 ID；环境变量回退时为 null（用量统计用于区分来源） */
  id?: string | null;
  provider: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  name?: string;
}

/** 对外返回的配置项（apiKey 已掩码） */
export interface AiProviderDto {
  id: string;
  name: string;
  provider: string;
  baseUrl: string | null;
  apiKey: string;
  hasApiKey: boolean;
  model: string;
  isActive: boolean;
  enabled: boolean;
  lastTestedAt: Date | null;
  lastTestStatus: 'ok' | 'error' | null;
  lastTestError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 连通性测试结果 */
export interface AiTestResult {
  success: boolean;
  latencyMs?: number;
  model?: string;
  message?: string;
  error?: string;
}

/** 当前生效配置摘要（供前端「设置 → AI 配置」页与健康检查使用） */
export interface AiProviderSummary {
  available: boolean;
  model: string;
  provider: string | null;
  name: string | null;
  /** db = 数据库生效配置；env = 回退到环境变量；null = 未配置 */
  source: 'db' | 'env' | null;
}

/** 掩码字符，用于判断前端回传的 apiKey 是否为未修改的掩码值 */
const MASK_CHAR = '•';

/** 将 API Key 掩码为 `sk-a••••••••1234` 形式，仅展示前后少量字符 */
export function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8)
    return `${MASK_CHAR}${MASK_CHAR}${MASK_CHAR}${MASK_CHAR}${MASK_CHAR}${MASK_CHAR}${MASK_CHAR}${MASK_CHAR}`;
  return `${key.slice(0, 4)}${MASK_CHAR}${MASK_CHAR}${MASK_CHAR}${MASK_CHAR}${MASK_CHAR}${MASK_CHAR}${MASK_CHAR}${MASK_CHAR}${key.slice(-4)}`;
}

/** 判断前端回传的 apiKey 是否为掩码值（含掩码字符或为空） */
export function isMaskedKey(value?: string | null): boolean {
  if (!value) return true;
  return value.includes(MASK_CHAR) || /^\*+$/.test(value.trim());
}

/**
 * 归一化 Base URL
 * Anthropic SDK 会在 baseURL 后追加 /v1/messages，因此：
 * - 去首尾空白与结尾斜杠
 * - 去掉结尾 /v1/messages 或 /v1（用户可能粘贴完整端点），避免 SDK 拼接出 /v1/v1/messages
 */
export function normalizeBaseUrl(baseUrl?: string | null): string | undefined {
  if (!baseUrl) return undefined;
  let url = baseUrl.trim().replace(/\/+$/, '');
  url = url.replace(/\/v1\/messages$/, '').replace(/\/v1$/, '');
  return url || undefined;
}
