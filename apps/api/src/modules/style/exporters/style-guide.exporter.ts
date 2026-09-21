/**
 * 风格文案导出器
 *
 * 将 StyleProfile 输出为一段可直接用于设计沟通 / 喂给其它 LLM 的风格描述。
 */
import type { StyleProfile } from '../types';

export function buildStyleGuide(profile: StyleProfile): string {
  const palette = profile.colorPalette;
  const typography = profile.typography;
  const layout = profile.layout;
  const texture = profile.textureMood;

  const lines = [
    '# 风格描述（Style Guide）',
    '',
    `**风格标签**：${texture.keywords.join(' / ')}`,
    '',
    `**色彩**：主色 ${palette.primary.hex}（${palette.primary.role}），背景 ${palette.background.hex}（${palette.background.role}）${palette.accent?.hex ? `，强调色 ${palette.accent.hex}（${palette.accent.role}）` : ''}。${palette.mood}。`,
    '',
    `**字体**：${typography.familyTrait}${typography.suggestedFont ? `（建议字体：${typography.suggestedFont}）` : ''}。层级：${typography.hierarchy.map((h) => `${h.role} ${h.sizePx}px/${h.weight}`).join('，')}，行高 ${typography.lineHeight}。`,
    '',
    `**布局**：${layout.composition}。区域：${layout.regions.join('、')}。${layout.balance ? `视觉重心：${layout.balance}。` : ''}`,
    '',
    `**质感**：圆角 ${texture.radius}，阴影 ${texture.shadow}${texture.gradient ? `，渐变 ${texture.gradient}` : ''}。视觉密度：${texture.density}。`,
    '',
    '---',
    '',
    profile.styleGuideText,
  ];

  return lines.join('\n');
}
