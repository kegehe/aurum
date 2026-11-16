/**
 * AI 供应商配置服务
 *
 * 职责：
 * - 运行时生效配置的解析：数据库生效配置 → 回退环境变量 ANTHROPIC_API_KEY
 * - 配置 CRUD、设为生效、连通性测试
 * - 提供给 ClaudeVisionClient 构建 Anthropic 客户端
 *
 * 生效配置缓存在内存中，任何 CRUD/激活/停用/删除操作后调用 refresh() 立即生效；
 * 另外定时轮询数据库，让 worker 等独立进程也能感知配置切换，无需重启。
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import Anthropic from '@anthropic-ai/sdk';
import { AiProviderRepository } from './repositories/ai-provider.repository';
import { CreateAiProviderDto } from './dto/create-ai-provider.dto';
import { UpdateAiProviderDto } from './dto/update-ai-provider.dto';
import { TestAiProviderDto } from './dto/test-ai-provider.dto';
import {
  AiProviderDto,
  AiProviderSummary,
  AiTestResult,
  ResolvedAiProvider,
  isMaskedKey,
  maskApiKey,
  normalizeBaseUrl,
} from './ai-provider.types';

/** API 与 worker 各自持有本服务实例，需要轮询才能同步配置变更 */
const AI_SETTINGS_REFRESH_INTERVAL_MS = 5_000;

@Injectable()
export class AiSettingsService implements OnModuleInit {
  private readonly logger = new Logger(AiSettingsService.name);
  private active: ResolvedAiProvider | null = null;
  private activeId: string | null = null;
  private refreshSeq = 0;
  private lastPollError: string | null = null;

