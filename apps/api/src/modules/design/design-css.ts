/**
 * CSS 声明契约：属性白名单 + 值类别校验 + token 别名解析 + CSS 序列化
 *
 * 为什么需要白名单（而不是只靠 design-schema 的字符黑名单）：
 * 1. **导出正确性**：导出器必须知道每个属性的值类别才能正确序列化。
 * 2. **防污染消费方项目**：没有白名单，文档可以声明任意自定义属性
 *    （`--primary: red`），导出到别的项目后会静默覆盖宿主变量——字符黑名单拦不住。
 * 3. **对比度门禁需要可判定性**：要判断哪个声明是前景、哪个是背景，必须识别属性语义。
 * 4. 安全是附带收益（顺带排除 -moz-binding / behavior 这类历史注入面）。
 *
 * 注意「渲染时断网」保护的是预览，而导出的 CSS 会进入用户自己的项目——
 * 那才是真正需要白名单的地方。
 */
import { BadRequestException } from '@nestjs/common';
import type { DesignKind, JsonRecord } from './design.types';
import {
  extractTokenAliases,
  isTokenAlias,
  isValidColorValue,
  isValidDimensionValue,
  isValidFontFamilyValue,
  isValidNumberValue,
} from './design-schema';

// ==================== 值类别 ====================

type ValueKind =
  | 'color'
  | 'length'
  | 'length-list'
  | 'line-height'
  | 'number'
  | 'font-family'
  | 'keyword'
  | 'position'
  | 'z-index'
  | 'shadow-list'
  | 'border-shorthand'
  | 'filter-list'
  | 'transform-list'
  | 'gradient'
  | 'transition-property'
  | 'time'
  | 'timing-function'
  | 'content-string';

const COLOR_PROPERTIES = [
  'color',
  'background-color',
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'text-decoration-color',
  'caret-color',
  'column-rule-color',
  'fill',
  'stroke',
];

const LENGTH_PROPERTIES = [
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'font-size',
  'letter-spacing',
  'word-spacing',
  'text-indent',
  'flex-basis',
  'outline-offset',
  'border-width',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'outline-width',
];

const LENGTH_LIST_PROPERTIES = [
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'padding-block',
  'padding-inline',
  'padding-block-start',
  'padding-block-end',
  'padding-inline-start',
  'padding-inline-end',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'margin-block',
  'margin-inline',
  'gap',
  'row-gap',
  'column-gap',
  'border-radius',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'inset',
  'top',
  'right',
  'bottom',
  'left',
  'transform-origin',
  'background-size',
  'background-position',
];

const BORDER_STYLES = [
  'none',
  'hidden',
  'dotted',
  'dashed',
  'solid',
  'double',
  'groove',
  'ridge',
  'inset',
  'outset',
];

/**
 * 三段式边框简写。
 *
 * 这些简写的取值就是「宽度 / 样式 / 颜色」的任意顺序组合，无歧义、可安全序列化，
 * 所以支持它们；而 `background` / `font` / `transition` / `animation` 这类
 * 多层或可嵌套关键帧的简写仍然排除（见 EXCLUDED_PROPERTIES）。
 */
const BORDER_SHORTHAND_PROPERTIES = [
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'outline',
  'column-rule',
];

