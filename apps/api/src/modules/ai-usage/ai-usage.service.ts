import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AiUsageFeatureItem,
  AiUsageLogItem,
  AiUsageModelItem,
  AiUsageOverview,
  AiUsageRecordInput,
  AiUsageSeriesPoint,
  AiUsageTotals,
} from './ai-usage.types';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const RECENT_LIMIT = 20;
const ERROR_MESSAGE_LIMIT = 500;

/** 查询用到的字段子集（避免把 errorMessage 等大字段读进内存） */
interface UsageRow {
  createdAt: Date;
  feature: string;
  model: string;
  status: string;
  errorKind: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  latencyMs: number;
}

/**
 * AI 用量统计
 *
 * - record()：每次上游请求结束后写入一行，fire-and-forget，绝不阻塞或影响业务
 * - getOverview()：按天补齐的序列 + 功能/模型聚合 + 最近明细
 *
 * 聚合放在应用层而不是 SQL：开发库是 SQLite、生产目标是 PostgreSQL，按日分组
 * 的 SQL 方言不一致；本项目为单机自托管，量级有限，一次查询最近 N 天的明细
 * 足够快。若未来日调用量达到十万级，再改为按天预聚合表。
 */
@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ==================== 写入 ====================

  /**
   * 记录一次上游模型请求。
   *
   * 失败请求也会落库（token 为 0）：请求次数、成功率按真实 HTTP 调用计算，
   * 结构化输出的降级重试同样可见。
   */
  record(input: AiUsageRecordInput): void {
    try {
      const data = {
        provider: input.provider?.provider ?? 'unknown',
        providerId: input.provider?.id ?? null,
        providerName: input.provider?.name ?? null,
        model: input.model || input.provider?.model || 'unknown',
        feature: input.feature,
        status: input.error ? 'error' : 'success',
        errorKind: input.error ? classifyError(input.error) : null,
        errorMessage: input.error
          ? sanitizeErrorMessage(describeError(input.error)).slice(0, ERROR_MESSAGE_LIMIT)
          : null,
        inputTokens: tokenCount(input.usage?.input_tokens),
        outputTokens: tokenCount(input.usage?.output_tokens),
        cacheReadTokens: tokenCount(input.usage?.cache_read_input_tokens),
        cacheCreationTokens: tokenCount(input.usage?.cache_creation_input_tokens),
        latencyMs: Number.isFinite(input.latencyMs) ? Math.max(0, Math.round(input.latencyMs)) : 0,
      };

      // 统计失败不能影响主流程：异步失败只记日志，不向外抛。
      void this.prisma.aiUsageLog.create({ data }).catch((error) => {
        this.logger.warn(
          `写入 AI 用量失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    } catch (error) {
      // 兜底同步异常（例如 Prisma Client 尚未生成、错误对象无法转字符串），
      // 同样绝不能把异常抛回 AI 调用链。
      this.logger.warn(
        `记录 AI 用量失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ==================== 查询 ====================

  async getOverview(rawDays?: number): Promise<AiUsageOverview> {
    const days = normalizeDays(rawDays);
    const now = new Date();
    const from = startOfLocalDay(addLocalDays(now, -(days - 1)));

    const [rows, recent] = await Promise.all([
      this.prisma.aiUsageLog.findMany({
        where: { createdAt: { gte: from, lte: now } },
        orderBy: { createdAt: 'asc' },
        select: {
          createdAt: true,
          feature: true,
          model: true,
          status: true,
          errorKind: true,
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheCreationTokens: true,
          latencyMs: true,
        },
      }),
      this.prisma.aiUsageLog.findMany({
        where: { createdAt: { gte: from, lte: now } },
        orderBy: { createdAt: 'desc' },
        take: RECENT_LIMIT,
        select: {
          id: true,
          provider: true,
          providerId: true,
          providerName: true,
          model: true,
          feature: true,
          status: true,
          errorKind: true,
          errorMessage: true,
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheCreationTokens: true,
          latencyMs: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      range: { days, from: from.toISOString(), to: now.toISOString() },
      totals: this.aggregateTotals(rows),
      series: this.buildSeries(rows, from, days),
      features: this.aggregateFeatures(rows),
      models: this.aggregateModels(rows),
      recent: recent.map(toLogItem),
    };
  }

  private aggregateTotals(rows: UsageRow[]): AiUsageTotals {
    const totals: AiUsageTotals = {
      requests: 0,
      success: 0,
      failed: 0,
      canceled: 0,
      successRate: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      avgLatencyMs: 0,
    };
    let latencySum = 0;

    for (const row of rows) {
      totals.requests += 1;
      if (row.status === 'success') totals.success += 1;
      else if (isCanceled(row)) totals.canceled += 1;
      else totals.failed += 1;
      totals.inputTokens += row.inputTokens;
      totals.outputTokens += row.outputTokens;
      totals.cacheReadTokens += row.cacheReadTokens;
      totals.cacheCreationTokens += row.cacheCreationTokens;
      totals.totalTokens += row.inputTokens + row.outputTokens;
      latencySum += row.latencyMs;
    }

    // 客户端主动断开不是上游故障：从成功率分母里剔除，避免"取消"拉低可靠性指标
    const completed = totals.success + totals.failed;
    totals.successRate = completed === 0 ? 0 : Math.round((totals.success / completed) * 1000) / 10;
    totals.avgLatencyMs = totals.requests === 0 ? 0 : Math.round(latencySum / totals.requests);
    return totals;
  }

  /** 按天补齐空桶，保证图表 X 轴连续（无调用的日期显示 0，而不是断点） */
  private buildSeries(rows: UsageRow[], from: Date, days: number): AiUsageSeriesPoint[] {
    const buckets = new Map<string, AiUsageSeriesPoint>();
    for (let i = 0; i < days; i += 1) {
      const date = localDateKey(addLocalDays(from, i));
      buckets.set(date, {
        date,
        requests: 0,
        failed: 0,
        canceled: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
      });
    }

    for (const row of rows) {
      const bucket = buckets.get(localDateKey(row.createdAt));
      if (!bucket) continue;
      bucket.requests += 1;
      if (row.status !== 'success') {
        if (isCanceled(row)) bucket.canceled += 1;
        else bucket.failed += 1;
      }
      bucket.inputTokens += row.inputTokens;
      bucket.outputTokens += row.outputTokens;
      bucket.cacheReadTokens += row.cacheReadTokens;
      bucket.totalTokens += row.inputTokens + row.outputTokens;
    }

    return [...buckets.values()];
  }

  private aggregateFeatures(rows: UsageRow[]): AiUsageFeatureItem[] {
    const buckets = new Map<string, AiUsageFeatureItem & { latencySum: number }>();
    for (const row of rows) {
      const item = buckets.get(row.feature) ?? {
        feature: row.feature,
        requests: 0,
        failed: 0,
        canceled: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        avgLatencyMs: 0,
        latencySum: 0,
      };
      item.requests += 1;
      if (row.status !== 'success') {
        if (isCanceled(row)) item.canceled += 1;
        else item.failed += 1;
      }
      item.inputTokens += row.inputTokens;
      item.outputTokens += row.outputTokens;
      item.totalTokens += row.inputTokens + row.outputTokens;
      item.latencySum += row.latencyMs;
      buckets.set(row.feature, item);
    }

    return [...buckets.values()]
      .map(({ latencySum, ...item }) => ({
        ...item,
        avgLatencyMs: item.requests === 0 ? 0 : Math.round(latencySum / item.requests),
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests);
  }

  private aggregateModels(rows: UsageRow[]): AiUsageModelItem[] {
    const buckets = new Map<string, AiUsageModelItem>();
    for (const row of rows) {
      const item = buckets.get(row.model) ?? {
        model: row.model,
        requests: 0,
        failed: 0,
        canceled: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };
      item.requests += 1;
      if (row.status !== 'success') {
        if (isCanceled(row)) item.canceled += 1;
        else item.failed += 1;
      }
      item.inputTokens += row.inputTokens;
      item.outputTokens += row.outputTokens;
      item.totalTokens += row.inputTokens + row.outputTokens;
      buckets.set(row.model, item);
    }

    return [...buckets.values()].sort(
      (a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests,
    );
  }
}

// ==================== 工具 ====================

function normalizeDays(value?: number): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(1, Math.floor(value)));
}

function startOfLocalDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function addLocalDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/** 本地日期 key：统计口径与用户看到的「今天」一致，避免 UTC 跨日错位 */
function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function tokenCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

/** 客户端断开会落库为 error + errorKind=canceled，统计时从失败里剥离 */
function isCanceled(row: { status: string; errorKind: string | null }): boolean {
  return row.status !== 'success' && row.errorKind === 'canceled';
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 错误摘要会落库并展示在统计页，先抹掉常见的密钥形态。
 * 不追求完备，只覆盖 Anthropic / 兼容网关最常回显的两种写法。
 */
function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***');
}

/**
 * 失败分类，与样式模块的 AiFailureKind 保持同名。
 * 用鸭子类型读取 status，避免让统计模块依赖 Anthropic SDK。
 */
function classifyError(error: unknown): string {
  // 浏览器断开 SSE 会 abort 上游请求：这不是上游故障，单独归类，避免污染失败率。
  if (
    (error instanceof Error && error.name === 'AbortError') ||
    /abort/i.test(describeError(error))
  ) {
    return 'canceled';
  }

  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') {
    if (status === 429) return 'rate_limit';
    if (status === 401 || status === 403) return 'auth';
    if (status >= 500) return 'connectivity';
    return 'output';
  }

  const message = describeError(error);
  if (/ECONN|ETIMEDOUT|EAI_AGAIN|socket|timeout|network|fetch failed/i.test(message)) {
    return 'connectivity';
  }
  if (/rate.?limit|too many requests/i.test(message)) return 'rate_limit';
  if (/unauthorized|invalid.?api.?key|authentication/i.test(message)) return 'auth';
  return 'unknown';
}

function toLogItem(row: AiUsageLogItem): AiUsageLogItem {
  return {
    id: row.id,
    provider: row.provider,
    providerId: row.providerId,
    providerName: row.providerName,
    model: row.model,
    feature: row.feature,
    status: row.status,
    errorKind: row.errorKind,
    errorMessage: row.errorMessage,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    latencyMs: row.latencyMs,
    createdAt: row.createdAt,
  };
}
