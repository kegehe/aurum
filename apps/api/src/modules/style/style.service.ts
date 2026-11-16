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
import { parseColor } from '../../common/color/contrast';
import { ClaudeVisionClient, classifyAiFailure } from './claude-vision.client';
import { extractPalette, prepareImageForClaude } from './extractors/color-extractor';
import { buildLocalProfile, buildLocalVariations } from './local-style';
import { buildStyleAnalysisPrompt, buildVariationGenerationPrompt } from './prompt-builder';
import { buildImagePrompt } from './exporters/image-prompt.exporter';
import { buildCssTokens } from './exporters/css-tokens.exporter';
import { buildStyleGuide } from './exporters/style-guide.exporter';
import type { ExtractedPalette, PreparedImage } from './extractors/color-extractor';
import type {
  AiFailureKind,
  StyleAnalyzeResult,
  StyleAvailability,
  StyleColor,
  StyleLayout,
  StyleProfile,
  StyleSource,
  StyleSpacing,
  StyleVariation,
} from './types';
import { DEFAULT_VARIATION_COUNT } from './types';

/** 一次 AI 失败记录 */
interface AiFailure {
  kind: AiFailureKind;
  reason: string;
  failedAt: number;
}

@Injectable()
export class StyleService {
  private readonly logger = new Logger(StyleService.name);

  /** AI 失败后的临时降级缓存：key=baseUrl|model|密钥指纹，避免对已知不可用的模型反复等待 */
  private readonly aiFailureCache = new Map<string, AiFailure>();

  /**
   * 降级缓存时长（按失败类型区分）。
   *
   * 连接类故障重试通常无济于事，缓存久一些避免每次都白等一个超时；
   * 而「模型本次没吐出有效结果」是随机性的（实测同一个模型、同一张图，
   * 7 次真实调用里 3 次失败：2 次变体为空、1 次档案读不到图），只做短暂
   * 退避，否则用户会遇到「明明配了 AI、重试却始终走本地」的假象。
   */
  private static readonly AI_RETRY_TTL_MS: Record<AiFailureKind, number> = {
    connectivity: 15 * 60 * 1000,
    auth: 15 * 60 * 1000,
    // 模型读不到图 = 配置/能力问题（换模型才能解决），同连接类归为"重试无济于事"
    capability: 15 * 60 * 1000,
    rate_limit: 2 * 60 * 1000,
    output: 60 * 1000,
  };

  /** 单次 AI 调用的最大尝试次数（首次 + 一次重试） */
  private static readonly AI_MAX_ATTEMPTS = 2;

  /**
   * 值得立刻重试的失败类型。
   *
   * `output`：输出质量问题有随机性，重试成本低。
   * `capability`：其中「网关本次未转发图片」是瞬时的，重试一次往往就能恢复；
   *   而「模型压根不支持视觉」重试确实白费 —— 但两者从响应上无法区分，
   *   且重试成功时不会写降级缓存，所以 15 分钟退避只在两次都失败后才生效，
   *   代价被限制在每次退避窗口一次。
   */
  private static readonly RETRYABLE_FAILURES = new Set<AiFailureKind>(['output', 'capability']);

  constructor(
    private readonly claude: ClaudeVisionClient,
    private readonly config: ConfigService,
  ) {}

  /** 功能可用性：样式实验室始终可用（AI 或本地）。
   *  AI 已配置但最近一次失败（缓存期内）时，如实返回 local 并带上降级原因，
   *  前端据此区分「未配置 AI」与「已配置但临时降级」两种提示。 */
  get availability(): StyleAvailability {
    const model = this.claude.available ? this.claude.modelName : '';
    if (!this.claude.available) {
      return { available: true, source: 'local', model, degraded: false, degradation: null };
    }
    const failure = this.activeFailure(this.claude.providerKey);
    if (failure) {
      return {
        available: true,
        source: 'local',
        model,
        degraded: true,
        degradation: {
          kind: failure.kind,
          reason: failure.reason,
          retryAfterMs:
            StyleService.AI_RETRY_TTL_MS[failure.kind] - (Date.now() - failure.failedAt),
        },
      };
    }
    return { available: true, source: 'ai', model, degraded: false, degradation: null };
  }