const KEYWORD_PROPERTIES: Record<string, string[]> = {
  display: [
    'block',
    'inline',
    'inline-block',
    'flex',
    'inline-flex',
    'grid',
    'inline-grid',
    'none',
    'contents',
    'flow-root',
  ],
  'flex-direction': ['row', 'row-reverse', 'column', 'column-reverse'],
  'flex-wrap': ['nowrap', 'wrap', 'wrap-reverse'],
  'justify-content': [
    'flex-start',
    'flex-end',
    'center',
    'space-between',
    'space-around',
    'space-evenly',
    'start',
    'end',
    'left',
    'right',
    'stretch',
  ],
  'align-items': ['flex-start', 'flex-end', 'center', 'baseline', 'stretch', 'start', 'end'],
  'align-self': ['auto', 'flex-start', 'flex-end', 'center', 'baseline', 'stretch', 'start', 'end'],
  'align-content': [
    'flex-start',
    'flex-end',
    'center',
    'space-between',
    'space-around',
    'space-evenly',
    'stretch',
  ],
  'text-align': ['left', 'right', 'center', 'justify', 'start', 'end'],
  'text-transform': ['none', 'capitalize', 'uppercase', 'lowercase', 'full-width'],
  'text-decoration-line': ['none', 'underline', 'overline', 'line-through'],
  'text-overflow': ['clip', 'ellipsis'],
  'white-space': ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces'],
  'word-break': ['normal', 'break-all', 'keep-all', 'break-word'],
  'overflow-wrap': ['normal', 'break-word', 'anywhere'],
  'font-style': ['normal', 'italic', 'oblique'],
  'border-style': [
    'none',
    'hidden',
    'dotted',
    'dashed',
    'solid',
    'double',
    'groove',
    'ridge',
    'inset',
    'outset',
  ],
  'outline-style': [
    'none',
    'dotted',
    'dashed',
    'solid',
    'double',
    'groove',
    'ridge',
    'inset',
    'outset',
  ],
  'object-fit': ['fill', 'contain', 'cover', 'none', 'scale-down'],
  'box-sizing': ['content-box', 'border-box'],
  'background-repeat': ['repeat', 'no-repeat', 'repeat-x', 'repeat-y', 'space', 'round'],
  'background-clip': ['border-box', 'padding-box', 'content-box', 'text'],
  'background-origin': ['border-box', 'padding-box', 'content-box'],
  'background-attachment': ['scroll', 'fixed', 'local'],
  'mix-blend-mode': [
    'normal',
    'multiply',
    'screen',
    'overlay',
    'darken',
    'lighten',
    'color-dodge',
    'color-burn',
    'hard-light',
    'soft-light',
    'difference',
    'exclusion',
    'hue',
    'saturation',
    'color',
    'luminosity',
  ],
  isolation: ['auto', 'isolate'],
  visibility: ['visible', 'hidden', 'collapse'],
  'list-style-type': [
    'none',
    'disc',
    'circle',
    'square',
    'decimal',
    'lower-alpha',
    'upper-alpha',
    'lower-roman',
    'upper-roman',
  ],
  cursor: [
    'auto',
    'default',
    'pointer',
    'text',
    'move',
    'grab',
    'grabbing',
    'not-allowed',
    'help',
    'wait',
    'progress',
    'crosshair',
    'zoom-in',
    'zoom-out',
    'col-resize',
    'row-resize',
    'ns-resize',
    'ew-resize',
    'none',
  ],
  'overflow-x': ['visible', 'hidden', 'clip', 'scroll', 'auto'],
  'overflow-y': ['visible', 'hidden', 'clip', 'scroll', 'auto'],
  overflow: ['visible', 'hidden', 'clip', 'scroll', 'auto'],
  'font-variant-numeric': [
    'normal',
    'tabular-nums',
    'proportional-nums',
    'lining-nums',
    'oldstyle-nums',
  ],
  'text-rendering': ['auto', 'optimizeSpeed', 'optimizeLegibility', 'geometricPrecision'],
  'pointer-events': ['auto', 'none'],
};

const FILTER_FUNCTIONS = new Set([
  'blur',
  'brightness',
  'contrast',
  'drop-shadow',
  'grayscale',
  'hue-rotate',
  'invert',
  'opacity',
  'saturate',
  'sepia',
]);

const TRANSFORM_FUNCTIONS = new Set([
  'translate',
  'translatex',
  'translatey',
  'translatez',
  'translate3d',
  'scale',
  'scalex',
  'scaley',
  'scale3d',
  'rotate',
  'rotatex',
  'rotatey',
  'rotatez',
  'rotate3d',
  'skew',
  'skewx',
  'skewy',
  'perspective',
]);

const GRADIENT_FUNCTIONS = [
  'linear-gradient',
  'radial-gradient',
  'conic-gradient',
  'repeating-linear-gradient',
];

const TIMING_KEYWORDS = [
  'linear',
  'ease',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'step-start',
  'step-end',
];

/** 允许出现在组件/Hover 态里的伪类（注意用连字符形式，与 CSS 一致） */
export const PSEUDO_STATES = ['hover', 'focus-visible', 'focus', 'active', 'disabled'] as const;
export type PseudoState = (typeof PSEUDO_STATES)[number];

/** 允许的伪元素，且其内部只接受 content + 一部分视觉属性 */
export const PSEUDO_ELEMENTS = ['before', 'after'] as const;

/** 状态渲染时使用的类名（渲染器不依赖 :hover 交互，改用显式类保证确定性） */
export function stateClassName(state: PseudoState): string {
  return `is-${state}`;
}

// ==================== 属性白名单 ====================

const PROPERTY_KINDS: Record<string, ValueKind> = {
  ...buildKindMap(COLOR_PROPERTIES, 'color'),
  ...buildKindMap(LENGTH_PROPERTIES, 'length'),
  ...buildKindMap(LENGTH_LIST_PROPERTIES, 'length-list'),
  ...buildKindMap(Object.keys(KEYWORD_PROPERTIES), 'keyword'),
  ...buildKindMap(BORDER_SHORTHAND_PROPERTIES, 'border-shorthand'),
  'font-family': 'font-family',
  'font-weight': 'number',
  // 行高既接受无单位倍数（`1.25`）也接受长度（`20px`），单独一类。
  // 曾经归进 length-list，于是 `line-height: 1.5` —— 最常见的写法 —— 被拒。
  'line-height': 'line-height',
  opacity: 'number',
  'flex-grow': 'number',
  'flex-shrink': 'number',
  order: 'number',
  'aspect-ratio': 'number',
  'tab-size': 'number',
  'line-clamp': 'number',
  'column-count': 'number',
  position: 'position',
  'z-index': 'z-index',
  'box-shadow': 'shadow-list',
  'text-shadow': 'shadow-list',
  filter: 'filter-list',
  'backdrop-filter': 'filter-list',
  transform: 'transform-list',
  'background-image': 'gradient',
  'transition-property': 'transition-property',
  'transition-duration': 'time',
  'transition-delay': 'time',
  'transition-timing-function': 'timing-function',
};

