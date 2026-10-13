/**
 * 颜色解析与 WCAG 对比度计算
 *
 * 抽到 common 是因为两处都需要，且原实现各缺一半：
 * - style 模块（local-style.ts）只认 hex，且 `hexToRgb` 对非法输入静默返回黑色
 * - design 模块的 color token 允许 hex / rgb() / hsl() / transparent / currentColor
 *   直接喂旧的 hexToRgb 会把 rgb()/hsl() 全算成黑色，得出**反向**的对比度结论
 *
 * 所以这里的 `parseColor` 是严格且覆盖全格式的：解析不出来返回 null，
 * 绝不猜一个颜色出来。调用方必须显式处理"无法判定"。
 *
 * 参考：https://www.w3.org/TR/WCAG22/
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Rgba extends Rgb {
  a: number;
}

/** WCAG 2.2 AA：正文文本 4.5:1，大号文本 3:1 */
export const WCAG_AA_NORMAL_TEXT = 4.5;
export const WCAG_AA_LARGE_TEXT = 3;
/** WCAG 2.2 AA 1.4.11：非文本内容（边框、图标等）3:1 */
export const WCAG_AA_NON_TEXT = 3;
/** 大号文本的判定门槛（CSS px） */
export const LARGE_TEXT_PX = 24;
export const LARGE_TEXT_BOLD_PX = 18.66;

const HEX_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_PATTERN = /^rgba?\(([^)]+)\)$/i;
const HSL_PATTERN = /^hsla?\(([^)]+)\)$/i;

/**
 * 解析 CSS 颜色。
 *
 * 覆盖 design color token 允许的全部格式。返回 null 表示**无法判定**：
 * 要么语法非法（例如 5/7 位 hex —— 正则 `{3,8}` 会放行但浏览器丢弃整条声明），
 * 要么是 `currentColor` 这类需要上下文才能确定的写法。
 * `transparent` 返回 a=0 —— 它是确定的，只是需要背景才能合成。
 */
