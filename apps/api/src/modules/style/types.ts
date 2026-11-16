/**
 * 样式分析模块类型定义
 *
 * 该模块实现"样式实验室"：对一张图片做视觉样式分析（只看样式不看内容），
 * 输出规范化 StyleProfile，再据此生成多种布局变体，并导出可在其它系统
 * （AI 生图 / 网页）还原样式的提示词包。
 */
import type Anthropic from '@anthropic-ai/sdk';

type ToolInputSchema = Anthropic.Tool.InputSchema;

// ==================== 样式档案 ====================

export interface StyleColor {
  hex: string;
  role: string;
  approxName?: string;
}

export interface StyleColorPalette {
  primary: StyleColor;
  background: StyleColor;
  accent: StyleColor;
  /** 完整有序色板（主导到次要），全部来自像素检测 */
  scale: string[];
  /** 色彩情绪描述 */
  mood: string;
}

export interface StyleTypeHierarchy {
  role: string;
  sizePx: number;
  weight: number;
  letterSpacing?: string;
}

export interface StyleTypography {
  /** 字体家族气质（如"高对比几何无衬线"） */
  familyTrait: string;
  /** 模型建议的具体字体名（如 Inter / Noto Sans SC），用于 CSS 导出 */
  suggestedFont?: string;
  weights: number[];
  hierarchy: StyleTypeHierarchy[];
  lineHeight: number;
}

export interface StyleSpacing {
  unit: number;
  scale: number[];
  density: 'compact' | 'comfortable' | 'loose';
}

export interface StyleLayout {
  /** 构图一句话描述 */
  composition: string;
  regions: string[];
  grid: { columns: number; gutterPx: number } | null;
  /** 视觉重心/平衡 */
  balance: string;
}

export interface StyleTextureMood {
  radius: string;
  shadow: string;
  gradient: string | null;
  density: string;
  keywords: string[];
}

export interface StyleProfile {
  colorPalette: StyleColorPalette;
  typography: StyleTypography;
  spacing: StyleSpacing;
  layout: StyleLayout;
  textureMood: StyleTextureMood;
  /** 风格文案（设计 brief），可直接用于沟通或喂给其它 LLM */
  styleGuideText: string;
}

// ==================== 布局变体 ====================

export interface StyleVariation {
  id: string;
  /** 变体名，如 "Hero 居中" */
  name: string;
  /** 对用户的一句话说明 */
  description: string;
  /** 构图结构描述（用于生图提示词） */
  composition: string;
  /** 自包含 HTML/CSS 实现（网页侧可直接复用） */
  html: string;
  /** 该变体的生图提示词（MJ / SD / Flux） */
  imagePrompt: StyleImagePrompt;
}

// ==================== 双端导出包 ====================

export interface StyleImagePrompt {
  midjourney: string;
  stableDiffusion: string;
  flux: string;
  /** 原图参考使用说明 */
  referenceNote: string;
}

/** 与变体无关、整份样式档案级别的导出 */
export interface StyleExports {
  cssTokens: string;
  styleGuide: string;
}

// ==================== 接口响应 ====================

/** 样式分析来源：AI 视觉分析 or 本地确定性分析（AI 未配置/失败时自动降级） */
export type StyleSource = 'ai' | 'local';

/**
 * AI 调用失败分类，决定降级缓存的时长。
 * 连接/鉴权类问题重试通常无济于事，缓存久一些；
 * 模型输出质量问题（网关/模型抽风返回空结构）是随机性的，只短暂退避。
 *
 * 只列 `classifyAiFailure` 真正会返回的值（`output` 是它的兜底分支）。
 * 这里不设"未知"档：`Record<AiFailureKind, number>` 会强制新档位补上 TTL，
 * 留一个永不出现的档位只会让人误以为存在这条路径。
 */
export type AiFailureKind = 'connectivity' | 'rate_limit' | 'auth' | 'capability' | 'output';

/** 当前降级详情：为什么在走本地分析、还有多久自动重试 */
export interface StyleDegradation {
  kind: AiFailureKind;
  /** 面向用户的可读原因（原始错误信息） */
  reason: string;
  /** 距自动重试的剩余毫秒数 */
  retryAfterMs: number;
}

/** AI 可用性（/style/health），前端据此决定顶部模式提示的文案 */
export interface StyleAvailability {
  /** 功能可用性：样式实验室始终可用（AI 或本地），恒为 true */
  available: boolean;
  /** 当前分析来源：ai / local */
  source: StyleSource;
  model: string;
  /** AI 已配置，但因近期失败被临时降级 —— 与「未配置」是两回事 */
  degraded: boolean;
  /** 降级详情；未降级时为 null */
  degradation: StyleDegradation | null;
}