function buildKindMap(properties: string[], kind: ValueKind): Record<string, ValueKind> {
  return Object.fromEntries(properties.map((property) => [property, kind]));
}

/**
 * 明确不支持的属性及理由（写成常量是为了让报错能给出原因，而不是干巴巴一句"不支持"）
 */
const EXCLUDED_PROPERTIES: Record<string, string> = {
  animation: '关键帧动画请单独发布为 animation 资产',
  'animation-name': '关键帧动画请单独发布为 animation 资产',
  transition: '请使用 transition-* longhand 形式',
  background: '多层简写无法安全序列化，请使用 background-color / background-image',
  font: '简写无法安全序列化，请使用 font-family / font-size / font-weight',
  content: '仅允许出现在 ::before / ::after 上',
  'border-image': '需要图片资源，值里不允许出现 url()',
  mask: '需要图片资源，值里不允许出现 url()',
  flex: '简写不可安全拆分，请使用 flex-grow / flex-shrink / flex-basis',
  grid: '简写不可安全拆分，请使用 grid-template-* / grid-auto-*',
  behavior: '历史 XBL 注入面',
  '-moz-binding': '历史 XBL 注入面',
  float: '会改变宿主布局流',
  clear: '会改变宿主布局流',
};

export function isSupportedDeclarationProperty(property: string): boolean {
  return property in PROPERTY_KINDS;
}

/**
 * 属性的值类别。供控件反推判断"这个声明该给滑块还是色板"。
 *
 * 刻意返回 `string` 而不是把 `ValueKind` 联合类型导出去：这张表是内部实现，
 * 外部只需要能分类，不应该把它的取值集合当成公共 API 依赖。
 */
export function describePropertyKind(property: string): string | undefined {
  return PROPERTY_KINDS[property];
}

/** 枚举型属性的可选值。供控件反推生成下拉；非枚举属性返回 undefined。 */
export function keywordOptionsFor(property: string): readonly string[] | undefined {
  return KEYWORD_PROPERTIES[property];
}

export function describeUnsupportedProperty(property: string): string | null {
  if (property.startsWith('--')) {
    return '不允许声明自定义属性：会静默覆盖消费方项目的变量';
  }
  return EXCLUDED_PROPERTIES[property] ?? null;
}

// ==================== token 表与别名解析 ====================

export interface ResolvedToken {
  path: string;
  type: string;
  /** 已跟随别名链解析出的具体值 */
  value: unknown;
}

export type TokenTable = Map<string, ResolvedToken>;

/**
 * 收集 token 表（文档自身 + 已解析的依赖内容），并跟随别名链求具体值。
 *
 * 依赖 design-schema 的 flatten 语义：叶子是同时含 $type 与 $value 的对象，
 * 路径用点号连接（`color.primary`）。
 */
export function collectTokenTable(contents: Array<JsonRecord | undefined>): TokenTable {
  const raw = new Map<string, { type: string; value: unknown }>();
  for (const content of contents) {
    if (content && isRecord(content.tokens)) collectDefinitions(content.tokens, '', raw);
  }

  const table: TokenTable = new Map();
  for (const [path, definition] of raw) {
    table.set(path, {
      path,
      type: definition.type,
      value: resolveAliasChain(path, definition, raw),
    });
  }
  return table;
}

/**
 * 从渲染期已解析的内容里收集 token 表：文档自身 + 注入的依赖内容。
 *
 * `__aurumFixtureDependencies` 是 resolveFixtureContent 注入的渲染期字段，
 * 把这个键的知识收在这里一处，避免 service 与渲染器各写一份。
 */
export function collectWithFixtureDependencies(content: JsonRecord): TokenTable {
  const contents: Array<JsonRecord | undefined> = [content];
  const injected = content.__aurumFixtureDependencies;
  if (Array.isArray(injected)) {
    for (const dependency of injected) {
      if (isRecord(dependency) && isRecord(dependency.content)) contents.push(dependency.content);
    }
  }
  return collectTokenTable(contents);
}

function collectDefinitions(
  group: JsonRecord,
  prefix: string,
  into: Map<string, { type: string; value: unknown }>,
): void {
  for (const [name, value] of Object.entries(group)) {
    if (!isRecord(value)) continue;
    const path = prefix ? `${prefix}.${name}` : name;
    if (typeof value.$type === 'string' && '$value' in value) {
      into.set(path, { type: value.$type, value: value.$value });
      continue;
    }
    collectDefinitions(value, path, into);
  }
}

function resolveAliasChain(
  path: string,
  definition: { type: string; value: unknown },
  raw: Map<string, { type: string; value: unknown }>,
  seen = new Set<string>(),
): unknown {
  if (typeof definition.value !== 'string' || !isTokenAlias(definition.value)) {
    return definition.value;
  }
  if (seen.has(path)) return definition.value;
  seen.add(path);
  const targetPath = definition.value.slice(1, -1);
  const target = raw.get(targetPath);
  if (!target) return definition.value;
  return resolveAliasChain(targetPath, target, raw, seen);
}

// ==================== CSS 序列化 ====================

/**
 * token 值 → CSS 文本。
 *
 * 这是修掉「导出器静默丢弃 6/13 种 token 类型」的地方：原来只保留
 * string/number 标量，cubicBezier（数组）与 shadow（对象）直接消失。
 */
