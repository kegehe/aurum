/**
 * AI 用量统计相关类型
 *
 * 记录粒度：一次上游模型 HTTP 请求 = 一行（与「用户点了一次分析」区分：
 * 结构化输出的三级降级可能产生多次请求，失败请求也会计入，因此请求次数
 * 反映的是真实上游调用量与网关可靠性）。
 */
import type { ResolvedAiProvider } from '../ai-settings/ai-provider.types';

/** 目前会调用 AI 的功能点。新增调用点时必须同步扩展这里。 */
export type AiFeature = 'style.analyze' | 'style.variations' | 'design.generate' | 'design.repair';

/** Anthropic usage 的结构子集（避免统计模块直接依赖 SDK 类型） */
export interface AiTokenUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface AiUsageRecordInput {
  feature: AiFeature;
  provider: ResolvedAiProvider | null;
  /** 实际模型名（优先取响应中的 model） */
  model: string;
  usage?: AiTokenUsage | null;
  latencyMs: number;
  /** 有值表示本次请求失败 */
  error?: unknown;
}

export interface AiUsageTotals {
  requests: number;
  success: number;
  failed: number;
  /** 客户端断开导致的取消：不计入 failed，也不进成功率分母 */
  canceled: number;
  /** 0-100，保留一位小数；分母为已完成请求（成功 + 失败） */
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** 输入 + 输出（不含缓存 token，缓存单独展示） */
  totalTokens: number;
  avgLatencyMs: number;
}

export interface AiUsageSeriesPoint {
  /** 本地日期 YYYY-MM-DD */
  date: string;
  requests: number;
  failed: number;
  canceled: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export interface AiUsageFeatureItem {
  feature: string;
  requests: number;
  failed: number;
  canceled: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
}

export interface AiUsageModelItem {
  model: string;
  requests: number;
  failed: number;
  canceled: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AiUsageLogItem {
  id: string;
  provider: string;
  providerId: string | null;
  providerName: string | null;
  model: string;
  feature: string;
  status: string;
  errorKind: string | null;
  errorMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  latencyMs: number;
  createdAt: Date;
}

export interface AiUsageOverview {
  range: {
    days: number;
    from: string;
    to: string;
  };
  totals: AiUsageTotals;
  /** 按天补齐，范围内无调用的日期也会出现（值为 0） */
  series: AiUsageSeriesPoint[];
  features: AiUsageFeatureItem[];
  models: AiUsageModelItem[];
  /** 范围内最近 20 条明细 */
  recent: AiUsageLogItem[];
}
