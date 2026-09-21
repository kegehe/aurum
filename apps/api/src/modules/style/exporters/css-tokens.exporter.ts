/**
 * CSS Design Tokens 导出器
 *
 * 将 StyleProfile 转为可直接复制进任意前端项目的 CSS 自定义属性。
 * 字体按"气质"映射为可用系统字体栈，模型给出建议字体名时优先使用。
 */
import type { StyleProfile } from '../types';

function fallbackFontStack(familyTrait: string): string {
  const t = familyTrait.toLowerCase();
  // 注意："无衬线" 含子串 "衬线"，必须先判断 无衬线/sans，再判断 衬线/serif
  if (t.includes('无衬线') || t.includes('sans')) {
    return "system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  }
  if (t.includes('衬线') || t.includes('serif')) {
    return "Georgia, 'Times New Roman', 'Songti SC', 'SimSun', serif";
  }
  if (t.includes('等宽') || t.includes('mono')) {
    return "ui-monospace, 'Cascadia Mono', Consolas, 'Sarasa Mono SC', monospace";
  }
  // 默认无衬线
  return "system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif";
}

/** 将 role 转为 CSS 变量名安全片段；中文等不可用字符回退为 level-N */
function roleToCssId(role: string, index: number): string {
  const slug = role
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `level-${index}`;
}

export function buildCssTokens(profile: StyleProfile): string {
  const palette = profile.colorPalette;
  const typography = profile.typography;
  const spacing = profile.spacing;
  const texture = profile.textureMood;

  const fontFamily = typography.suggestedFont
    ? `"${typography.suggestedFont}", ${fallbackFontStack(typography.familyTrait)}`
    : fallbackFontStack(typography.familyTrait);

  const hierarchyLines = typography.hierarchy
    .map((h, i) => {
      const size = Math.round(h.sizePx);
      return `  --font-${roleToCssId(h.role, i)}: ${h.weight} ${size}px/${typography.lineHeight} ${h.letterSpacing ? `${h.letterSpacing}` : 'normal'};`;
    })
    .join('\n');

  return `/* 样式实验室导出的 Design Tokens —— 复制到你的项目 :root 即可使用 */
:root {
  /* 色彩 */
  --color-primary: ${palette.primary.hex};
  --color-background: ${palette.background.hex};
  --color-accent: ${palette.accent?.hex ?? palette.scale[2] ?? '#000000'};
  --color-text: ${palette.scale[0] ?? '#111111'};
  --color-muted: ${palette.scale[1] ?? '#888888'};

  /* 字体 */
  --font-family: ${fontFamily};
  --line-height: ${typography.lineHeight};
${hierarchyLines}

  /* 间距 */
  --space-unit: ${spacing.unit}px;
${spacing.scale.map((s) => `  --space-${Math.round(s)}: ${Math.round(s)}px;`).join('\n')}

  /* 圆角与阴影 */
  --radius: ${texture.radius};
  --shadow: ${texture.shadow};
}`;
}