export function tokenValueToCss(type: string, value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (type === 'cubicBezier' && Array.isArray(value) && value.length === 4) {
    return `cubic-bezier(${value.join(', ')})`;
  }
  if (type === 'shadow' && isRecord(value)) return shadowToCss(value);
  if (type === 'border' && isRecord(value)) {
    return [value.width, value.style, value.color].filter(isScalar).join(' ') || null;
  }
  if (type === 'transition' && isRecord(value)) {
    const parts = [
      value.property,
      typeof value.duration === 'number' ? `${value.duration}ms` : value.duration,
      value.timingFunction,
      value.delay,
    ];
    return parts.filter(isScalar).join(' ') || null;
  }
  if (type === 'strokeStyle' && typeof value === 'string') return value;
  // typography 这类复合类型无法塌缩成单个 CSS 值，由声明层用 longhand 表达
  return null;
}

function shadowToCss(shadow: JsonRecord): string {
  const inset = shadow.inset === true ? 'inset ' : '';
  const geometry = ['offsetX', 'offsetY', 'blur', 'spread']
    .map((key) => (isScalar(shadow[key]) ? String(shadow[key]) : ''))
    .filter(Boolean)
    .join(' ');
  const color = isScalar(shadow.color) ? String(shadow.color) : '';
  return `${inset}${[geometry, color].filter(Boolean).join(' ')}`.trim();
}

function isScalar(value: unknown): value is string | number {
  return typeof value === 'string' || typeof value === 'number';
}

/**
 * token 路径 → CSS 变量名。
 *
 * 必须**只有这一处**做这个转换：别名 `{space.md}` 与 token 路径 `space.md` 都要
 * 落到同一个变量名，否则导出的引用会指向不存在的变量。
 */
export function toVarName(tokenPath: string): string {
  return `--${tokenPath.replaceAll('.', '-')}`;
}

/** 由已解析的声明生成 CSS 规则文本；scoped 类名前缀由调用方给出 */
export function declarationsToCss(selector: string, declarations: Record<string, string>): string {
  const body = Object.entries(declarations)
    .map(([property, value]) => `  ${property}: ${value};`)
    .join('\n');
  return `${selector} {\n${body}\n}`;
}

// ==================== 声明解析与校验 ====================

export interface ResolvedDeclarations {
  /** 属性 → 已解析别名后的 CSS 值 */
  css: Record<string, string>;
  errors: string[];
  /** 引用了但 token 表里不存在的别名路径 */
  unresolvedAliases: string[];
}

export interface ResolveOptions {
  /**
   * 允许 `content` 属性（仅伪元素）。
   *
   * `content` 在普通声明里是排除项（只在 ::before/::after 上生效），
   * 所以伪元素那一路必须显式开口，否则伪元素内的视觉属性会被整体跳过校验。
   */
  allowContent?: boolean;
  /**
   * 别名替换方式。
   *
   * - `value`（默认，渲染用）：替换成具体值，夹具可独立渲染
   * - `var`（导出用）：替换成 `var(--x)`，导出物可随消费方的主题 token 换肤
   */
  aliasMode?: 'value' | 'var';
}

/**
 * 解析一组声明：校验属性白名单、解析别名、校验值类别语法。
 *
 * 不抛异常，把问题收集进 errors —— 一次渲染要把*全部*问题报给运营，
 * 而不是修一个错再跑一次。
 */
export function resolveDeclarations(
  declarations: JsonRecord | undefined,
  tokens: TokenTable,
  context: string,
  options: ResolveOptions = {},
): ResolvedDeclarations {
  const result: ResolvedDeclarations = { css: {}, errors: [], unresolvedAliases: [] };
  if (declarations === undefined) return result;
  if (!isRecord(declarations)) {
    result.errors.push(`${context} 必须是对象`);
    return result;
  }

  for (const [property, rawValue] of Object.entries(declarations)) {
    const path = `${context}.${property}`;

    if (property === 'content' && options.allowContent) {
      const literal = resolveScalarValue(rawValue, tokens, path, result, 'value');
      if (literal === null) continue;
      const syntaxError = validateValueSyntax('content-string', property, literal);
      if (syntaxError) {
        result.errors.push(`${path}: ${syntaxError}`);
        continue;
      }
      result.css[property] =
        options.aliasMode === 'var'
          ? (resolveScalarValue(rawValue, tokens, path, result, 'var') ?? literal)
          : literal;
      continue;
    }

    if (!isSupportedDeclarationProperty(property)) {
      const reason = describeUnsupportedProperty(property);
      result.errors.push(reason ? `${path}: ${reason}` : `${path}: 不支持的 CSS 属性`);
      continue;
    }

    const kind = PROPERTY_KINDS[property];
    const resolve = (mode: 'value' | 'var') =>
      kind === 'shadow-list'
        ? resolveShadowList(rawValue, tokens, path, result, mode)
        : resolveScalarValue(rawValue, tokens, path, result, mode);

    // 类型兼容性必须用**字面量**校验：var(--x) 形式会让所有值语法校验失效
    // （`padding: var(--space-md)` 不是合法长度），那样导出时引用别名的
    // 声明会被整批丢弃。输出的形态再由 aliasMode 决定。
    const literal = resolve('value');
    if (literal === null) continue;

    const syntaxError = validateValueSyntax(kind, property, literal);
    if (syntaxError) {
      result.errors.push(`${path}: ${syntaxError}`);
      continue;
    }
    result.css[property] = options.aliasMode === 'var' ? (resolve('var') ?? literal) : literal;
  }

  return result;
}

