/**
 * Claude 视觉客户端
 *
 * 模块内唯一直接接触 Anthropic SDK 的地方。
 * - 生效配置由 AiSettingsService 解析（数据库生效配置 → 环境变量回退），
 *   在「设置 → AI 配置」中修改后立即生效，无需重启
 * - 未配置时 available=false，服务层返回友好错误
 * - 使用 tool_choice 强制结构化输出，保证 StyleProfile / 变体结果可解析；
 *   对不支持强制 tool_choice 的兼容网关（典型如 DeepSeek 中转，收到强制
 *   tool_choice 会返回 502 api_error）自动降级：
 *   强制 tool_choice → tool_choice auto → 纯 JSON 文本提示
 */
import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { AiSettingsService } from '../ai-settings/ai-settings.service';
import type { ResolvedAiProvider } from '../ai-settings/ai-provider.types';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import type { AiFeature } from '../ai-usage/ai-usage.types';
import type { AiFailureKind, StyleProfile, StyleVariation } from './types';
import { STYLE_PROFILE_INPUT_SCHEMA, STYLE_VARIATIONS_INPUT_SCHEMA } from './types';

export interface ClaudeImageInput {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

/**
 * AI 调用失败，携带失败分类。
 *
 * 对外仍是 400（前端展示可读原因），但上层（StyleService）能据此区分
 * 「网关连不上」（重试无意义，缓存久）与「模型这次没吐出有效结果」
 * （随机性问题，短暂退避即可），从而给出不同的降级策略。
 */
export class AiCallError extends BadRequestException {
  constructor(
    message: string,
    readonly kind: AiFailureKind,
  ) {
    super(message);
  }
}

/**
 * 把任意异常归类为降级策略可用的失败类型。
 * 连接/服务端故障 → connectivity；限流 → rate_limit；密钥问题 → auth；
 * 其余（模型输出无效、JSON 解析失败）→ output。
 *
 * `capability` 不由这里推断：它只在守卫确认"模型读不到图"时显式抛出
 * （见 `assertProfileReadable`），从错误文本反推并不可靠。
 */
export function classifyAiFailure(error: unknown): AiFailureKind {
  if (error instanceof AiCallError) return error.kind;
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    if (typeof status !== 'number') return 'connectivity';
    if (status === 429) return 'rate_limit';
    if (status === 401 || status === 403) return 'auth';
    if (status >= 500) return 'connectivity';
    return 'output';
  }
  if (
    error instanceof Error &&
    /ECONN|ETIMEDOUT|EAI_AGAIN|socket|timeout|network|fetch failed/i.test(error.message)
  ) {
    return 'connectivity';
  }
  return 'output';
}

/** 结构化输出工具描述 */
interface StructuredTool {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
}

@Injectable()
export class ClaudeVisionClient {
  private readonly logger = new Logger(ClaudeVisionClient.name);

  /** 强制 tool_choice 支持性缓存：key=baseUrl|model，value=false 表示该组合不支持 */
  private readonly forcedToolSupport = new Map<string, boolean>();

  constructor(
    private readonly aiSettings: AiSettingsService,
    private readonly usage: AiUsageService,
  ) {}

  get available(): boolean {
    return this.aiSettings.available;
  }

  get modelName(): string {
    return this.aiSettings.modelName;
  }

  /** 每次调用按当前生效配置构建客户端，保证设置修改后立即生效 */
  private createClient(): {
    client: Anthropic;
    model: string;
    provider: ResolvedAiProvider;
  } {
    const provider = this.aiSettings.activeProvider;
    if (!provider) {
      throw new ServiceUnavailableException(
        'AI 功能未启用：请到「设置 → AI 配置」中填写 API Key 并设为生效',
      );
    }
    return {
      client: this.aiSettings.buildClient(provider),
      model: provider.model,
      provider,
    };
  }

  /** 按 baseUrl+model+密钥指纹缓存能力，配置切换后自动区分。
   *  加入密钥指纹：仅更换 API Key（同 baseUrl+model）也会使旧的
   *  降级/失败缓存失效，避免上一把失效密钥的失败结果误导新密钥。 */
  get providerKey(): string {
    const p = this.aiSettings.activeProvider;
    if (!p) return '';
    const keyFingerprint = p.apiKey
      ? createHash('sha256').update(p.apiKey).digest('hex').slice(0, 8)
      : '';
    return `${p.baseUrl ?? 'anthropic'}|${p.model}|${keyFingerprint}`;
  }