  /**
   * 手动清除当前 provider 的降级缓存（前端「立即重试 AI」）。
   * 下一次分析会重新尝试 AI，而不是等退避窗口结束。
   */
  resetAiFailure(): void {
    const key = this.claude.providerKey;
    if (key) this.aiFailureCache.delete(key);
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
    const { source, variationsSource, profile, variations } = await this.runStyleAnalysis(
      palette,
      buffer,
    );

    this.logger.log(
      `样式分析完成（档案 ${source} / 变体 ${variationsSource}）：生成 ${variations.length} 个布局变体`,
    );

    // 3. 档案级导出（与来源无关）
    const exports = {
      cssTokens: buildCssTokens(profile),
      styleGuide: buildStyleGuide(profile),
    };

    return {
      source,
      variationsSource,
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
   * 选择分析来源：AI 可用先尝试 AI，档案这一步失败才整体回退本地。
   *
   * 失败的 provider 会进入临时降级缓存（时长按失败类型区分），期间直接走本地、
   * 零等待；本地路径不依赖网络与密钥，保证功能始终可用。
   *
   * 注意两个独立步骤的降级粒度不同：
   * - 样式档案（analyzeStyle）失败 → 整体回退本地档案 + 本地变体，并记录降级
   * - 布局变体（generateVariations）失败 → 只回退变体，保留已拿到的 AI 档案，
   *   不污染降级缓存（档案仍有 AI 质量，health 不该谎报成「本地模式」）
   */
  private async runStyleAnalysis(
    palette: ExtractedPalette,
    buffer: Buffer,
  ): Promise<{
    source: StyleSource;
    variationsSource: StyleSource;
    profile: StyleProfile;
    variations: StyleVariation[];
  }> {
    const key = this.claude.providerKey;
    // 像素派生的本地档案：既是最坏情况的降级结果，也是 AI 档案缺字段时的回退来源。
    // buildLocalProfile 的输出本就完整合法（hex 全部来自 toHex），无需再过归一化。
    const localProfile = buildLocalProfile(palette);
    if (this.claude.available && !this.isAiCachedDown(key)) {
      // 送模型前的本地预处理（sharp 缩放/转码）。它失败是图片本身的问题，
      // 与 AI 无关 —— 不能写降级缓存，否则会把「AI 调用失败」的错误提示
      // 扣到一张 sharp 处理不了的图片头上，并连带停掉真正可用的 AI。
      let image: PreparedImage | null = null;
      try {
        image = await prepareImageForClaude(buffer);
      } catch (error) {
        this.logger.warn(
          `图片预处理失败，本次跳过 AI 分析（不影响 AI 可用性）：${error instanceof Error ? error.message : String(error)}`,
        );
      }

      let profile: StyleProfile | null = null;
      if (image) {
        // 收窄后绑定成 const：闭包里不必再写非空断言
        const prepared = image;
        try {
          const analysisPrompt = buildStyleAnalysisPrompt(palette.colors);
          profile = this.normalizeProfile(
            await this.callAiWithRetry('样式分析', () =>
              this.claude.analyzeStyle(
                { base64: prepared.base64, mediaType: prepared.mediaType },
                palette.colors,
                analysisPrompt,
              ),
            ),
            localProfile,
          );
        } catch (error) {
          this.recordFailure(key, error, '样式分析');
        }
      }

      if (profile) {
        const variations = await this.generateAiVariations(profile);
        if (variations) {
          return { source: 'ai', variationsSource: 'ai', profile, variations };
        }
        this.logger.warn('AI 变体生成未成功，保留 AI 样式档案，仅变体回退为本地模板');
        return {
          source: 'ai',
          variationsSource: 'local',
          profile,
          variations: this.normalizeVariations(buildLocalVariations(profile), profile),
        };
      }
    }
    return {
      source: 'local',
      variationsSource: 'local',
      profile: localProfile,
      variations: this.normalizeVariations(buildLocalVariations(localProfile), localProfile),
    };
  }

  /**
   * 调 AI 并重试一次。
   *
   * 实测当前网关/模型会随机返回无效输出（同一个模型、同一张图，前一次成功
   * 后一次就可能返回空结构），直接重试的命中率可观。连接/鉴权/限流类失败
   * 重试无意义（只会再白等一个超时），立即放弃。
   *
   * @throws 重试机会用尽或失败不可重试时，抛出最后一次的原始错误
   */
  private async callAiWithRetry<T>(label: string, call: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        const kind = classifyAiFailure(error);
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.warn(`AI ${label}第 ${attempt} 次失败（${kind}）：${detail}`);
        if (attempt >= StyleService.AI_MAX_ATTEMPTS || !StyleService.RETRYABLE_FAILURES.has(kind)) {
          throw error;
        }
      }
    }
  }