/**
 * 解析单个标量值里的别名。
 *
 * 供渲染器与导出器取 `timing.duration` / `timing.easing` 这类单值使用——
 * 它们不在 declarations 里，但同样可能是 token 别名。
 */
export function resolveScalarText(value: unknown, tokens: TokenTable): string | null {
  return resolveScalarValue(value, tokens, 'value', {
    css: {},
    errors: [],
    unresolvedAliases: [],
  });
}

function resolveScalarValue(
  rawValue: unknown,
  tokens: TokenTable,
  path: string,
  result: ResolvedDeclarations,
  aliasMode: 'value' | 'var' = 'value',
): string | null {
  if (typeof rawValue === 'number') return String(rawValue);
  if (typeof rawValue !== 'string') {
    result.errors.push(`${path}: 值必须是字符串或数字`);
    return null;
  }

  let substituted = rawValue;
  for (const aliasPath of extractTokenAliases(rawValue)) {
    const token = tokens.get(aliasPath);
    if (!token) {
      result.unresolvedAliases.push(aliasPath);
      result.errors.push(`${path}: 引用的 token 不存在: {${aliasPath}}`);
      return null;
    }
    const css =
      aliasMode === 'var'
        ? `var(${toVarName(aliasPath)})`
        : tokenValueToCss(token.type, token.value);
    if (css === null) {
      result.errors.push(`${path}: token {${aliasPath}} 的类型 ${token.type} 无法用于该属性`);
      return null;
    }
    substituted = substituted.replaceAll(`{${aliasPath}}`, css);
  }
  return substituted;
}

function resolveShadowList(
  rawValue: unknown,
  tokens: TokenTable,
  path: string,
  result: ResolvedDeclarations,
  aliasMode: 'value' | 'var' = 'value',
): string | null {
  if (rawValue === 'none') return 'none';

  // 字符串路径：既覆盖 `'{shadow.card}'` 这种整体别名，也覆盖手写的 CSS 阴影简写。
  // 少了这条，引用 shadow token 会被误报成"阴影必须是对象"。
  if (typeof rawValue === 'string') {
    return resolveScalarValue(rawValue, tokens, path, result, aliasMode);
  }

  const layers = Array.isArray(rawValue) ? rawValue : [rawValue];
  const rendered: string[] = [];
  for (const layer of layers) {
    if (!isRecord(layer)) {
      result.errors.push(`${path}: 阴影必须是对象、对象数组或 CSS 字符串`);
      return null;
    }
    const resolved: JsonRecord = {};
    for (const [key, value] of Object.entries(layer)) {
      const resolvedValue = resolveScalarValue(value, tokens, `${path}.${key}`, result, aliasMode);
      if (resolvedValue === null) return null;
      resolved[key] = resolvedValue;
    }
    rendered.push(shadowToCss(resolved));
  }
  return rendered.join(', ');
}

