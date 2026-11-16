/**
 * 从设计文档里抽出能画成色块的颜色。
 *
 * 资产库以前只认 `$type: "color"` 且 `$value` 本身就是 # / rgb / hsl 的叶子。
 * 创建向导写出的组件、动效把颜色放在 CSS 声明里，而且经常是 `{color.primary}`
 * 这种指向主题的别名，于是色板永远是空的。这里先解析文档自己的颜色 token
 * （含文档内别名），没有的话再按声明里真正引用到的字面量和别名收集。
 */
import { collectWithFixtureDependencies } from './design-css';
import { extractTokenAliases, isTokenAlias, isValidColorValue } from './design-schema';
import type { JsonRecord } from './design.types';

const COLOR_LITERAL_SOURCE =
  '#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\\b|rgba?\\([^)]*\\)|hsla?\\([^)]*\\)';

const DEFAULT_LIMIT = 12;

export interface DesignPalette {
  colors: string[];
  /** 这些颜色对应的 token 路径，供侧栏展示；纯字面量没有路径。 */
  tokens: string[];
}

export function extractDesignPalette(
  content: unknown,
  options: { scanReferences?: boolean; limit?: number } = {},
): DesignPalette {
  if (!isRecord(content)) return { colors: [], tokens: [] };
  const limit = options.limit ?? DEFAULT_LIMIT;
  const colors: string[] = [];
  const tokens: string[] = [];
  const seen = new Set<string>();
  const table = collectWithFixtureDependencies(content);

  const push = (value: unknown, tokenPath?: string): void => {
    if (typeof value !== 'string') return;
    const display = displayColor(value);
    if (!display) return;
    if (tokenPath && !tokens.includes(tokenPath) && tokens.length < 24) tokens.push(tokenPath);
    if (seen.has(display.key)) return;
    if (colors.length >= limit) return;
    seen.add(display.key);
    colors.push(display.text);
  };

  const pushResolved = (value: unknown, tokenPath?: string): void => {
    if (typeof value !== 'string') return;
    if (isTokenAlias(value)) {
      const target = value.slice(1, -1);
      const token = table.get(target);
      if (token?.type === 'color') push(token.value, tokenPath ?? target);
      return;
    }
    push(value, tokenPath);
  };

  const ownColorPaths = isRecord(content.tokens) ? collectColorPaths(content.tokens, '') : [];

  if (ownColorPaths.length > 0) {
    for (const path of ownColorPaths) {
      const token = table.get(path);
      if (token?.type === 'color') pushResolved(token.value, path);
    }
    return { colors, tokens };
  }

  if (options.scanReferences === false) return { colors, tokens };

  const visit = (value: unknown): void => {
    if (colors.length >= limit) return;
    if (typeof value === 'string') {
      for (const literal of value.match(new RegExp(COLOR_LITERAL_SOURCE, 'gi')) ?? []) push(literal);
      for (const path of extractTokenAliases(value)) {
        const token = table.get(path);
        if (!token) continue;
        if (token.type === 'color') pushResolved(token.value, path);
        else if (
          (token.type === 'shadow' || token.type === 'border') &&
          isRecord(token.value)
        ) {
          pushResolved(token.value.color, path);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === '__aurumFixtureDependencies' || key === 'dependencies') continue;
      visit(child);
    }
  };
  visit(content);
  return { colors, tokens };
}

/**
 * 把已加载的依赖版本挂到 `__aurumFixtureDependencies` 上，供 token 表解析别名。
 * 缺版本时跳过，避免资产库因为一条断依赖整页失败。
 */
export function attachPinnedDependencies(
  content: JsonRecord,
  versions: Map<string, JsonRecord>,
  seen = new Set<string>(),
): JsonRecord {
  const ids = pinnedVersionIds(content).filter((id) => !seen.has(id));
  if (!ids.length) return content;
  const fixtures: JsonRecord[] = [];
  for (const versionId of ids) {
    const dependency = versions.get(versionId);
    if (!dependency) continue;
    const nextSeen = new Set(seen);
    nextSeen.add(versionId);
    const nested = attachPinnedDependencies(dependency, versions, nextSeen);
    const nestedFixtures = Array.isArray(nested.__aurumFixtureDependencies)
      ? nested.__aurumFixtureDependencies.filter(isRecord)
      : [];
    const own = { ...nested };
    delete own.__aurumFixtureDependencies;
    fixtures.push({ content: own });
    fixtures.push(...nestedFixtures);
  }
  if (!fixtures.length) return content;
  return { ...content, __aurumFixtureDependencies: fixtures };
}

export function pinnedContents(content: JsonRecord): JsonRecord[] {
  const injected = content.__aurumFixtureDependencies;
  if (!Array.isArray(injected)) return [];
  return injected.flatMap((item) =>
    isRecord(item) && isRecord(item.content) ? [item.content] : [],
  );
}

export function pinnedVersionIds(content: JsonRecord): string[] {
  const raw = content.dependencies;
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (typeof item.versionId === 'string' && item.versionId) ids.push(item.versionId);
  }
  return ids;
}

/** 组件 / 动效的静态预览文档。声明来自受控导出，不执行脚本。 */
export function buildStaticPreviewHtml(css: string, fragment: string): string {
  const safeCss = css.replace(/<\/(style)/gi, '<\\/$1');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;min-height:100%}
body{min-height:100%;display:flex;align-items:center;justify-content:center;padding:32px;background:#f8fafc;font-family:ui-sans-serif,system-ui,sans-serif}
${safeCss}
</style></head><body>${fragment}</body></html>`;
}

function collectColorPaths(group: JsonRecord, prefix: string): string[] {
  const paths: string[] = [];
  for (const [name, value] of Object.entries(group)) {
    if (!isRecord(value)) continue;
    const path = prefix ? `${prefix}.${name}` : name;
    if (typeof value.$type === 'string' && '$value' in value) {
      if (value.$type === 'color') paths.push(path);
      continue;
    }
    paths.push(...collectColorPaths(value, path));
  }
  return paths;
}

function displayColor(value: string): { key: string; text: string } | null {
  const trimmed = value.trim();
  if (!isValidColorValue(trimmed)) return null;
  if (/^(?:transparent|currentcolor)$/i.test(trimmed)) return null;
  if (trimmed.startsWith('#')) {
    let body = trimmed.slice(1).toLowerCase();
    if (body.length === 3 || body.length === 4) {
      body = [...body].map((part) => part + part).join('');
    }
    const text = `#${body}`;
    return { key: text, text };
  }
  return { key: trimmed.replace(/\s+/g, '').toLowerCase(), text: trimmed };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
