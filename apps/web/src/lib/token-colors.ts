export interface ColorTokenEntry {
  path: string;
  value: string;
}

type JsonRecord = Record<string, unknown>;

/** 从 token 文档里按路径收集 color token；用于结构化颜色编辑器。 */
export function collectColorTokens(content: unknown): ColorTokenEntry[] {
  if (!isRecord(content) || !isRecord(content.tokens)) return [];
  const out: ColorTokenEntry[] = [];
  const walk = (value: unknown, prefix: string) => {
    if (!isRecord(value)) return;
    if (value.$type === 'color' && typeof value.$value === 'string') {
      out.push({ path: prefix, value: value.$value });
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      walk(child, prefix ? `${prefix}.${key}` : key);
    }
  };
  walk(content.tokens, '');
  return out;
}

/** 返回修改后的克隆，不修改传入对象。 */
export function setColorTokenValue(
  content: Record<string, unknown>,
  path: string,
  value: string,
): Record<string, unknown> {
  const next = JSON.parse(JSON.stringify(content)) as JsonRecord;
  const tokens = isRecord(next.tokens) ? next.tokens : null;
  if (!tokens) return next;
  const segments = path.split('.');
  let node: JsonRecord = tokens;
  for (const segment of segments.slice(0, -1)) {
    const child = node[segment];
    if (!isRecord(child)) return next;
    node = child;
  }
  const leaf = node[segments[segments.length - 1]];
  if (isRecord(leaf)) leaf.$value = value;
  return next;
}

/** 只有 #rgb / #rrggbb 能安全映射到 <input type="color">。 */
export function colorInputValue(value: string): string | null {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return `#${trimmed
      .slice(1)
      .split('')
      .map((part) => part + part)
      .join('')}`.toLowerCase();
  }
  return null;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