  /**
   * 样式分析：送原图 + 检测色板，强制返回 StyleProfile
   */
  async analyzeStyle(
    image: ClaudeImageInput,
    detectedColors: string[],
    prompt: string,
  ): Promise<StyleProfile> {
    const { client, model, provider } = this.createClient();
    const tool: StructuredTool = {
      name: 'output_style_profile',
      description: '输出从图片中提取的结构化样式档案',
      input_schema: STYLE_PROFILE_INPUT_SCHEMA,
    };
    const content: Anthropic.ContentBlockParam[] = [
      {
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
      },
      { type: 'text', text: prompt },
    ];
    try {
      const input = await this.callStructured<StyleProfile>({
        client,
        model,
        provider,
        feature: 'style.analyze',
        maxTokens: 4096,
        tool,
        messages: [{ role: 'user', content }],
        jsonInstruction:
          '\n\n必须直接输出一个 JSON 对象，包含：colorPalette（primary/background/accent 各含 hex 与 role、scale 字符串数组、mood）、typography（familyTrait、suggestedFont、weights、lineHeight、hierarchy 数组）、spacing（unit、scale 数组、density）、layout（composition、regions 数组、grid、balance）、textureMood（radius、shadow、gradient、density、keywords 数组）、styleGuideText。不要使用 markdown 代码块，不要输出 JSON 以外的内容。',
        parseToolUse: (raw) => raw as unknown as StyleProfile,
        parseText: (text) => this.parseJsonText<StyleProfile>(text, '样式档案'),
      });
      this.assertProfileReadable(input);
      return input;
    } catch (error) {
      this.rethrowAsBadRequest('样式分析', error, true);
    }
  }

  /**
   * 变体生成：送样式档案 JSON（不重复送图），强制返回 StyleVariation[]
   */
  async generateVariations(profile: StyleProfile, prompt: string): Promise<StyleVariation[]> {
    const { client, model, provider } = this.createClient();
    const tool: StructuredTool = {
      name: 'output_style_variations',
      description: '输出基于样式档案生成的多种布局变体',
      input_schema: STYLE_VARIATIONS_INPUT_SCHEMA,
    };
    try {
      const parsed = await this.callStructured<{ variations?: StyleVariation[] }>({
        client,
        model,
        provider,
        feature: 'style.variations',
        maxTokens: 8192,
        tool,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        jsonInstruction:
          '\n\n必须直接输出一个 JSON 对象，仅含一个键 variations，值为数组，每项包含 name、description、composition、html。不要使用 markdown 代码块，不要输出 JSON 以外的内容。',
        parseToolUse: (raw) => raw as unknown as { variations?: StyleVariation[] },
        parseText: (text) => this.parseVariationsText(text),
      });
      return Array.isArray(parsed.variations) ? parsed.variations : [];
    } catch (error) {
      this.rethrowAsBadRequest('布局变体生成', error);
    }
  }

  // ==================== 结构化输出（三级降级） ====================