export function parseColor(value: string): Rgba | null {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  if (!input) return null;

  const keyword = input.toLowerCase();
  if (keyword === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  // currentColor 取决于同一声明块里的 color，本函数无法独立判定
  if (keyword === 'currentcolor') return null;

  const hex = HEX_PATTERN.exec(input);
  if (hex) return parseHex(hex[1]);

  const rgb = RGB_PATTERN.exec(input);
  if (rgb) return parseRgbFunction(rgb[1]);

  const hsl = HSL_PATTERN.exec(input);
  if (hsl) return parseHslFunction(hsl[1]);

  return null;
}

function parseHex(digits: string): Rgba {
  const expand = (part: string) => parseInt(part.repeat(2), 16);
  if (digits.length <= 4) {
    return {
      r: expand(digits[0]),
      g: expand(digits[1]),
      b: expand(digits[2]),
      a: digits.length === 4 ? expand(digits[3]) / 255 : 1,
    };
  }
  return {
    r: parseInt(digits.slice(0, 2), 16),
    g: parseInt(digits.slice(2, 4), 16),
    b: parseInt(digits.slice(4, 6), 16),
    a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
  };
}

function splitChannels(body: string): string[] | null {
  // 允许逗号或空格分隔，且容忍逗号两侧空白
  const parts = body
    .replace(/\//g, ' ')
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  return parts;
}

function parseAlpha(raw: string | undefined): number | null {
  if (raw === undefined) return 1;
  const value = raw.endsWith('%') ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);
  if (!Number.isFinite(value)) return null;
  return clamp01(value);
}

function parseRgbFunction(body: string): Rgba | null {
  const parts = splitChannels(body);
  if (!parts) return null;
  const [r, g, b] = parts.slice(0, 3).map((part) => parseChannel(part));
  const alpha = parseAlpha(parts[3]);
  if (r === null || g === null || b === null || alpha === null) return null;
  return { r, g, b, a: alpha };
}

function parseChannel(raw: string): number | null {
  // 只接受纯数字或百分比；`calc()` 等一律当作无法判定
  const value = raw.endsWith('%') ? (Number.parseFloat(raw) / 100) * 255 : Number.parseFloat(raw);
  if (!Number.isFinite(value)) return null;
  // CSS 会把越界值 clamp，判非法就与浏览器行为不一致了
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseHslFunction(body: string): Rgba | null {
  const parts = splitChannels(body);
  if (!parts) return null;
  const hue = Number.parseFloat(parts[0]);
  const saturation = parsePercent(parts[1]);
  const lightness = parsePercent(parts[2]);
  const alpha = parseAlpha(parts[3]);
  if (!Number.isFinite(hue) || saturation === null || lightness === null || alpha === null) {
    return null;
  }
  return { ...hslToRgb(hue, saturation, lightness), a: alpha };
}

function parsePercent(raw: string): number | null {
  const value = raw.endsWith('%') ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);
  if (!Number.isFinite(value)) return null;
  return clamp01(value);
}

function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
  const h = ((hue % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lightness - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** 把前景按其 alpha 合成到背景之上（背景必须不透明） */
export function compositeOver(foreground: Rgba, background: Rgb): Rgb {
  const a = clamp01(foreground.a);
  return {
    r: foreground.r * a + background.r * (1 - a),
    g: foreground.g * a + background.g * (1 - a),
    b: foreground.b * a + background.b * (1 - a),
  };
}

/**
 * WCAG 相对亮度（0-1）
 *
 * 阈值取 0.04045（WCAG 2.1 及 2.2 的写法）。style 模块原实现用的是
 * 2.0 时代的 0.03928，一并对齐。
 */
export function relativeLuminance(color: Rgb): number {
  const [r, g, b] = [color.r, color.g, color.b].map((channel) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 对比度比值 (L1+0.05)/(L2+0.05)，范围 1..21。两者都必须已是不透明 RGB */
export function contrastRatio(left: Rgb, right: Rgb): number {
  const a = relativeLuminance(left);
  const b = relativeLuminance(right);
  const [lighter, darker] = a >= b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

/** 大号文本判定：≥24px，或 ≥18.66px 且 bold（WCAG 2.2 定义） */
export function isLargeText(fontSizePx: number | null, fontWeight: number | null): boolean {
  if (fontSizePx === null || !Number.isFinite(fontSizePx)) return false;
  if (fontSizePx >= LARGE_TEXT_PX) return true;
  const bold = fontWeight === null ? false : fontWeight >= 700;
  return bold && fontSizePx >= LARGE_TEXT_BOLD_PX;
}

export function meetsWcagAA(ratio: number, options: { largeText?: boolean } = {}): boolean {
  return ratio >= (options.largeText ? WCAG_AA_LARGE_TEXT : WCAG_AA_NORMAL_TEXT);
}

export type ContrastVerdict =
  | { status: 'pass' | 'fail'; ratio: number; threshold: number }
  | { status: 'undeterminable'; reason: string };

/**
 * 判定一对颜色的对比度。
 *
 * 语义要点：
 * - 前景带 alpha 时先合成到背景上再算，否则半透明前景会被算出**反向**的结论
 *   （`rgba(255,255,255,0.35)` 压深蓝背景，忽略 alpha 得 8.6:1 通过，实际约 2.4:1 失败）
 * - 背景带 alpha 时无法知道背后是什么 → 报"无法判定"，而不是猜
 */
export function evaluateContrast(
  foreground: string,
  background: string,
  options: { largeText?: boolean } = {},
): ContrastVerdict {
  const fg = parseColor(foreground);
  if (!fg) return { status: 'undeterminable', reason: `无法解析前景色: ${foreground}` };
  const bg = parseColor(background);
  if (!bg) return { status: 'undeterminable', reason: `无法解析背景色: ${background}` };
  if (bg.a < 1) {
    return { status: 'undeterminable', reason: `背景色带透明度，需背景才能判定: ${background}` };
  }

  const threshold = options.largeText ? WCAG_AA_LARGE_TEXT : WCAG_AA_NORMAL_TEXT;
  const ratio = contrastRatio(compositeOver(fg, bg), bg);
  return { status: ratio >= threshold ? 'pass' : 'fail', ratio, threshold };
}

/**
 * 宽松的 hex 解析（仅 hex，非法输入回退黑色）
 *
 * 保留给 style 模块的既有调用点使用：那里的输入全由本模块的 `toHex` 生成，
 * 一定是合法 hex，不需要承担"无法判定"的语义。**新代码请用 `parseColor`。**
 */
export function hexToRgb(hex: string): Rgb {
  const parsed = parseColor(hex);
  if (!parsed) return { r: 0, g: 0, b: 0 };
  return { r: parsed.r, g: parsed.g, b: parsed.b };
}
