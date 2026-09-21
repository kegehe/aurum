/**
 * 生图提示词导出器
 *
 * 确定性模板拼接，不调用 AI。核心原则：
 * - 颜色用 HEX 直写（生图模型对 HEX 的遵循度高于颜色名词）
 * - 字体描述"气质"而非字体名
 * - 提示词负责构图与风格气质，原图参考负责锁死细节（见 referenceNote）
 */
import type { StyleImagePrompt, StyleProfile, StyleVariation } from '../types';

const FALLBACK_AR = '16:9';

export function buildImagePrompt(
  profile: StyleProfile,
  variation: Pick<StyleVariation, 'composition'>,
): StyleImagePrompt {
  const palette = profile.colorPalette;
  const typography = profile.typography;
  const texture = profile.textureMood;

  const paletteParts = [
    palette.primary?.hex ? `${palette.primary.hex} ${palette.primary.role}` : '',
    palette.background?.hex ? `${palette.background.hex} ${palette.background.role}` : '',
    palette.accent?.hex ? `${palette.accent.hex} ${palette.accent.role}` : '',
  ].filter(Boolean);

  // 每个 token 单独守卫，避免空值拼出 "style: " 这类无意义片段
  const base = [
    '{subject placeholder}',
    texture.keywords?.length ? `style: ${texture.keywords.join(', ')}` : '',
    paletteParts.length ? `color palette: ${paletteParts.join(', ')}` : '',
    typography.familyTrait
      ? `typography: ${typography.familyTrait}${typography.suggestedFont ? ` (${typography.suggestedFont})` : ''}`
      : '',
    variation.composition ? `composition: ${variation.composition}` : '',
    texture.gradient
      ? `texture: ${texture.radius} radius, ${texture.shadow}, ${texture.gradient}`
      : `texture: ${texture.radius} radius, ${texture.shadow}`,
    palette.mood ? `mood: ${palette.mood}` : '',
  ].filter(Boolean);

  const promptBase = base.join(', ');

  return {
    midjourney: `${promptBase}\n--ar ${FALLBACK_AR} --stylize 100 --sref <原图URL> --iw 1.0`,
    stableDiffusion: `(masterpiece, best quality:1.2), ${promptBase}\nNegative prompt: lowres, bad anatomy, bad hands, text, watermark, jpeg artifacts`,
    flux: `High quality, ${promptBase}. Use the reference image for style consistency.`,
    referenceNote:
      '生图时务必同时提供原图作为风格参考：Midjourney 用 --sref，SD/Flux 用 img2img 或 reference。文字提示词负责构图与风格气质，原图负责锁死样式细节，两者缺一不可。',
  };
}
