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

export interface StyleImageInfo {
  width: number;
  height: number;
  format: string;
}

export interface StyleAnalyzeResult {
  /** 结果来源，前端据此展示 "AI 分析 / 本地分析" */
  source: StyleSource;
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
        suggestedFont: { type: 'string' },
        weights: { type: 'array', items: { type: 'number' } },
        hierarchy: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string' },
              sizePx: { type: 'number' },
              weight: { type: 'number' },
              letterSpacing: { type: 'string' },
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
        radius: { type: 'string' },
        shadow: { type: 'string' },
        gradient: { type: ['string', 'null'] },
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
