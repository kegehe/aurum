import { evaluateContrast, type ContrastVerdict } from '../../common/color/contrast';
import { flattenTokenLeaves } from './design-export';

export interface TokenContrastCheck {
  name: string;
  foreground: string;
  background: string;
  foregroundValue: string;
  backgroundValue: string;
  verdict: ContrastVerdict;
}

export interface TokenContrastReport {
  status: 'pass' | 'fail' | 'undeterminable';
  checks: TokenContrastCheck[];
}

const PAIRS: Array<{ name: string; foreground: string; background: string }> = [
  { name: '正文 / 页面', foreground: 'color.text', background: 'color.page' },
  { name: '正文 / 表面', foreground: 'color.text', background: 'color.surface' },
  { name: '主按钮文字 / 主色', foreground: 'color.on-primary', background: 'color.primary' },
  { name: '次要文字 / 表面', foreground: 'color.muted', background: 'color.surface' },
];

/**
 * 对 Token 文档里最常见的四组前景/背景做 WCAG AA 对比度检查。
 * 只对能解析的颜色给结论；别名会先解析到最终字面量。
 */
export function checkTokenContrast(content: unknown): TokenContrastReport {
  const leaves = flattenTokenLeaves(
    content && typeof content === 'object' ? (content as { tokens?: unknown }).tokens : null,
  );
  const colors = new Map<string, string>();
  for (const leaf of leaves) {
    if (leaf.type !== 'color' || typeof leaf.value !== 'string') continue;
    colors.set(leaf.path, leaf.value);
  }

  const resolve = (path: string, depth = 0): string | null => {
    if (depth > 8) return null;
    const value = colors.get(path);
    if (!value) return null;
    const alias = /^\{([^}]+)\}$/.exec(value.trim());
    if (alias) return resolve(alias[1], depth + 1);
    return value;
  };

  const checks: TokenContrastCheck[] = [];
  for (const pair of PAIRS) {
    const foregroundValue = resolve(pair.foreground);
    const backgroundValue = resolve(pair.background);
    if (!foregroundValue || !backgroundValue) continue;
    checks.push({
      name: pair.name,
      foreground: pair.foreground,
      background: pair.background,
      foregroundValue,
      backgroundValue,
      verdict: evaluateContrast(foregroundValue, backgroundValue),
    });
  }

  const status =
    checks.length === 0
      ? 'undeterminable'
      : checks.some((check) => check.verdict.status === 'fail')
        ? 'fail'
        : checks.some((check) => check.verdict.status === 'undeterminable')
          ? 'undeterminable'
          : 'pass';
  return { status, checks };
}
