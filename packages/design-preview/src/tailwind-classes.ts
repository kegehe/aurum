export interface ClassSourceFile {
  path: string;
  content: string;
}

const CALL_PATTERN = /\b(?:cn|clsx|classNames|twMerge|cva)\s*\(([\s\S]{0,5000}?)\)/g;
const STRING_PATTERN = /['"`]([^'"`]+)['"`]/g;
const DIRECT_CLASS = /className\s*=\s*(?:"([^"]+)"|'([^']+)')/g;
const TEMPLATE_CLASS = /className\s*=\s*\{\s*`([^`]*)`\s*\}/g;

/**
 * 从源码里做静态 Tailwind 类名提取。
 *
 * 重点覆盖 cn()/clsx()/cva()/twMerge() 里的字符串和直接 className；
 * 动态拼接、运行期计算无法静态提取，用 manifest.tailwindClasses 兜底。
 * 两者取并集：显式列表不能挡住新文件里的静态类，否则改完样式预览还是旧的。
 */
export function collectTailwindClasses(
  files: ClassSourceFile[],
  explicit: string[] = [],
): string[] {
  const found = new Set(unique(explicit));
  for (const file of files) {
    if (!/\.(tsx|ts|jsx|js|mjs|mts|cjs|cts)$/.test(file.path)) continue;
    for (const match of file.content.matchAll(DIRECT_CLASS)) {
      addTokens(found, match[1] ?? match[2] ?? '');
    }
    for (const match of file.content.matchAll(TEMPLATE_CLASS)) {
      addTokens(found, match[1].replace(/\$\{[^}]*\}/g, ' '));
    }
    for (const match of file.content.matchAll(CALL_PATTERN)) {
      const body = match[1];
      for (const stringMatch of body.matchAll(STRING_PATTERN)) {
        addTokens(found, stringMatch[1]);
      }
    }
  }
  return [...found];
}

function addTokens(target: Set<string>, value: string): void {
  for (const token of value.split(/\s+/)) {
    if (!token) continue;
    if (token.includes('${') || token.includes('{') || token.includes('}')) continue;
    if (/^https?:\/\//.test(token)) continue;
    target.add(token);
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