  constructor(
    private readonly repo: AiProviderRepository,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    try {
      await this.refresh();
    } catch (error) {
      this.logger.error(
        `加载 AI 配置失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ==================== 运行时生效配置 ====================

  /**
   * 重新解析生效配置（数据库 → 环境变量回退）。
   * 任何配置变更后调用，使新配置立即生效。
   */
  async refresh(): Promise<void> {
    // 轮询与 CRUD 触发的刷新可能并发；只让最新一次刷新落地，
    // 避免旧快照在晚到时覆盖刚保存的配置。
    const seq = ++this.refreshSeq;
    const row = await this.repo.findActive();
    if (seq !== this.refreshSeq) return;
    if (row && row.enabled) {
      this.active = {
        id: row.id,
        provider: row.provider,
        apiKey: row.apiKey,
        baseUrl: row.baseUrl ?? undefined,
        model: row.model,
        name: row.name,
      };
      this.activeId = row.id;
      return;
    }

    // 回退到环境变量（保持旧行为：不改 .env 也能通过环境变量配置）
    const envKey = this.config.get<string>('ai.anthropicApiKey');
    if (envKey) {
      this.active = {
        id: null,
        provider: 'anthropic',
        apiKey: envKey,
        baseUrl: this.config.get<string>('ai.baseUrl') || undefined,
        model: this.config.get<string>('ai.styleModel') ?? 'claude-sonnet-5',
        name: '环境变量',
      };
      this.activeId = null;
      return;
    }

    this.active = null;
    this.activeId = null;
  }

  /**
   * 定时从数据库重读生效配置。
   * CRUD 触发的 refresh() 只刷新处理请求的那个进程；API 改完模型后，
   * worker 若继续用内存里的旧配置，设计任务会随机命中已下线的旧模型。
   */
  @Interval(AI_SETTINGS_REFRESH_INTERVAL_MS)
  async pollActiveProvider(): Promise<void> {
    try {
      await this.refresh();
      this.lastPollError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.lastPollError) {
        this.logger.warn(`定时刷新 AI 配置失败: ${message}`);
        this.lastPollError = message;
      }
    }
  }

  get activeProvider(): ResolvedAiProvider | null {
    return this.active;
  }

  get available(): boolean {
    return !!this.active;
  }

  get modelName(): string {
    return this.active?.model ?? 'claude-sonnet-5';
  }

  /** 当前生效配置摘要（供设置页与健康检查） */
  get summary(): AiProviderSummary {
    return {
      available: this.available,
      model: this.modelName,
      provider: this.active?.provider ?? null,
      name: this.active?.name ?? null,
      source: this.activeId ? 'db' : this.active ? 'env' : null,
    };
  }

  /**
   * 用给定配置构建 Anthropic 客户端。
   * baseUrl 为空时显式使用官方地址，避免意外继承环境变量 ANTHROPIC_BASE_URL
   * （数据库配置优先于环境变量，语义应与回退逻辑一致）。
   */
  buildClient(provider: ResolvedAiProvider): Anthropic {
    return new Anthropic({
      apiKey: provider.apiKey,
      baseURL: normalizeBaseUrl(provider.baseUrl) ?? 'https://api.anthropic.com',
    });
  }

  // ==================== 配置管理 ====================

  async listProviders(): Promise<AiProviderDto[]> {
    const rows = await this.repo.findAll();
    return rows.map(toProviderDto);
  }

  async getProvider(id: string): Promise<AiProviderDto> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException('AI 配置不存在');
    return toProviderDto(row);
  }

  async createProvider(dto: CreateAiProviderDto): Promise<AiProviderDto> {
    const name = dto.name.trim();
    const apiKey = dto.apiKey.trim();
    if (!name) throw new BadRequestException('配置名称不能为空');
    if (!apiKey) throw new BadRequestException('API Key 不能为空');

    // 无生效中的数据库配置（首个配置 / 生效项被停用或删除 / 环境变量生效中）时自动设为生效
    const [count, active] = await Promise.all([this.repo.count(), this.repo.findActive()]);
    const shouldActivate = dto.isActive === true || count === 0 || !active?.enabled;
    const row = await this.repo.create(
      {
        name,
        provider: dto.provider ?? 'anthropic',
        baseUrl: normalizeBaseUrl(dto.baseUrl) ?? null,
        apiKey,
        model: dto.model?.trim() || 'claude-sonnet-5',
        enabled: dto.enabled ?? true,
      },
      shouldActivate,
    );
    await this.refresh();
    return toProviderDto(row);
  }

  async updateProvider(id: string, dto: UpdateAiProviderDto): Promise<AiProviderDto> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException('AI 配置不存在');

    // 先收集所有可更新字段（不区分是否同时激活），避免 isActive=true 分支提前返回
    // 把同请求里的 name/provider/baseUrl/model/apiKey 等修改静默丢弃。
    const data: {
      name?: string;
      provider?: string;
      baseUrl?: string | null;
      apiKey?: string;
      model?: string;
      enabled?: boolean;
    } = {};

    if (dto.name !== undefined) {
      if (!dto.name.trim()) throw new BadRequestException('配置名称不能为空');
      data.name = dto.name.trim();
    }
    if (dto.provider !== undefined) data.provider = dto.provider;
    if (dto.baseUrl !== undefined) data.baseUrl = normalizeBaseUrl(dto.baseUrl) ?? null;
    if (dto.model !== undefined && dto.model.trim()) data.model = dto.model.trim();
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    // 掩码值 / 空串表示保留原密钥
    if (dto.apiKey !== undefined && !isMaskedKey(dto.apiKey)) {
      data.apiKey = dto.apiKey.trim();
    }

    // 激活操作单独走事务：先切换生效标记，再应用其它字段更新
    if (dto.isActive === true) {
      if (dto.enabled === false || (!existing.enabled && dto.enabled !== true)) {
        throw new BadRequestException('停用的配置不能设为生效，请先启用');
      }
      let updated = await this.repo.setActive(id);
      // 显式同时启用 + 生效：setActive 只改 isActive，需补充 enabled 更新
      if (Object.keys(data).length > 0) {
        updated = await this.repo.update(id, data);
      }
      await this.refresh();
      return toProviderDto(updated);
    }

    // 停用当前生效配置时，自动提升最早的其它启用配置；否则回退到环境变量
    const wasActive = existing.isActive && dto.enabled === false;
    const updated = Object.keys(data).length > 0 ? await this.repo.update(id, data) : existing;
    if (wasActive) {
      await this.promoteFallback();
    }
    await this.refresh();
    return toProviderDto(updated);
  }

  /** 生效配置被删除/停用后，自动提升最早的启用配置（若存在） */
  private async promoteFallback(): Promise<void> {
    const fallback = await this.repo.findFirstEnabled();
    if (fallback) {
      await this.repo.setActive(fallback.id);
    }
  }

  async activateProvider(id: string): Promise<AiProviderDto> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException('AI 配置不存在');
    if (!row.enabled) {
      throw new BadRequestException('停用的配置不能设为生效，请先启用');
    }
    const updated = await this.repo.setActive(id);
    await this.refresh();
    return toProviderDto(updated);
  }

  async deleteProvider(id: string): Promise<{ id: string; deleted: true }> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException('AI 配置不存在');

    const wasActive = row.isActive;
    await this.repo.delete(id);

    // 删除生效配置后，自动提升最早的启用配置；否则回退到环境变量
    if (wasActive) {
      await this.promoteFallback();
    }
    await this.refresh();
    return { id, deleted: true };
  }

  // ==================== 连通性测试 ====================

  /** 测试已保存的配置并记录结果 */
  async testSavedProvider(id: string): Promise<AiTestResult> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException('AI 配置不存在');

    const result = await this.runTest({
      provider: row.provider,
      apiKey: row.apiKey,
      baseUrl: row.baseUrl ?? undefined,
      model: row.model,
    });

    await this.repo.setTestResult(
      id,
      result.success ? 'ok' : 'error',
      result.success ? null : (result.message ?? null),
    );
    return result;
  }

  /** 测试未保存的临时配置 */
  async testAdHoc(dto: TestAiProviderDto): Promise<AiTestResult> {
    return this.runTest({
      provider: dto.provider ?? 'anthropic',
      apiKey: dto.apiKey.trim(),
      baseUrl: dto.baseUrl || undefined,
      model: dto.model?.trim() || 'claude-sonnet-5',
    });
  }

  /**
   * 最小连通性调用：发一条 1-token 消息，验证密钥、地址、模型三者是否可用。
   * 不抛异常，任何失败都转为可读结果。
   */
  private async runTest(provider: ResolvedAiProvider): Promise<AiTestResult> {
    if (!provider.apiKey) {
      return { success: false, message: '未提供 API Key' };
    }
    const startedAt = Date.now();
    try {
      const client = this.buildClient(provider);
      // 连通性测试不写入 AI 用量统计：它只是一次 16-token 探活，
      // 计入会污染真实使用趋势（见 ai-usage 模块）。
      // 单次请求 15s 超时，避免对不可达地址测试时长时间挂起
      const response = await client.messages.create(
        {
          model: provider.model,
          // 用 16 token 避免部分兼容网关对 max_tokens 设更高下限导致误报失败
          max_tokens: 16,
          messages: [{ role: 'user', content: 'ping' }],
        },
        { timeout: 15_000 },
      );
      const latencyMs = Date.now() - startedAt;
      return {
        success: true,
        latencyMs,
        model: response.model ?? provider.model,
        message: '连接成功',
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message = this.extractErrorDetail(error);
      this.logger.warn(`AI 配置连通性测试失败: ${message}`);
      return { success: false, latencyMs, message, error: message };
    }
  }

  private extractErrorDetail(error: unknown): string {
    if (error instanceof Anthropic.APIError) {
      const status = error.status ? `（HTTP ${error.status}）` : '';
      return `${error.message}${status}`;
    }
    if (error instanceof Error) return error.message;
    return String(error);
  }
}

/** 行记录 → 对外 DTO（密钥掩码） */
function toProviderDto(row: {
  id: string;
  name: string;
  provider: string;
  baseUrl: string | null;
  apiKey: string;
  model: string;
  isActive: boolean;
  enabled: boolean;
  lastTestedAt: Date | null;
  lastTestStatus: string | null;
  lastTestError: string | null;
  createdAt: Date;
  updatedAt: Date;
}): AiProviderDto {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    baseUrl: row.baseUrl,
    apiKey: maskApiKey(row.apiKey),
    hasApiKey: !!row.apiKey,
    model: row.model,
    isActive: row.isActive,
    enabled: row.enabled,
    lastTestedAt: row.lastTestedAt,
    lastTestStatus:
      row.lastTestStatus === 'ok' ? 'ok' : row.lastTestStatus === 'error' ? 'error' : null,
    lastTestError: row.lastTestError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
