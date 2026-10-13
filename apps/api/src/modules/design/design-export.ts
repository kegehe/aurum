/**
 * 设计资产的派生导出。
 *
 * 原则（方案 §5.1）：CSS / Tailwind / HTML / Markdown 都是从规范数据派生出来的
 * 产物，**不是事实来源**。所以这里只做「结构化数据 → 文本」的单向生成，
 * 绝不接受或存储手写的 CSS。
 */
import {
  PSEUDO_STATES,
  collectWithFixtureDependencies,
  declarationsToCss,
  resolveDeclarations,
  resolveScalarText,
  toVarName,
  type TokenTable,
} from './design-css';
import type { DesignKind, JsonRecord } from './design.types';

/** 导出格式的单一事实来源：控制器、服务与前端都引用它，避免白名单各写一份 */
export const EXPORT_FORMATS = ['json', 'css', 'tailwind', 'markdown', 'bundle'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface TokenLeaf {
  path: string;
  type: string;
  value: unknown;
}

/** 展开 token 树为叶子列表（保留 $type —— 序列化必须知道类型） */
export function flattenTokenLeaves(value: unknown, prefix = ''): TokenLeaf[] {
  if (!isRecord(value)) return [];
  if (typeof value.$type === 'string' && '$value' in value) {
    return [{ path: prefix, type: value.$type, value: value.$value }];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    flattenTokenLeaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

/**
 * 把 token 列表渲染成 `:root` 变量表。
 *
 * 这里是「导出器静默丢弃 6/13 种 token 类型」的修复点：原实现只保留
 * string/number 标量，于是 cubicBezier（数组）与 shadow（对象）直接消失，
 * 连报错都没有。现在按类型逐类序列化，无法序列化的类型显式列进 skipped。
 */
export function buildTokenCss(
  contents: Array<JsonRecord | undefined>,
  options: { selector?: string } = {},
): { css: string; skipped: string[]; collisions: string[] } {
  const byVarName = new Map<string, TokenLeaf>();
  const collisions: string[] = [];

  for (const content of contents) {
    if (!content) continue;
    for (const leaf of flattenTokenLeaves(content.tokens)) {
      const varName = toVarName(leaf.path);
      const existing = byVarName.get(varName);
      // 不同 token 路径可能归一化成同一个变量名（`space.md` 与 `space-md`），
      // 那样后写的会静默覆盖先写的，而别名引用恰好指向这个被覆盖的名字。
      if (existing && existing.path !== leaf.path) {
        collisions.push(`${existing.path} 与 ${leaf.path} 都映射到 ${varName}`);
        continue;
      }
      byVarName.set(varName, leaf);
    }
  }

  const skipped: string[] = [];
  const lines: string[] = [];
  for (const [varName, leaf] of byVarName) {
    const css = tokenValueToCssValue(leaf);
    if (css === null) {
      skipped.push(`${leaf.path} (${leaf.type})`);
      continue;
    }
    lines.push(`  ${varName}: ${css};`);
  }

  if (!lines.length) return { css: '', skipped, collisions };
  const selector = options.selector ?? ':root';
  return { css: `${selector} {\n${lines.join('\n')}\n}\n`, skipped, collisions };
}

function tokenValueToCssValue(leaf: TokenLeaf): string | null {
  if (typeof leaf.value === 'string') {
    // 别名指向另一个 token 时导出成变量引用，而不是就地展开成字面量
    if (/^\{[a-zA-Z0-9_.-]+\}$/.test(leaf.value)) {
      return `var(${toVarName(leaf.value.slice(1, -1))})`;
    }
    return leaf.value;
  }
  if (typeof leaf.value === 'number') return String(leaf.value);
  if (leaf.type === 'cubicBezier' && Array.isArray(leaf.value) && leaf.value.length === 4) {
    return `cubic-bezier(${leaf.value.join(', ')})`;
  }
  if (leaf.type === 'shadow' && isRecord(leaf.value)) {
    const shadow = leaf.value;
    const geometry = ['offsetX', 'offsetY', 'blur', 'spread']
      .map((key) =>
        typeof shadow[key] === 'string' || typeof shadow[key] === 'number'
          ? String(shadow[key])
          : '',
      )
      .filter(Boolean)
      .join(' ');
    const color = typeof shadow.color === 'string' ? shadow.color : '';
    const inset = shadow.inset === true ? 'inset ' : '';
    const value = `${inset}${[geometry, color].filter(Boolean).join(' ')}`.trim();
    return value || null;
  }
  if (leaf.type === 'border' && isRecord(leaf.value)) {
    return (
      [leaf.value.width, leaf.value.style, leaf.value.color]
        .filter((part) => typeof part === 'string' || typeof part === 'number')
        .join(' ') || null
    );
  }
  if (leaf.type === 'transition' && isRecord(leaf.value)) {
    const duration =
      typeof leaf.value.duration === 'number' ? `${leaf.value.duration}ms` : leaf.value.duration;
    return (
      [leaf.value.property, duration, leaf.value.timingFunction, leaf.value.delay]
        .filter((part) => typeof part === 'string' || typeof part === 'number')
        .join(' ') || null
    );
  }
  if (leaf.type === 'strokeStyle' && typeof leaf.value === 'object') {
    return null;
  }
  // typography 等复合类型无法塌缩成单个 CSS 值，由 skipped 显式列出
  return null;
}

export interface ComponentExport {
  css: string;
  html: string;
  tokensUsed: string[];
}

/**
 * 组件：把声明编译成 scoped CSS + 一份可直接粘贴的 HTML 骨架。
 *
 * 别名替换成 `var(--name)`（aliasMode: 'var'），这样导出物可以随消费方加载的
 * 主题变量换肤；配套的 token 定义由 bundle 一起给出。
 */
export function buildComponentExport(content: JsonRecord, tokens: TokenTable): ComponentExport {
  const componentType = String(content.componentType);
  const appliesTo = typeof content.appliesTo === 'string' ? content.appliesTo : 'element';
  const variants = isRecord(content.variants) ? content.variants : {};
  const tokensUsed = new Set<string>();
  const rules: string[] = [];

  for (const [variantName, variant] of Object.entries(variants)) {
    if (!isRecord(variant)) continue;
    const selector = `.aurum-${componentType}-${variantName}`;
    const context = `${componentType}.${variantName}`;
    const base = resolveDeclarations(
      asRecord(variant.declarations),
      tokens,
      `${context}.declarations`,
      {
        aliasMode: 'var',
      },
    );
    collectAliasNames(variant.declarations, tokensUsed);
    if (Object.keys(base.css).length) rules.push(declarationsToCss(selector, base.css));

    if (isRecord(variant.states)) {
      for (const [stateName, state] of Object.entries(variant.states)) {
        if (!(PSEUDO_STATES as readonly string[]).includes(stateName)) continue;
        const resolved = resolveDeclarations(
          asRecord(state),
          tokens,
          `${context}.states.${stateName}`,
          {
            aliasMode: 'var',
          },
        );
        collectAliasNames(state, tokensUsed);
        if (Object.keys(resolved.css).length) {
          // 导出物是给真实项目用的，所以用真正的伪类而不是预览用的 is-xxx 类
          rules.push(declarationsToCss(`${selector}:${stateName}`, resolved.css));
        }
      }
    }

    if (isRecord(variant.pseudo)) {
      for (const [element, declarations] of Object.entries(variant.pseudo)) {
        if (element !== 'before' && element !== 'after') continue;
        const resolved = resolveDeclarations(
          asRecord(declarations),
          tokens,
          `${context}.${element}`,
          {
            allowContent: true,
            aliasMode: 'var',
          },
        );
        collectAliasNames(declarations, tokensUsed);
        if (Object.keys(resolved.css).length) {
          rules.push(declarationsToCss(`${selector}::${element}`, resolved.css));
        }
      }
    }
  }

  const firstVariant = Object.keys(variants)[0];
  const className = firstVariant
    ? `aurum-${componentType}-${firstVariant}`
    : `aurum-${componentType}`;
  return {
    css: `${rules.join('\n\n')}\n`,
    html: buildElementSkeleton(appliesTo, className),
    tokensUsed: [...tokensUsed].sort(),
  };
}

export interface AnimationExport {
  css: string;
  html: string;
  reducedMotion: string;
  tokensUsed: string[];
}

/**
 * 动画：`@keyframes` + 工具类 + `prefers-reduced-motion` 降级。
 *
 * 降级块不是可选项：没有它，资产导出到任何真实项目都是无障碍负债。
 */
export function buildAnimationExport(content: JsonRecord, tokens: TokenTable): AnimationExport {
  const animationType = String(content.animationType);
  const name = `aurum-${animationType}`;
  const tokensUsed = new Set<string>();
  const frames = Array.isArray(content.keyframes) ? content.keyframes : [];

  const keyframes = frames
    .map((frame) => {
      if (!isRecord(frame) || typeof frame.at !== 'string') return '';
      const resolved = resolveDeclarations(
        asRecord(frame.declarations),
        tokens,
        `keyframes.${frame.at}`,
        {
          aliasMode: 'var',
        },
      );
      collectAliasNames(frame.declarations, tokensUsed);
      const body = Object.entries(resolved.css)
        .map(([property, value]) => `    ${property}: ${value};`)
        .join('\n');
      return `  ${frame.at} {\n${body}\n  }`;
    })
    .filter(Boolean)
    .join('\n');

  const timing = isRecord(content.timing) ? content.timing : {};
  const duration = resolveScalarText(timing.duration, tokens) ?? '300ms';
  const easing = resolveScalarText(timing.easing, tokens) ?? 'ease';
  const delay = timing.delay === undefined ? null : resolveScalarText(timing.delay, tokens);
  const iteration =
    timing.iterationCount === 'infinite' ? 'infinite' : String(timing.iterationCount ?? 1);
  collectAliasNames(timing, tokensUsed);

  const utility = `.${name} {
  animation-name: ${name};
  animation-duration: ${duration};
  animation-timing-function: ${easing};
  animation-iteration-count: ${iteration};
  animation-fill-mode: both;${delay ? `\n  animation-delay: ${delay};` : ''}
}`;

  // 预览与导出一律按 both 生成，否则首尾两帧会退回未动画的基础样式
  const reducedMotion = `@media (prefers-reduced-motion: reduce) {
  .${name} {
    animation: none;
${reducedMotionDeclarations(content, tokens)}
  }
}`;

  return {
    css: `@keyframes ${name} {\n${keyframes}\n}\n\n${utility}\n`,
    html: `<div class="${name}">Animated content</div>\n`,
    reducedMotion,
    tokensUsed: [...tokensUsed].sort(),
  };
}

function reducedMotionDeclarations(content: JsonRecord, tokens: TokenTable): string {
  const declarations = isRecord(content.reducedMotion)
    ? asRecord(content.reducedMotion.declarations)
    : undefined;
  const resolved = resolveDeclarations(declarations, tokens, 'reducedMotion.declarations', {
    aliasMode: 'var',
  });
  return Object.entries(resolved.css)
    .map(([property, value]) => `    ${property}: ${value};`)
    .join('\n');
}

export interface BundleExport {
  css: string;
  html: string;
  json: JsonRecord;
  tokensUsed: string[];
  reducedMotion?: string;
  /**
   * 可直接粘贴的完整样式。
   *
   * 由服务端拼好而不是让前端自己拼：动画若只粘贴 keyframes 而漏掉
   * `prefers-reduced-motion` 降级块，在开了"减少动态效果"的用户那里就是
   * 无障碍负债。把"该粘贴什么"收在服务端，这个约束才可测。
   */
  copyCss: string;
  /** 无法序列化的 token 类型，显式上报而不是静默丢弃 */
  skippedTokens: string[];
}

/**
 * 一键复制用的完整包：CSS + HTML + 规范原文 + 用到的 token 清单。
 *
 * bundle 同时带上依赖的 token 定义，所以粘贴到别的项目即可直接生效。
 */
export function buildBundle(
  kind: DesignKind,
  content: JsonRecord,
  tokens: TokenTable,
): BundleExport {
  const bundle = composeBundle(kind, content, tokens);
  // 派生点只有这一处：任何 kind 的"可粘贴样式"都必然带上 reducedMotion 降级块
  const copyCss = [bundle.css, bundle.reducedMotion].filter(Boolean).join('\n\n');
  return { ...bundle, copyCss };
}

function composeBundle(
  kind: DesignKind,
  content: JsonRecord,
  tokens: TokenTable,
): Omit<BundleExport, 'copyCss'> {
  const common = { json: content };
  if (kind === 'component') {
    const exported = buildComponentExport(content, tokens);
    const tokenCss = buildTokenCss([content, ...fixtureDependencyContents(content)]);
    return {
      ...common,
      css: `${tokenCss.css}${tokenCss.css ? '\n' : ''}${exported.css}`,
      html: exported.html,
      tokensUsed: exported.tokensUsed,
      skippedTokens: tokenCss.skipped,
    };
  }
  if (kind === 'animation') {
    const exported = buildAnimationExport(content, tokens);
    const tokenCss = buildTokenCss([content, ...fixtureDependencyContents(content)]);
    return {
      ...common,
      css: `${tokenCss.css}${tokenCss.css ? '\n' : ''}${exported.css}`,
      html: exported.html,
      reducedMotion: exported.reducedMotion,
      tokensUsed: exported.tokensUsed,
      skippedTokens: tokenCss.skipped,
    };
  }
  // 基础规范 / 主题 / 样式包 / 布局：导出钉住依赖的全部 token
  const tokenCss = buildTokenCss([content, ...fixtureDependencyContents(content)]);
  return {
    ...common,
    css: tokenCss.css,
    html: '',
    tokensUsed: [],
    skippedTokens: tokenCss.skipped,
  };
}

/** 渲染期注入的依赖内容（style_pack 与钉住依赖的资产的 token 来源） */
function fixtureDependencyContents(content: JsonRecord): JsonRecord[] {
  const injected = content.__aurumFixtureDependencies;
  if (!Array.isArray(injected)) return [];
  return injected.flatMap((dependency) =>
    isRecord(dependency) && isRecord(dependency.content) ? [dependency.content] : [],
  );
}

/** 收集一段声明里引用到的 token 路径（用于告诉运营"这个资产依赖哪些 token"） */
function collectAliasNames(declarations: unknown, into: Set<string>): void {
  if (!isRecord(declarations)) return;
  for (const value of Object.values(declarations)) {
    if (typeof value !== 'string') continue;
    for (const match of value.matchAll(/\{([a-zA-Z0-9_.-]+)\}/g)) into.add(match[1]);
  }
}

function buildElementSkeleton(appliesTo: string, className: string): string {
  if (appliesTo === 'container') {
    return `<div class="${className}">\n  Card content\n</div>\n`;
  }
  if (appliesTo === 'text') return `<p class="${className}">Sample paragraph text</p>\n`;
  return `<button type="button" class="${className}">Action</button>\n`;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 供 service 复用：从已解析的内容里收集 token 表 */
export { collectWithFixtureDependencies };