  /**
   * 请求结构化输出，按网关兼容性逐级降级：
   * 1. tools + 强制 tool_choice（Anthropic 原生，输出最可靠）
   * 2. tools + tool_choice auto（支持工具但无法强制的网关）
   * 3. 无工具 + 纯 JSON 文本提示（所有模型/网关通用兜底）
   *
   * 第 1 步失败后缓存该 provider「不支持强制 tool_choice」，后续调用直接走第 2 步。
   * 第 1/2 步仅在服务端错误（5xx / 连接失败）时降级；4xx 属于请求本身问题，直接抛出。
   */
  private async callStructured<T>(params: {
    client: Anthropic;
    model: string;
    provider: ResolvedAiProvider;
    feature: AiFeature;
    maxTokens: number;
    tool: StructuredTool;
    messages: Anthropic.MessageParam[];
    jsonInstruction: string;
    parseToolUse: (input: unknown) => T;
    parseText: (text: string) => T;
  }): Promise<T> {
    const {
      client,
      model,
      provider,
      feature,
      maxTokens,
      tool,
      messages,
      jsonInstruction,
      parseToolUse,
      parseText,
    } = params;
    const key = this.providerKey;
    const base = { model, max_tokens: maxTokens };

    // 1) 强制 tool_choice
    if (this.supportsForcedTool(key)) {
      try {
        const res = await this.requestMessage(feature, provider, client, model, {
          ...base,
          tools: [tool],
          tool_choice: { type: 'tool', name: tool.name },
          messages,
        });
        return parseToolUse(this.requireToolUse(res, tool.name));
      } catch (error) {
        if (!this.isUpstreamError(error)) throw error;
        this.forcedToolSupport.set(key, false);
        this.logger.warn(
          `当前模型/网关不支持强制 tool_choice，已降级为 auto：${this.errorDetail(error)}`,
        );
      }
    }

    // 2) tools + auto：能出工具调用就用，否则尝试解析文本
    try {
      const res = await this.requestMessage(feature, provider, client, model, {
        ...base,
        tools: [tool],
        tool_choice: { type: 'auto' },
        messages,
      });
      const toolUse = res.content.find(
        (block): block is Anthropic.ContentBlock & { type: 'tool_use' } =>
          block.type === 'tool_use',
      );
      if (toolUse) return parseToolUse(toolUse.input);
      const text = this.extractText(res.content);
      if (text) {
        try {
          return parseText(text);
        } catch {
          this.logger.warn('tool_choice auto 未返回可解析的结构化内容，尝试纯 JSON 兜底');
        }
      }
    } catch (error) {
      if (!this.isUpstreamError(error)) throw error;
      this.logger.warn(`tool_choice auto 失败，尝试纯 JSON 文本兜底：${this.errorDetail(error)}`);
    }

    // 3) 纯 JSON 文本兜底（任何模型/网关都接受）
    const res = await this.requestMessage(feature, provider, client, model, {
      ...base,
      messages: this.appendJsonInstruction(messages, jsonInstruction),
    });
    return parseText(this.extractText(res.content));
  }

