/**
 * 样式分析服务 —— 编排完整管线
 *
 * 上传图片 → sharp 确定性取色 → 分析样式出 StyleProfile → 生成布局变体 → 导出包。
 *
 * 来源自动降级：
 * - AI 可用：Claude 视觉分析 + 变体生成（结果最智能）
 * - AI 未配置 / 调用失败：自动降级为本地确定性分析（zero 成本），
 *   颜色仍取自像素、变体用预置模板，前端无感
 *
 * 精益版：不落库、不走任务队列，同步返回完整结果。
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClaudeVisionClient } from './claude-vision.client';
import { extractPalette, prepareImageForClaude } from './extractors/color-extractor';
import { buildLocalProfile, buildLocalVariations } from './local-style';
import { buildStyleAnalysisPrompt, buildVariationGenerationPrompt } from './prompt-builder';
import { buildImagePrompt } from './exporters/image-prompt.exporter';
import { buildCssTokens } from './exporters/css-tokens.exporter';
import { buildStyleGuide } from './exporters/style-guide.exporter';
import type { ExtractedPalette } from './extractors/color-extractor';
import type { StyleAnalyzeResult, StyleProfile, StyleSource, StyleVariation } from './types';
import { DEFAULT_VARIATION_COUNT } from './types';

@Injectable()
export class StyleService {
  private readonly logger = new Logger(StyleService.name);

  /** AI 失败后的临时降级缓存：key=baseUrl|model → 失败时间戳，避免对已知不可用的模型反复等待 */
  private readonly aiFailureCache = new Map<string, number>();
  private static readonly AI_RETRY_TTL_MS = 15 * 60 * 1000;

  constructor(
    private readonly claude: ClaudeVisionClient,
    private readonly config: ConfigService,
  ) {}

  /** 功能可用性：样式实验室始终可用（AI 或本地），source 区分当前分析来源。
   *  感知 AI 降级缓存：配置了 AI 但最近一次失败（缓存期内）时如实返回 local。 */
  get availability(): { available: boolean; source: StyleSource; model: string } {
    const aiReady = this.claude.available && !this.isAiCachedDown(this.claude.providerKey);
    return {
      available: true,
      source: aiReady ? 'ai' : 'local',
      model: this.claude.available ? this.claude.modelName : '',
    };
  }

  /**
   * 完整分析：图片 → StyleProfile + 布局变体 + 导出包
   */
  async analyze(file: Express.Multer.File): Promise<StyleAnalyzeResult> {
    const buffer = file.buffer;
    if (!buffer || buffer.length === 0) {
      throw new BadRequestException('上传内容为空，请重新选择图片');
    }
    const maxBytes = this.maxImageBytes();
    if (buffer.length > maxBytes) {
      throw new BadRequestException(
        `图片大小 ${(buffer.length / 1024 / 1024).toFixed(1)}MB 超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB`,
      );
    }

    // 1. 确定性取色（AI 与本地模式共用）
    let palette;
    try {
      palette = await extractPalette(buffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法解析图片';
      throw new BadRequestException(`无法解析图片：${message}（请确认是有效的图片文件）`);
    }

    this.logger.log(
      `样式分析开始：${palette.width}x${palette.height} ${palette.format}，检测到 ${palette.colors.length} 个主色`,
    );

    // 2. AI 可用优先；失败/未配置 → 本地确定性分析
    const { source, profile, variations } = await this.runStyleAnalysis(palette, buffer);

    this.logger.log(`样式分析完成（${source}）：生成 ${variations.length} 个布局变体`);

    // 3. 档案级导出（与来源无关）
    const exports = {
      cssTokens: buildCssTokens(profile),
      styleGuide: buildStyleGuide(profile),
    };

    return {
      source,
      image: { width: palette.width, height: palette.height, format: palette.format },
      detectedColors: palette.colors,
      profile,
      variations,
      exports,
    };
  }

  private maxImageBytes(): number {
    const mb = this.config.get<number>('ai.maxImageSizeMB') ?? 20;
    return mb * 1024 * 1024;
  }

  /**
   * 选择分析来源：AI 可用先尝试 AI，任何失败都回退到本地。
   * 失败的 provider 会进入临时降级缓存（15 分钟），期间直接走本地、零等待；
   * 本地路径不依赖网络与密钥，保证功能始终可用。
   */
  private async runStyleAnalysis(
    palette: ExtractedPalette,
    buffer: Buffer,
  ): Promise<{ source: StyleSource; profile: StyleProfile; variations: StyleVariation[] }> {
    const key = this.claude.providerKey;
    if (this.claude.available && !this.isAiCachedDown(key)) {
      try {
        const image = await prepareImageForClaude(buffer);
        const analysisPrompt = buildStyleAnalysisPrompt(palette.colors);
        const profile = this.normalizeProfile(
          await this.claude.analyzeStyle(
            { base64: image.base64, mediaType: image.mediaType },
            palette.colors,
            analysisPrompt,
          ),
        );
        const variationPrompt = buildVariationGenerationPrompt(profile);
        const rawVariations = await this.claude.generateVariations(profile, variationPrompt);
        const variations = this.normalizeVariations(rawVariations, profile);
        return { source: 'ai', profile, variations };
      } catch (error) {
        if (key) this.aiFailureCache.set(key, Date.now());
        this.logger.warn(
          `AI 样式分析失败，自动降级为本地分析（${StyleService.AI_RETRY_TTL_MS / 60000} 分钟内不再重试该模型）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const profile = this.normalizeProfile(buildLocalProfile(palette));
    const variations = this.normalizeVariations(buildLocalVariations(profile), profile);
    return { source: 'local', profile, variations };
  }

  private isAiCachedDown(key: string): boolean {
    if (!key) return false;
    const failedAt = this.aiFailureCache.get(key);
    return failedAt !== undefined && Date.now() - failedAt < StyleService.AI_RETRY_TTL_MS;
  }

  /**
   * 防御性归一化：模型输出可能有缺字段/多字段，保证后续导出不崩
   */
  private normalizeProfile(input: StyleProfile): StyleProfile {
    const palette = input?.colorPalette ?? {};
    const typography = input?.typography ?? {};
    const spacing = input?.spacing ?? {};
    const layout = input?.layout ?? {};
    const texture = input?.textureMood ?? {};

    return {
      colorPalette: {
        primary: palette.primary ?? { hex: '#333333', role: '主色' },
        background: palette.background ?? { hex: '#ffffff', role: '背景' },
        accent: palette.accent ?? { hex: '#666666', role: '强调色' },
        scale: Array.isArray(palette.scale) ? palette.scale : [],
        mood: palette.mood ?? '',
      },
      typography: {
        familyTrait: typography.familyTrait ?? '无衬线',
        suggestedFont: typography.suggestedFont,
        weights: Array.isArray(typography.weights) ? typography.weights : [],
        hierarchy: this.normalizeTypeHierarchy(typography.hierarchy),
        lineHeight: typography.lineHeight ?? 1.5,
      },
      spacing: {
        unit: spacing.unit ?? 8,
        scale: Array.isArray(spacing.scale) ? spacing.scale : [4, 8, 16, 24, 48],
        density: spacing.density ?? 'comfortable',
      },
      layout: {
        composition: layout.composition ?? '',
        regions: Array.isArray(layout.regions) ? layout.regions : [],
        grid:
          layout.grid && typeof layout.grid === 'object' && typeof layout.grid.columns === 'number'
            ? {
                columns: layout.grid.columns,
                gutterPx: typeof layout.grid.gutterPx === 'number' ? layout.grid.gutterPx : 0,
              }
            : null,
        balance: layout.balance ?? '',
      },
      textureMood: {
        radius: texture.radius ?? '8px',
        shadow: texture.shadow ?? 'none',
        gradient: texture.gradient ?? null,
        density: texture.density ?? 'comfortable',
        keywords: Array.isArray(texture.keywords) ? texture.keywords : [],
      },
      styleGuideText: input?.styleGuideText ?? '',
    };
  }

  /**
   * 过滤无效变体 + 填充 id / imagePrompt
   */
  private normalizeVariations(
    raw: Array<Pick<StyleVariation, 'name' | 'description' | 'composition' | 'html'>>,
    profile: StyleProfile,
  ): StyleVariation[] {
    const valid = raw
      .filter(
        (v) =>
          v &&
          typeof v.name === 'string' &&
          v.name.trim().length > 0 &&
          typeof v.html === 'string' &&
          v.html.trim().length > 0,
      )
      .map((v, index) => {
        const composition = typeof v.composition === 'string' ? v.composition.trim() : '';
        const variation: StyleVariation = {
          id: `v${index + 1}`,
          name: v.name.trim(),
          description: typeof v.description === 'string' ? v.description.trim() : '',
          composition,
          html: v.html.trim(),
          // 用归一化后的构图生成提示词，避免原始字段缺失导致模板出现 undefined
          imagePrompt: buildImagePrompt(profile, { composition }),
        };
        return variation;
      });

    if (valid.length === 0) {
      throw new BadRequestException('布局变体生成失败（模型未返回有效变体），请重试');
    }
    if (valid.length < DEFAULT_VARIATION_COUNT) {
      this.logger.warn(`变体数量不足：期望 ${DEFAULT_VARIATION_COUNT}，实际 ${valid.length}`);
    }
    return valid;
  }

  /**
   * 防御性归一化字体层级：保证每个 item 的 sizePx/weight 都是合法数字，
   * 避免 css-tokens 导出出现 NaNpx
   */
  private normalizeTypeHierarchy(
    hierarchy: StyleProfile['typography']['hierarchy'],
  ): StyleProfile['typography']['hierarchy'] {
    if (!Array.isArray(hierarchy)) return [];
    return hierarchy
      .filter((h) => h && typeof h === 'object')
      .map((h) => ({
        role: typeof h.role === 'string' && h.role.trim() ? h.role.trim() : 'text',
        sizePx:
          typeof h.sizePx === 'number' && Number.isFinite(h.sizePx) && h.sizePx > 0
            ? Math.round(h.sizePx)
            : 16,
        weight:
          typeof h.weight === 'number' && Number.isFinite(h.weight) && h.weight > 0
            ? h.weight
            : 400,
        letterSpacing: typeof h.letterSpacing === 'string' ? h.letterSpacing : undefined,
      }));
  }
}