  /**
   * 生成 AI 变体。
   * @returns 有效变体；重试用尽仍失败返回 null（由调用方回退本地变体，
   *   注意此时**不写降级缓存** —— 档案仍是 AI 的，health 不该谎报成本地模式）
   */
  private async generateAiVariations(profile: StyleProfile): Promise<StyleVariation[] | null> {
    const prompt = buildVariationGenerationPrompt(profile);
    try {
      return await this.callAiWithRetry('变体生成', async () =>
        this.normalizeVariations(await this.claude.generateVariations(profile, prompt), profile),
      );
    } catch {
      // 每次尝试已在 callAiWithRetry 里记过日志，这里只负责降级
      return null;
    }
  }

  /** 记录 AI 失败并写入降级缓存（TTL 按失败类型区分） */
  private recordFailure(key: string, error: unknown, action: string): void {
    const kind = classifyAiFailure(error);
    const reason = error instanceof Error ? error.message : String(error);
    if (key) this.aiFailureCache.set(key, { kind, reason, failedAt: Date.now() });
    const ttlMinutes = StyleService.AI_RETRY_TTL_MS[kind] / 60000;
    this.logger.warn(
      `AI ${action}失败，降级为本地分析（${kind}，${ttlMinutes} 分钟内不再重试该模型）：${reason}`,
    );
  }

  private isAiCachedDown(key: string): boolean {
    return this.activeFailure(key) !== null;
  }

  /** 缓存期内返回失败记录，否则返回 null */
  private activeFailure(key: string): AiFailure | null {
    if (!key) return null;
    const failure = this.aiFailureCache.get(key);
    if (!failure) return null;
    if (Date.now() - failure.failedAt >= StyleService.AI_RETRY_TTL_MS[failure.kind]) {
      return null;
    }
    return failure;
  }