/** 按值类别校验已解析（别名已替换）的 CSS 值 */
function validateValueSyntax(kind: ValueKind, property: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return '值不能为空';
  // 任何类别都不接受这些：渲染产物或导出产物里出现它们说明前面的过滤漏了
  if (/[;{}<>]/.test(trimmed)) return '值包含不允许的字符';
  if (/url\s*\(/i.test(trimmed)) return '值不允许引用外部资源';

  switch (kind) {
    case 'color':
      return isValidColorValue(trimmed) ? null : `不是合法的颜色值: ${trimmed}`;
    case 'length':
    case 'length-list':
      return splitTopLevel(trimmed).every((part) => isValidDimensionValue(part))
        ? null
        : `不是合法的长度值: ${trimmed}`;
    case 'line-height': {
      // 无单位倍数（相对字号）必须为正；`0` 与负数在 CSS 里无效
      const multiple = Number(trimmed);
      if (Number.isFinite(multiple) && multiple > 0) return null;
      return splitTopLevel(trimmed).every((part) => isValidDimensionValue(part))
        ? null
        : `不是合法的行高值: ${trimmed}`;
    }
    case 'number':
      return isValidNumber(trimmed) ? null : `不是合法的数字: ${trimmed}`;
    case 'font-family':
      return isValidFontFamilyValue(trimmed) ? null : `不是合法的字体族: ${trimmed}`;
    case 'keyword': {
      const allowed = KEYWORD_PROPERTIES[property];
      return allowed?.includes(trimmed)
        ? null
        : `${property} 不支持取值 ${trimmed}${allowed ? `（可用: ${allowed.join(' / ')}）` : ''}`;
    }
    case 'position':
      return ['static', 'relative', 'absolute', 'sticky', 'fixed'].includes(trimmed)
        ? null
        : `position 不支持取值 ${trimmed}`;
    case 'z-index':
      return trimmed === 'auto' || /^-?\d+$/.test(trimmed)
        ? null
        : `z-index 只接受整数或 auto: ${trimmed}`;
    case 'border-shorthand': {
      const parts = splitTopLevel(trimmed);
      if (parts.length < 1 || parts.length > 3) {
        return `不是合法的边框简写（应为 宽度 / 样式 / 颜色 的组合）: ${trimmed}`;
      }
      let seenWidth = false;
      let seenStyle = false;
      let seenColor = false;
      for (const part of parts) {
        if (BORDER_STYLES.includes(part)) {
          if (seenStyle) return `边框简写里样式重复: ${trimmed}`;
          seenStyle = true;
          continue;
        }
        if (isValidColorValue(part)) {
          if (seenColor) return `边框简写里颜色重复: ${trimmed}`;
          seenColor = true;
          continue;
        }
        if (isValidDimensionValue(part) || /^(thin|medium|thick)$/.test(part)) {
          if (seenWidth) return `边框简写里宽度重复: ${trimmed}`;
          seenWidth = true;
          continue;
        }
        return `边框简写里存在无法识别的值: ${part}`;
      }
      return null;
    }
    case 'filter-list':
      return validateFunctionList(trimmed, FILTER_FUNCTIONS, 'filter');
    case 'transform-list':
      if (trimmed === 'none') return null;
      return validateFunctionList(trimmed, TRANSFORM_FUNCTIONS, 'transform');
    case 'gradient':
      if (trimmed === 'none') return null;
      return GRADIENT_FUNCTIONS.some((fn) => trimmed.startsWith(`${fn}(`))
        ? null
        : `background-image 只允许渐变函数（${GRADIENT_FUNCTIONS.join(' / ')}）`;
    case 'transition-property':
      return splitByComma(trimmed).every(
        (part) => part === 'all' || part === 'none' || isSupportedDeclarationProperty(part),
      )
        ? null
        : `transition-property 含有未受支持或需过渡的属性: ${trimmed}`;
    case 'time':
      return isValidDuration(trimmed) ? null : `不是合法的时间值: ${trimmed}`;
    case 'timing-function':
      return isValidTimingFunction(trimmed) ? null : `不是合法的缓动函数: ${trimmed}`;
    case 'content-string':
      return /^(["']).*\1$/.test(trimmed) ? null : `content 只允许带引号的字符串: ${trimmed}`;
    case 'shadow-list':
      return null;
    default:
      return `未知的值类别`;
  }
}

/**
 * 按空白切分，但**跳过括号内部**。
 *
 * 朴素 `split(/\s+/)` 会把 `1px solid rgba(255, 255, 255, 0.35)` 切成 5 段，
 * 于是最普通的一条边框声明被报成"不是合法的边框简写"。函数值（`rgba()`、
 * `hsl()`、`cubic-bezier()`）里的空格是值的一部分，不是分隔符。
 */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of value) {
    if (character === '(') depth += 1;
    else if (character === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/.test(character)) {
      if (current) parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current) parts.push(current);
  return parts;
}

function splitByComma(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function isValidNumber(value: string): boolean {
  return isValidNumberValue(Number(value)) && value.trim() !== '';
}

function isValidDuration(value: string): boolean {
  return /^-?\d+(?:\.\d+)?(?:ms|s)$/.test(value);
}

export function isValidTimingFunction(value: string): boolean {
  if (TIMING_KEYWORDS.includes(value)) return true;
  if (
    value.startsWith('cubic-bezier(') ||
    value.startsWith('steps(') ||
    value.startsWith('linear(')
  ) {
    return /^[a-z-]+\([^()]*\)$/.test(value);
  }
  return false;
}

/**
 * 校验 `fn(args) fn(args)` 形式的函数列表。
 *
 * 不引入完整 CSS 解析器：只做「函数名白名单 + 括号配平 + 不含禁用字符」，
 * 这对预览渲染与导出都足够，且不会有解析器与浏览器行为不一致的风险。
 *
 * 注意函数名出现在 `(` **之前**：depth 0 处既要接受函数名字符，也要接受
 * 函数之间的空白/逗号分隔符。
 */
function validateFunctionList(value: string, allowed: Set<string>, label: string): string | null {
  let depth = 0;
  let name = '';
  let functions = 0;

  for (const character of value) {
    if (depth === 0) {
      if (character === '(') {
        const fn = name.trim().toLowerCase();
        if (!fn) return `${label} 里存在没有名字的函数`;
        if (!allowed.has(fn)) return `${label} 不允许函数 ${fn}`;
        functions += 1;
        name = '';
        depth = 1;
        continue;
      }
      if (character === ')') return `${label} 的括号不匹配`;
      if (/[\s,]/.test(character)) continue;
      if (/[a-z0-9-]/i.test(character)) {
        name += character;
        continue;
      }
      return `${label} 里存在不允许的字符: ${character}`;
    }
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
  }

  if (depth !== 0) return `${label} 的括号不匹配`;
  if (name.trim()) return `${label} 里存在没有参数的函数名: ${name.trim()}`;
  if (!functions) return `${label} 至少需要一个函数`;
  return null;
}

// ==================== 对比度配对 ====================

export interface ContrastPair {
  foreground: string;
  background: string;
  largeText: boolean;
  source: string;
}

/**
 * 从一组已解析的声明里提取可判定的前景/背景对。
 *
 * 覆盖范围是**有限且有意识**的：只处理同一声明块内同时给出 color 与
 * background-color 的情形。真实组件里背景常来自父容器、`background` 简写或
 * 状态翻色，这些无法在此判定——所以门禁必须把"无法判定"的数量一起报出去，
 * 否则一个全绿的结论没有信息量。
 */
export function collectContrastPairs(css: Record<string, string>, source: string): ContrastPair[] {
  const foreground = css.color;
  const background = css['background-color'];
  if (!foreground || !background) return [];
  const fontSize = parsePx(css['font-size']);
  const fontWeight = parseWeight(css['font-weight']);
  const largeText =
    fontSize !== null &&
    (fontSize >= 24 || (fontWeight !== null && fontWeight >= 700 && fontSize >= 18.66));
  return [{ foreground, background, largeText, source }];
}

function parsePx(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
  return match ? Number.parseFloat(match[1]) : null;
}

function parseWeight(value: string | undefined): number | null {
  if (!value) return null;
  const numeric = Number.parseFloat(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const named: Record<string, number> = { normal: 400, regular: 400, medium: 500, bold: 700 };
  return named[value.trim().toLowerCase()] ?? null;
}

// ==================== 资产级校验（需要已解析 token） ====================

export interface AssetValidation {
  /** 全部阻断性问题 */
  errors: string[];
  /** 无法判定的对比度检查项（不算通过也不算失败，但必须计数上报） */
  undeterminable: string[];
  /** 实测通过的对比度 */
  contrasts: Array<{ source: string; ratio: number; threshold: number }>;
}

/**
 * 校验资产（组件 / 动画）的声明契约，并执行对比度门禁。
 *
 * 必须是「已解析 token 之后」才能调用——别名是否存在、解析出的类型是否与
 * 属性相容，都依赖依赖树里钉住的主题版本。
 */
export function validateAssetAgainstTokens(
  kind: DesignKind,
  content: JsonRecord,
  tokens: TokenTable,
  evaluate: ContrastEvaluator,
): AssetValidation {
  if (kind === 'animation') return validateAnimationAgainstTokens(content, tokens);
  if (kind === 'component') return validateComponentAgainstTokens(content, tokens, evaluate);
  return { errors: [], undeterminable: [], contrasts: [] };
}

export type ContrastEvaluator = (
  foreground: string,
  background: string,
  options: { largeText: boolean },
) => { status: string; ratio?: number; threshold?: number; reason?: string };

function validateAnimationAgainstTokens(content: JsonRecord, tokens: TokenTable): AssetValidation {
  const validation: AssetValidation = { errors: [], undeterminable: [], contrasts: [] };
  const keyframes = content.keyframes;
  if (!Array.isArray(keyframes) || keyframes.length < 2) {
    validation.errors.push('animation 至少需要两个 keyframe');
    return validation;
  }
  for (const [index, frame] of keyframes.entries()) {
    if (!isRecord(frame)) {
      validation.errors.push(`keyframes[${index}] 必须是对象`);
      continue;
    }
    const resolved = resolveDeclarations(
      isRecord(frame.declarations) ? frame.declarations : undefined,
      tokens,
      `keyframes[${index}].declarations`,
    );
    validation.errors.push(...resolved.errors);
    // 关键帧不参与对比度：它描述的是动画中途状态，不是可读性基线
  }
  if (isRecord(content.reducedMotion)) {
    const resolved = resolveDeclarations(
      isRecord(content.reducedMotion.declarations) ? content.reducedMotion.declarations : undefined,
      tokens,
      'reducedMotion.declarations',
    );
    validation.errors.push(...resolved.errors);
  }
  // timing 的别名要真的能解析成该字段需要的类型，而不是只查"别名存在"。
  // 引用一个 dimension token 当 duration 是真实的作者错误，必须报出来。
  const timing = isRecord(content.timing) ? content.timing : {};
  for (const key of ['duration', 'delay'] as const) {
    const value = timing[key];
    if (typeof value !== 'string') continue;
    const resolved = resolveScalarText(value, tokens);
    if (resolved === null) {
      validation.errors.push(`timing.${key}: 无法解析（${value}）`);
      continue;
    }
    if (!isValidDuration(resolved)) {
      validation.errors.push(`timing.${key}: 不是合法的时间值（解析结果 ${resolved}）`);
    }
  }
  if (typeof timing.easing === 'string') {
    const resolved = resolveScalarText(timing.easing, tokens);
    if (resolved !== null && !isValidTimingFunction(resolved)) {
      validation.errors.push(`timing.easing: 不是合法的缓动函数（解析结果 ${resolved}）`);
    }
  }
  return validation;
}

function validateComponentAgainstTokens(
  content: JsonRecord,
  tokens: TokenTable,
  evaluate: ContrastEvaluator,
): AssetValidation {
  const validation: AssetValidation = { errors: [], undeterminable: [], contrasts: [] };
  const variants = isRecord(content.variants) ? content.variants : {};
  const pairs: ContrastPair[] = [];

  for (const [variantName, variant] of Object.entries(variants)) {
    if (!isRecord(variant)) {
      validation.errors.push(`variants.${variantName} 必须是对象`);
      continue;
    }
    const context = `variants.${variantName}`;
    const base = resolveDeclarations(
      isRecord(variant.declarations) ? variant.declarations : undefined,
      tokens,
      `${context}.declarations`,
    );
    validation.errors.push(...base.errors);
    pairs.push(...collectContrastPairs(base.css, `${context}.declarations`));

    if (variant.states !== undefined) {
      if (!isRecord(variant.states)) {
        validation.errors.push(`${context}.states 必须是对象`);
      } else {
        for (const [stateName, state] of Object.entries(variant.states)) {
          if (!(PSEUDO_STATES as readonly string[]).includes(stateName)) {
            validation.errors.push(
              `${context}.states.${stateName}: 不支持的伪类（可用: ${PSEUDO_STATES.join(' / ')}）`,
            );
            continue;
          }
          const stateResult = resolveDeclarations(
            isRecord(state) ? state : undefined,
            tokens,
            `${context}.states.${stateName}`,
          );
          validation.errors.push(...stateResult.errors);
          pairs.push(...collectContrastPairs(stateResult.css, `${context}.states.${stateName}`));
        }
      }
    }

    if (variant.pseudo !== undefined) {
      validation.errors.push(...validatePseudo(variant.pseudo, tokens, `${context}.pseudo`));
    }
  }

  if (isRecord(content.a11y) && Array.isArray(content.a11y.contrastPairs)) {
    for (const [index, pair] of (content.a11y.contrastPairs as unknown[]).entries()) {
      if (
        !isRecord(pair) ||
        typeof pair.foreground !== 'string' ||
        typeof pair.background !== 'string'
      ) {
        validation.errors.push(`a11y.contrastPairs[${index}] 需要 foreground 与 background 字符串`);
        continue;
      }
      pairs.push({
        foreground: expandAliasText(pair.foreground, tokens),
        background: expandAliasText(pair.background, tokens),
        largeText: pair.largeText === true,
        source: `a11y.contrastPairs[${index}]`,
      });
    }
  }

  for (const pair of pairs) {
    const verdict = evaluate(pair.foreground, pair.background, { largeText: pair.largeText });
    if (verdict.status === 'undeterminable') {
      validation.undeterminable.push(`${pair.source}: ${verdict.reason}`);
      continue;
    }
    if (verdict.status === 'fail') {
      validation.errors.push(
        `${pair.source}: 对比度 ${(verdict.ratio ?? 0).toFixed(2)}:1 低于要求 ${verdict.threshold}:1` +
          `${pair.largeText ? '（大号文本）' : ''}，前景 ${pair.foreground} / 背景 ${pair.background}`,
      );
      continue;
    }
    validation.contrasts.push({
      source: pair.source,
      ratio: verdict.ratio ?? 0,
      threshold: verdict.threshold ?? 0,
    });
  }

  return validation;
}

function expandAliasText(value: string, tokens: TokenTable): string {
  let substituted = value;
  for (const aliasPath of extractTokenAliases(value)) {
    const token = tokens.get(aliasPath);
    if (!token) continue;
    const css = tokenValueToCss(token.type, token.value);
    if (css !== null) substituted = substituted.replaceAll(`{${aliasPath}}`, css);
  }
  return substituted;
}

function validatePseudo(pseudo: unknown, tokens: TokenTable, context: string): string[] {
  if (!isRecord(pseudo)) return [`${context} 必须是对象`];
  const errors: string[] = [];
  for (const [element, declarations] of Object.entries(pseudo)) {
    if (!(PSEUDO_ELEMENTS as readonly string[]).includes(element)) {
      errors.push(
        `${context}.${element}: 只支持伪元素 ${PSEUDO_ELEMENTS.map((e) => `::${e}`).join(' / ')}`,
      );
      continue;
    }
    if (!isRecord(declarations)) {
      errors.push(`${context}.${element} 必须是对象`);
      continue;
    }
    if (!('content' in declarations)) {
      // 没有 content 的伪元素不会渲染，几乎总是笔误
      errors.push(`${context}.${element}: 缺少 content，伪元素不会渲染`);
      continue;
    }
    // content 之外的视觉属性同样要走白名单校验，否则伪元素是绕过契约的后门
    const resolved = resolveDeclarations(declarations, tokens, `${context}.${element}`, {
      allowContent: true,
    });
    errors.push(...resolved.errors);
  }
  return errors;
}

// ==================== 组件/动画文档结构校验（纯函数层） ====================

/** 组件/动画共用的结构校验：只查形状，不查别名（那需要 token 表） */
export function assertVariantShape(content: JsonRecord, label: string): void {
  if (!isRecord(content.variants)) {
    throw new BadRequestException(`${label} 必须包含 variants 对象`);
  }
  const names = Object.keys(content.variants);
  if (names.length === 0) throw new BadRequestException(`${label} 至少需要一个 variant`);
  for (const name of names) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new BadRequestException(`variant 名必须是小写 kebab-case: ${name}`);
    }
  }
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