export interface StyleImageInfo {
  width: number;
  height: number;
  format: string;
}

export interface StyleAnalyzeResult {
  /** 样式档案来源，前端据此展示 "AI 分析 / 本地分析" */
  source: StyleSource;
  /**
   * 布局变体来源。变体生成失败时不会丢弃已拿到的 AI 档案，
   * 而是保留 AI 档案 + 本地模板变体，此字段如实反映差异。
   */
  variationsSource: StyleSource;
  image: StyleImageInfo;
  /** sharp 像素级检测的主色（确定性 HEX） */
  detectedColors: string[];
  profile: StyleProfile;
  variations: StyleVariation[];
  exports: StyleExports;
}

// ==================== Tool JSON Schema ====================

/** 样式分析强制结构化输出（tool use） */
export const STYLE_PROFILE_INPUT_SCHEMA: ToolInputSchema = {
  type: 'object',
  properties: {
    colorPalette: {
      type: 'object',
      properties: {
        primary: {
          type: 'object',
          properties: {
            hex: { type: 'string' },
            role: { type: 'string' },
            approxName: { type: 'string' },
          },
          required: ['hex', 'role'],
        },
        background: {
          type: 'object',
          properties: {
            hex: { type: 'string' },
            role: { type: 'string' },
            approxName: { type: 'string' },
          },
          required: ['hex', 'role'],
        },
        accent: {
          type: 'object',
          properties: {
            hex: { type: 'string' },
            role: { type: 'string' },
            approxName: { type: 'string' },
          },
          required: ['hex', 'role'],
        },
        scale: { type: 'array', items: { type: 'string' } },
        mood: { type: 'string' },
      },
      required: ['primary', 'background', 'accent', 'scale', 'mood'],
    },
    typography: {
      type: 'object',
      properties: {
        familyTrait: { type: 'string' },
        suggestedFont: {
          type: 'string',
          description:
            '建议的具体字体名，只写字体名本身（如 Inter / Noto Sans SC），不要附加说明或括号注释',
        },
        weights: { type: 'array', items: { type: 'number' } },
        hierarchy: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string' },
              sizePx: { type: 'number' },
              weight: { type: 'number' },
              letterSpacing: {
                type: 'string',
                description: 'CSS 字距值，如 "-0.02em"；无特殊字距可省略该字段',
              },
            },
            required: ['role', 'sizePx', 'weight'],
          },
        },
        lineHeight: { type: 'number' },
      },
      required: ['familyTrait', 'hierarchy', 'lineHeight'],
    },
    spacing: {
      type: 'object',
      properties: {
        unit: { type: 'number' },
        scale: { type: 'array', items: { type: 'number' } },
        density: { type: 'string', enum: ['compact', 'comfortable', 'loose'] },
      },
      required: ['unit', 'scale', 'density'],
    },
    layout: {
      type: 'object',
      properties: {
        composition: { type: 'string' },
        regions: { type: 'array', items: { type: 'string' } },
        grid: {
          // 不设 required：模型可能省略 grid（即无栅格）或给 null/空对象
          type: ['object', 'null'],
          properties: { columns: { type: 'number' }, gutterPx: { type: 'number' } },
        },
        balance: { type: 'string' },
      },
      required: ['composition', 'regions', 'balance'],
    },
    textureMood: {
      type: 'object',
      properties: {
        radius: {
          type: 'string',
          description: 'CSS 圆角值，如 "8px"、"0"、"12px 12px 0 0"；只写值，不要写说明文字',
        },
        shadow: {
          type: 'string',
          description:
            'CSS box-shadow 值，如 "0 2px 8px rgba(0,0,0,.12)"；无阴影写 "none"。只写值，不要写说明文字',
        },
        gradient: {
          type: ['string', 'null'],
          description: 'CSS 渐变值，如 "linear-gradient(135deg, #111, #333)"；无渐变写 null',
        },
        density: { type: 'string' },
        keywords: { type: 'array', items: { type: 'string' } },
      },
      required: ['radius', 'shadow', 'keywords'],
    },
    styleGuideText: { type: 'string' },
  },
  required: ['colorPalette', 'typography', 'spacing', 'layout', 'textureMood', 'styleGuideText'],
};

/** 变体生成强制结构化输出（tool use） */
export const STYLE_VARIATIONS_INPUT_SCHEMA: ToolInputSchema = {
  type: 'object',
  properties: {
    variations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          composition: { type: 'string' },
          html: { type: 'string' },
        },
        required: ['name', 'description', 'composition', 'html'],
      },
    },
  },
  required: ['variations'],
};

export const DEFAULT_VARIATION_COUNT = 4;