  /**
   * 防御性归一化：模型输出可能有缺字段/多字段，保证后续导出不崩。
   *
   * `fallback` 传像素派生的本地档案：颜色是**确定性**要求最高的字段
   * （见 extractors/color-extractor 的设计说明 —— 颜色必须来自像素，
   * 不能依赖大模型猜），所以模型漏给/给错时回退到真实检测色，而不是
   * 塞一个通用灰。
   */
  private normalizeProfile(input: StyleProfile, fallback: StyleProfile): StyleProfile {
    const palette = input?.colorPalette ?? {};
    const typography = input?.typography ?? {};
    const spacing = input?.spacing ?? {};
    const layout = input?.layout ?? {};
    const texture = input?.textureMood ?? {};
    const fb = fallback.colorPalette;

    return {
      colorPalette: {
        primary: normalizeColor(palette.primary, fb.primary),
        background: normalizeColor(palette.background, fb.background),
        accent: normalizeColor(palette.accent, fb.accent),
        scale: normalizeColorScale(palette.scale, fb.scale),
        // 只进导出文本（style-guide / 生图提示词的 mood 段），非字符串同样会拼成 "[object Object]"
        mood: normalizeText(palette.mood, ''),
      },
      typography: {
        familyTrait: normalizeText(typography.familyTrait, '无衬线'),
        // 会被拼进 font-family（`"${suggestedFont}", ...`），引号/分号/换行会让整条声明失效
        suggestedFont: normalizeFontName(typography.suggestedFont) ?? undefined,
        // 权重和行高必须是正数：0/负数会让 `font` 简写整条失效
        weights: isNumberArray(typography.weights)
          ? typography.weights.filter(isValidFontWeight)
          : [],
        hierarchy: this.normalizeTypeHierarchy(typography.hierarchy),
        lineHeight: normalizePositiveNumber(typography.lineHeight, 1.5),
      },
      spacing: {
        unit: normalizePositiveNumber(spacing.unit, 8),
        // 负数间距会导出成 `--space--4` 这种无效变量，直接丢掉
        scale: isNumberArray(spacing.scale)
          ? spacing.scale.filter((value) => value > 0)
          : [4, 8, 16, 24, 48],
        density: normalizeDensity(spacing.density, 'comfortable'),
      },
      layout: {
        composition: normalizeText(layout.composition, ''),
        regions: normalizeStringArray(layout.regions),
        grid: normalizeGrid(layout.grid),
        balance: normalizeText(layout.balance, ''),
      },
      textureMood: {
        // radius / shadow 会被原样写进 `--radius` / `--shadow`，非法值让浏览器丢弃整条声明
        radius: normalizeRadius(texture.radius, fallback.textureMood.radius),
        shadow: normalizeShadow(texture.shadow, fallback.textureMood.shadow),
        gradient: normalizeOptionalText(texture.gradient),
        density: normalizeText(texture.density, 'comfortable'),
        keywords: normalizeStringArray(texture.keywords),
      },
      styleGuideText: normalizeText(input?.styleGuideText, ''),
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
        weight: isValidFontWeight(h.weight) ? h.weight : 400,
        // 会被写进 `--font-<id>-letter-spacing`：区间写法（真实调用实测 '-0.03em ~ -0.02em'）
        // 等非法值会让浏览器丢掉整条声明，按缺失处理（CSS 里就是默认的 normal）。
        letterSpacing: isCssLength(h.letterSpacing) ? h.letterSpacing.trim() : undefined,
      }));
  }
}

/**
 * 颜色归一化：模型可能返回缺 hex、或 'white' 这类解析不出来的写法。
 *
 * 必须有这道兜底：AI 档案会流进 `local-style` 的变体模板，而那里用的
 * `hexToRgb` 约定「输入一定是合法 hex」，对非法值**静默返回黑色** ——
 * 少了这层校验，模型偶尔抽风就会渲染出全黑变体、并污染 CSS 导出。
 * 判定交给 `isUsableColor`（严格，不猜颜色）。
 *
 * `role` 也会兜底：它被直接插进样式说明与生图提示词，缺了会导出成 "undefined"。
 */
function normalizeColor(value: StyleColor | undefined, fallback: StyleColor): StyleColor {
  if (!value || typeof value !== 'object') return fallback;
  const role = typeof value.role === 'string' && value.role.trim() ? value.role : fallback.role;
  if (typeof value.hex === 'string' && isUsableColor(value.hex)) {
    return { ...value, role };
  }
  // hex 不合格 → 整个颜色退回像素派生值。approxName 必须跟着一起换：
  // 它是颜色名的确定性描述，若只换 hex 会渲染出「#ff0000 · 白色」这种自相矛盾的展示
  // （style-lab 会把它跟在色值后面显示）。
  return { ...fallback, role };
}

/**
 * 模型给的字符串字段可能不是字符串（schema 违规，与 hex 给 'white' 同类）。
 * `?? ` 只挡 null/undefined：`familyTrait` 非字符串会让 `familyTrait.toLowerCase()`
 * 直接抛 TypeError（整个 analyze 500），其余走这里的字段（mood / composition /
 * balance / density / styleGuideText）会被模板字符串拼成 "[object Object]" 写进导出文案。
 * 空白串按缺失处理，与 `normalizeColor` 对 `role` 的判法一致。
 */
