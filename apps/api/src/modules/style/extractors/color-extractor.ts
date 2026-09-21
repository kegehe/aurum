/**
 * 颜色提取与图片预处理
 *
 * 设计决策：颜色值必须"确定性"，不能依赖大模型猜测 HEX。
 * 因此用 sharp 对像素做 5-bit 量化桶统计，取出现频率最高的颜色，
 * 计算桶内平均色作为最终 HEX。大模型只负责对这些颜色做语义命名和角色分配。
 */
import sharp from 'sharp';

export interface ExtractedPalette {
  /** 主导颜色 HEX，按出现频率从高到低 */
  colors: string[];
  width: number;
  height: number;
  format: string;
}

export interface PreparedImage {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  width: number;
  height: number;
  format: string;
}

/** 取色分析用最大边长（越小越快；样式分析不需要超高分辨率） */
const PALETTE_MAX_DIMENSION = 512;
/** 送 Claude 的最大边长（Claude 限制 8000px，2048 足够样式分析且控制成本） */
const CLAUDE_MAX_DIMENSION = 2048;
/** 返回的主导颜色数量 */
const PALETTE_COLOR_COUNT = 12;

/**
 * 从图片提取主导颜色（5-bit 量化桶 + 桶内平均）
 * @param input sharp 支持的输入（Buffer / 文件路径）
 */
export async function extractPalette(
  input: Buffer | string,
  count: number = PALETTE_COLOR_COUNT,
): Promise<ExtractedPalette> {
  const pipeline = sharp(input);
  const meta = await pipeline.metadata();
  if (!meta.width || !meta.height) {
    throw new Error('无法读取图片尺寸，可能不是有效的图片文件');
  }

  const { data, info } = await pipeline
    .rotate() // 尊重 EXIF 方向
    .resize(PALETTE_MAX_DIMENSION, PALETTE_MAX_DIMENSION, { fit: 'inside' })
    .flatten({ background: '#ffffff' }) // 先合成白色背景，避免透明像素（RGB 常为黑）污染色板
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  const step = info.channels; // raw 输出通道数（1/3/4）
  const buckets = new Map<number, { sumR: number; sumG: number; sumB: number; count: number }>();

  for (let i = 0; i + step <= data.length; i += step) {
    const r = data[i];
    const g = step > 1 ? data[i + 1] : r;
    const b = step > 2 ? data[i + 2] : r;
    // 5-bit 量化：每通道 3 位偏移 -> 27 位 key
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let entry = buckets.get(key);
    if (!entry) {
      entry = { sumR: 0, sumG: 0, sumB: 0, count: 0 };
      buckets.set(key, entry);
    }
    entry.sumR += r;
    entry.sumG += g;
    entry.sumB += b;
    entry.count += 1;
  }

  const sorted = [...buckets.entries()].sort((a, b) => b[1].count - a[1].count);
  const colors = sorted.slice(0, count).map(([, entry]) => {
    const r = Math.round(entry.sumR / entry.count);
    const g = Math.round(entry.sumG / entry.count);
    const b = Math.round(entry.sumB / entry.count);
    return toHex(r, g, b);
  });

  return { colors, width: meta.width, height: meta.height, format: meta.format ?? 'unknown' };
}

/**
 * 将图片预处理为 Claude API 可接收的 base64
 * - 旋转纠正 EXIF 方向
 * - 最长边缩放至 CLAUDE_MAX_DIMENSION
 * - 保留 png/gif/webp，其余转 jpeg（SVG 会被 sharp 栅格化）
 */
export async function prepareImageForClaude(input: Buffer | string): Promise<PreparedImage> {
  const pipeline = sharp(input);
  const meta = await pipeline.metadata();
  if (!meta.width || !meta.height) {
    throw new Error('无法读取图片尺寸，可能不是有效的图片文件');
  }

  const sourceFormat = meta.format ?? 'jpeg';
  const format: 'png' | 'gif' | 'webp' | 'jpeg' = ['png', 'gif', 'webp'].includes(sourceFormat)
    ? (sourceFormat as 'png' | 'gif' | 'webp')
    : 'jpeg';

  const buffer = await pipeline
    .rotate()
    .resize(CLAUDE_MAX_DIMENSION, CLAUDE_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }) // 与取色一致：透明底合成白底，样式呈现更接近用户观感
    .toFormat(format, format === 'jpeg' ? { quality: 92 } : {})
    .toBuffer();

  return {
    base64: buffer.toString('base64'),
    mediaType: `image/${format}`,
    width: meta.width,
    height: meta.height,
    format: sourceFormat,
  };
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}