  /**
   * 统一发起上游请求并上报用量。
   *
   * 每次真实 HTTP 请求都单独记录（包括三级降级中的失败尝试），因此统计页的
   * 「请求次数」对应实际上游调用量，而不是用户操作次数。
   */
  private async requestMessage(
    feature: AiFeature,
    provider: ResolvedAiProvider,
    client: Anthropic,
    model: string,
    params: Anthropic.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Message> {
    const startedAt = Date.now();
    try {
      const response = await client.messages.create(params);
      this.usage.record({
        feature,
        provider,
        model: response.model || model,
        usage: response.usage,
        latencyMs: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      this.usage.record({
        feature,
        provider,
        model,
        latencyMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  }

  private supportsForcedTool(key: string): boolean {
    if (!key) return true;
    return this.forcedToolSupport.get(key) !== false;
  }

  /** 仅服务端类错误（5xx / 连接中断）触发降级；4xx 属于请求本身的问题，直接抛出 */
  private isUpstreamError(error: unknown): boolean {
    if (error instanceof Anthropic.APIError) {
      return typeof error.status === 'number' && error.status >= 500;
    }
    return (
      error instanceof Error &&
      /ECONN|ETIMEDOUT|EAI_AGAIN|socket|timeout|network|fetch failed/i.test(error.message)
    );
  }

  private errorDetail(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private requireToolUse(res: Anthropic.Message, toolName: string): unknown {
    const block = res.content.find(
      (b): b is Anthropic.ContentBlock & { type: 'tool_use' } => b.type === 'tool_use',
    );
    if (!block) throw new Error(`模型未返回结构化输出（${toolName}）`);
    return block.input;
  }

  private extractText(content: Anthropic.ContentBlock[]): string {
    return content
      .filter((b): b is Extract<Anthropic.ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }

  /** 在首条 user 消息末尾追加 JSON 指令（供纯 JSON 文本兜底） */
  private appendJsonInstruction(
    messages: Anthropic.MessageParam[],
    instruction: string,
  ): Anthropic.MessageParam[] {
    return messages.map((msg, i) => {
      if (i !== 0 || msg.role !== 'user') return msg;
      const content = Array.isArray(msg.content)
        ? (msg.content as Anthropic.ContentBlockParam[])
        : [{ type: 'text' as const, text: String(msg.content) }];
      const tail: Anthropic.ContentBlockParam = { type: 'text', text: instruction };
      return { role: 'user', content: [...content, tail] };
    });
  }

  /** 解析模型返回的 JSON 文本，容忍 markdown 代码块与前后说明文字 */
  private parseJsonText<T>(text: string, label: string): T {
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) {
      throw new Error(`模型未返回可解析的 JSON（${label}）`);
    }
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    } catch (error) {
      throw new Error(
        `模型返回的 JSON 解析失败（${label}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 变体响应解析：接受 `{variations:[...]}` 与顶层数组 `[...]` 两种形态。
   * 部分模型在纯文本兜底时会直接输出数组，通用 parseJsonText 会误截
   * 数组内第一个对象的 {} 导致解析失败，这里先行处理。
   */
  private parseVariationsText(text: string): { variations?: StyleVariation[] } {
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    if (cleaned.startsWith('[')) {
      try {
        const parsed = JSON.parse(cleaned) as unknown;
        if (Array.isArray(parsed)) return { variations: parsed as StyleVariation[] };
      } catch {
        // 非标准数组（含说明文字），落到通用解析
      }
    }
    return this.parseJsonText<{ variations?: StyleVariation[] }>(cleaned, '布局变体');
  }

  /**
   * 样式档案有效性守卫：模型若根本读不到图片（无视觉能力 / 网关不传图），
   * 会返回空结构（如 colorPalette 为 null）而非真实分析，这里拦截并给出可操作提示。
   *
   * 判据必须**只看色板是否整体为空**：primary/background/accent 是 schema 必填项，
   * 但模型偶发漏掉其中一两个属于"抽风"，`normalizeProfile` 会把缺的那个回退成像素色、
   * 产出完全可用的档案。若把"缺任一色"也当成读不到图，就会误报成配置问题、
   * 让用户去换模型，并白等一个 15 分钟退避窗口。
   */
  private assertProfileReadable(input: StyleProfile): void {
    const palette = input?.colorPalette;
    const empty =
      palette == null ||
      (palette.primary == null && palette.background == null && palette.accent == null);
    if (empty) {
      throw new AiCallError(
        '模型未能读取图片内容（当前模型可能不支持图片输入，也可能是网关本次未转发图片）。请在「系统设置 → AI 配置」中更换为支持视觉的模型（如 Claude 系列），或稍后重试。',
        // 单独归类：这是**能力/配置**问题，与"模型随机吐出无效 JSON"不是一回事。
        // 用 output 会让它跟着吃 1 分钟退避，于是配错模型的用户每次分析都白打两次
        // 完整视觉调用（含图片上传 + 4096 tokens）。
        'capability',
      );
    }
  }

  /**
   * 外部 AI 调用失败的统一出口：
   * - 记录完整错误
   * - 已是 HttpException（如未配 key、图片读取守卫）原样透传
   * - 其余转为 400，把可读原因带给前端（否则全局过滤器会统一转成 500 Internal server error）
   * - 同时按错误性质打上 AiFailureKind，供 StyleService 决定降级缓存时长
   *
   * @param visionHint 样式分析等带图场景传入 true：当失败属于模型输出类问题
   *   （非 API 错误）时，追加“模型可能不支持图片输入”的可操作提示。
   */
  private rethrowAsBadRequest(action: string, error: unknown, visionHint = false): never {
    this.logger.error(`${action}失败: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof HttpException) throw error;
    const kind = classifyAiFailure(error);
    const detail = error instanceof Error ? error.message : String(error);
    const hint =
      visionHint && !(error instanceof Anthropic.APIError)
        ? '。若持续失败，当前模型可能不支持图片输入，请在「系统设置 → AI 配置」中更换为支持视觉的模型（如 Claude 系列），或检查网关是否正确转发图片'
        : '';
    throw new AiCallError(`${action}失败：${detail}${hint}`, kind);
  }
}