function normalizeText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/**
 * 可空文本：非字符串或空白串一律当作「没有」。
 *
 * 用于 `gradient` / `suggestedFont` 这类既可缺省、又会被拼进导出文本的字段 ——
 * `?? null` 只挡 null/undefined，模型给个对象就会导出成 `texture: 8px radius, none, [object Object]`。
 */
function normalizeOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * 字符串数组：丢掉非字符串与空白项，而不是整块回退。
 *
 * `regions` / `keywords` 只进导出文本（style-guide 的「区域：」「风格标签」、
 * 生图提示词的 `style:` 段），少一项远好过在文案里出现 `[object Object]`；
 * 这一点与 `normalizeColorScale` 的「整块不可信就整体回退」不同 —— 那里回退是因为
 * 颜色还要参与对比度计算，半个色板会算出错误结论。
 */
function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && !!item.trim())
    : [];
}

/** tool schema 对 `spacing.density` 限定的取值（见 STYLE_PROFILE_INPUT_SCHEMA） */
const SPACING_DENSITIES = ['compact', 'comfortable', 'loose'] as const;

/**
 * 单个 CSS 长度：`0` 可省略单位，其余必须带单位（`8` 在 CSS 里非法）。
 * 只做形状判定，不校验单位与数值的合理性（CSS 本身也不管 `999999px`）。
 */
const CSS_LENGTH =
  /^(?:0|-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|%|vh|vw|vmin|vmax|ch|ex|pt|pc|in|cm|mm|q))$/i;

/** 是否单个合法 CSS 长度（如 `-0.02em`、`0`）。用于 letter-spacing 这类只收一个值的属性 */
function isCssLength(value: unknown): value is string {
  return typeof value === 'string' && CSS_LENGTH.test(value.trim());
}

/**
 * 圆角归一化：接受 1–4 个 CSS 长度，允许 `水平 / 垂直` 两段（`12px / 24px`）。
 *
 * 真实调用实测：模型会把这个字段当"描述"填 ——
 *   radius: '矩形 0px 硬角，圆为完美正圆，无任何中间圆角规格'
 * 它会被原样写进 `--radius`，浏览器整条丢弃（`CSS.supports('border-radius', …)` 实测为
 * false），导出的 token 看着成功、实际少了圆角这一项。回退值取**像素派生的本地档案**
 * 里的圆角，与颜色同一原则：能确定性算出来的东西不交给模型猜，也不硬编码一个通用值。
 *
 * 斜杠两段必须支持：`12px / 24px` 是合法 CSS（`CSS.supports` 实测为真），
 * 只按空白切分会把这种合法值误判成散文、白白丢掉模型给的值。
 */
function normalizeRadius(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  const groups = trimmed.split('/');
  if (groups.length > 2) return fallback;
  const isLengthList = (group: string) => {
    const parts = group.trim().split(/\s+/);
    return parts.length <= 4 && parts.every(isCssLength);
  };
  return groups.every(isLengthList) ? trimmed : fallback;
}

/**
 * 阴影归一化：`none`，或"不含中日韩文字且至少有一个 CSS 长度"的值。
 *
 * 不做完整 box-shadow 语法解析，两道判据各自挡一类实测过的散文：
 * - 至少一个长度：任何合法的非 none 阴影都至少有一个长度偏移，而
 *   '无投影、无内外阴影，纯平涂矢量块面' 一个长度都没有；
 * - 不含中日韩文字：只判长度会漏掉"说明里夹着长度"的写法，例如
 *   '轻微阴影，模糊 8px' —— 它含 `8px` 却仍是散文，`CSS.supports('box-shadow', …)`
 *   实测 false，浏览器照样丢弃。提示词是中文、散文必为中文，而合法的阴影值
 *   （长度/关键字/颜色）不含中日韩文字，这条判据不会有误伤。
 *
 * 回退理由同 `normalizeRadius`。
 */
const CJK_IN_VALUE = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

function normalizeShadow(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (/^none$/i.test(trimmed)) return trimmed;
  if (CJK_IN_VALUE.test(trimmed)) return fallback;
  return trimmed.split(/[\s,]+/).some(isCssLength) ? trimmed : fallback;
}

/**
 * 密度归一化：越界值按 schema 违规兜底，不能像自由文本那样原样放行。
 *
 * 前端拿这个值查 `DENSITY_LABELS` 渲染中文标签（style-lab），越界值会直接显示成
 * 模型原文（英文）或 "undefined"；`Record<StyleProfile['spacing']['density'], string>`
 * 的声明也要求运行时确实只有这三档。
 */
function normalizeDensity(
  value: unknown,
  fallback: StyleSpacing['density'],
): StyleSpacing['density'] {
  return (SPACING_DENSITIES as readonly unknown[]).includes(value)
    ? (value as StyleSpacing['density'])
    : fallback;
}

/** 模型给的数值字段可能不是数字；非有限数一律回退，避免导出 `--space-NaN: NaNpx` */
function normalizeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 行高、间距这类字段只接受正数：CSS 里的 0/负值会让整条声明失效 */
function normalizePositiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** CSS font-weight 的取值范围是 1–1000，越界值会让 `font` 简写整条失效 */
function isValidFontWeight(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 1000;
}

/**
 * 字体名会被放进 `font-family` 的双引号里，引号/分号/花括号/换行可以提前闭合
 * 字符串并污染后面的声明；这里只保留可安全放进带引号字符串的字符。
 */
function normalizeFontName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/["'`\\;{}\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, 80) : null;
}

/**
 * 栅格归一化：`columns` 不是有限数时整块置空，而不是塞个默认栏数。
 *
 * 必须查有限性：`typeof NaN === 'number'` 为真，只判 typeof 会让 NaN 一路走到前端
 * 渲染成「NaN 栏栅格」（style-lab 直接插值 `profile.layout.grid.columns`）。
 * `gutterPx` 只在有栅格时才有意义，缺失按 0 处理。
 */
function normalizeGrid(value: unknown): StyleLayout['grid'] {
  if (!value || typeof value !== 'object') return null;
  const grid = value as { columns?: unknown; gutterPx?: unknown };
  if (typeof grid.columns !== 'number' || !Number.isFinite(grid.columns)) return null;
  return { columns: grid.columns, gutterPx: normalizeNumber(grid.gutterPx, 0) };
}

/** 数值数组校验：元素必须全是有限数，否则整块不可信（同 `normalizeColorScale` 的整体回退） */
function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'number' && Number.isFinite(v));
}

/**
 * 可用颜色判定：可解析、且**不透明**。
 *
 * 不能只看 `parseColor` 的真值 —— `transparent` / `#00000000` / `rgba(0,0,0,0)`
 * 都解析成 `{r:0,g:0,b:0,a:0}`（真值），但下游 `hexToRgb` 会丢掉 alpha 当成纯黑：
 * 变体模板据此按"黑底"算出浅色文字，CSS 又原样导出全透明背景，最终文字看不见 ——
 * 正是这道守卫要防的事。半透明同理（alpha 被丢弃后计算结果与 CSS 渲染不一致），
 * 一并回退到像素色板：那里全是 `toHex` 产出的不透明 hex，语义始终一致。
 */
function isUsableColor(value: string): boolean {
  return parseColor(value)?.a === 1;
}

/**
 * 色板归一化：`scale` 会被 CSS 导出器直接当作颜色值写进 `--color-text` /
 * `--color-muted`（css-tokens.exporter），所以每一项都必须是可解析的**不透明**
 * 颜色（判定同 `isUsableColor`），否则浏览器会静默丢弃整条声明、或让 alpha 被
 * `hexToRgb` 丢弃后与渲染结果对不上。任何一项不合格就整体回退到像素色板。
 */
function normalizeColorScale(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value) || value.length === 0) return fallback;
  const colors = value.filter((c): c is string => typeof c === 'string' && isUsableColor(c));
  return colors.length === value.length ? colors : fallback;
}
