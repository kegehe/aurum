/**
 * 从已生成的声明反推可视控件。
 *
 * 存在的理由：纯对话的成品质量由**纠正能力**决定，不由生成能力决定。外行说不出
 * "把模糊从 24px 降到 12px"，所以模型第一版什么样，最后基本就是什么样，收敛在
 * "还行"。这里把声明按值类别翻译成色板/档位/滑块/下拉，让"精调"不花 AI 调用、
 * 也不需要词汇——**对话改方向，滑块磨细节**。
 *
 * 边界是刻意的，而且是这个模块唯一的安全论证：
 * 1. 控件只改**已存在声明**的值，不加属性、不改结构；
 * 2. 取值必须命中该控件自己的选项列表（`unknown` 会被拒绝）。
 *
 * 所以滑块在结构上不可能把 schema 改坏，产物仍由 `validateDesignContent` 与
 * 发布门禁把关。这也是它比"自由 CSS 编辑框"安全的地方。
 */
import {
  describePropertyKind,
  keywordOptionsFor,
  type ResolvedToken,
  type TokenTable,
} from './design-css';
import { isTokenAlias } from './design-schema';
import type { JsonRecord } from './design.types';

export type ControlType = 'color' | 'scale' | 'choose' | 'range';

export type DeclarationTarget =
  | { kind: 'variant'; variant: string }
  | { kind: 'state'; variant: string; state: string }
  | { kind: 'pseudo'; variant: string; element: string }
  | { kind: 'keyframe'; at: string };

export interface DesignControlOption {
  label: string;
  value: string;
  /** 颜色选项的实际色值。前端要画色块，光有 token 路径没法画。 */
  swatch?: string;
}

export interface DesignControl {
  /** 稳定标识：目标块 + 属性。客户端只回传它和取值，不构造声明。 */
  key: string;
  label: string;
  type: ControlType;
  property: string;
  target: DeclarationTarget;
  /** 当前值（token 别名或字面量），用于把控件初始化到现状 */
  value: string;
  options?: DesignControlOption[];
  min?: number;
  max?: number;
  step?: number;
  /** 数值控件的当前数值，用于把滑轨定位到现状 */
  numeric?: number;
}

export interface ApplyControlResult {
  content: JsonRecord;
  applied: string[];
  skipped: Array<{ key: string; reason: string }>;
}

// ==================== 取值到控件的映射表 ====================

const PROPERTY_LABELS: Record<string, string> = {
  color: '文字色',
  'background-color': '底色',
  'background-image': '背景渐变',
  'background-clip': '背景裁切',
  'border-color': '边框色',
  'border-radius': '圆角',
  border: '边框',
  'border-width': '边框粗细',
  'border-style': '边框样式',
  outline: '外框',
  'outline-color': '外框色',
  'outline-width': '外框粗细',
  'outline-offset': '外框偏移',
  padding: '内边距',
  margin: '外边距',
  gap: '间距',
  top: '上偏移',
  left: '左偏移',
  'z-index': '层级',
  position: '定位',
  'font-size': '字号',
  'font-weight': '字重',
  'line-height': '行高',
  'letter-spacing': '字距',
  'text-align': '对齐',
  'text-shadow': '文字阴影',
  opacity: '不透明度',
  'box-shadow': '阴影',
  filter: '滤镜',
  'backdrop-filter': '背景模糊',
  transform: '变换',
  'transition-duration': '过渡时长',
  'transition-delay': '过渡延迟',
  'transition-timing-function': '缓动曲线',
  'transition-property': '过渡属性',
  display: '显示方式',
  'justify-content': '主轴对齐',
  'align-items': '交叉轴对齐',
  'mix-blend-mode': '混合模式',
};

const STATE_LABELS: Record<string, string> = {
  hover: '悬停',
  'focus-visible': '聚焦',
  focus: '聚焦',
  active: '按下',
  disabled: '禁用',
};

/** 直接取数值的属性的滑块范围 */
const NUMBER_RANGES: Record<string, { min: number; max: number; step: number }> = {
  opacity: { min: 0, max: 1, step: 0.05 },
  'font-weight': { min: 100, max: 900, step: 100 },
  'flex-grow': { min: 0, max: 4, step: 1 },
  'flex-shrink': { min: 0, max: 4, step: 1 },
  'z-index': { min: 0, max: 20, step: 1 },
  'line-clamp': { min: 1, max: 6, step: 1 },
  'column-count': { min: 1, max: 4, step: 1 },
};

/** 滤镜函数的滑块范围（取第一个带数值参数的函数） */
const FILTER_RANGES: Record<string, { min: number; max: number; step: number; unit: string }> = {
  blur: { min: 0, max: 32, step: 1, unit: 'px' },
  saturate: { min: 0, max: 300, step: 5, unit: '%' },
  brightness: { min: 0, max: 200, step: 5, unit: '%' },
  contrast: { min: 0, max: 200, step: 5, unit: '%' },
  grayscale: { min: 0, max: 100, step: 5, unit: '%' },
  'hue-rotate': { min: 0, max: 360, step: 5, unit: 'deg' },
};

const TRANSFORM_RANGES: Record<string, { min: number; max: number; step: number; unit: string }> = {
  translatey: { min: -16, max: 16, step: 1, unit: 'px' },
  translatex: { min: -16, max: 16, step: 1, unit: 'px' },
  scale: { min: 0.9, max: 1.2, step: 0.01, unit: '' },
  rotate: { min: -15, max: 15, step: 1, unit: 'deg' },
  rotatez: { min: -15, max: 15, step: 1, unit: 'deg' },
  skewx: { min: -10, max: 10, step: 1, unit: 'deg' },
  skewy: { min: -10, max: 10, step: 1, unit: 'deg' },
};

/** 控件面板的展示顺序：先颜色，再档位，再数值，最后枚举 */
const TYPE_ORDER: Record<ControlType, number> = { color: 0, scale: 1, range: 2, choose: 3 };

// ==================== 反推 ====================

/** 带内部字段的形态：`before`/`after` 是数值套回原值的模板，不外发 */
interface DerivedControl extends DesignControl {
  before: string;
  after: string;
}

export function describeControls(content: JsonRecord, tokens: TokenTable): DesignControl[] {
  return deriveControls(content, tokens).map(({ before, after, ...control }) => {
    void before;
    void after;
    return control;
  });
}

function deriveControls(content: JsonRecord, tokens: TokenTable): DerivedControl[] {
  const controls: DerivedControl[] = [];
  const seen = new Set<string>();

  for (const site of walkDeclarationSites(content)) {
    for (const [property, rawValue] of Object.entries(site.declarations)) {
      // 只处理字符串值：shadow 这类对象形状的值本轮不给控件（范围太大，
      // 而 token 化的阴影已经能通过"档位"控件切换）。
      if (typeof rawValue !== 'string') continue;
      const key = `${targetKey(site.target)}/${property}`;
      if (seen.has(key)) continue;
      const control = buildControl(key, property, rawValue, site.target, tokens);
      if (!control) continue;
      seen.add(key);
      controls.push(control);
    }
  }

  // 稳定排序：`Array.prototype.sort` 是稳定的，所以同类型内保留内容里的出现顺序
  return controls.sort((left, right) => TYPE_ORDER[left.type] - TYPE_ORDER[right.type]);
}

function buildControl(
  key: string,
  property: string,
  value: string,
  target: DeclarationTarget,
  tokens: TokenTable,
): DerivedControl | null {
  const kind = describePropertyKind(property);
  const label = controlLabel(property, target);
  const base = { key, property, target, value, label, before: '', after: '' };

  if (kind === 'color') {
    const options = paletteOptions(value, tokens);
    // 只有一个候选（就是当前值）时给控件没有意义
    return options.length > 1 ? { ...base, type: 'color', options } : null;
  }

  // token 别名 → 同组同类型 token 的档位。这是最有用的一个：
  // 主题里有 radius.sm/md/lg，控件就是"圆角：小/中/大"。
  if (isTokenAlias(value)) {
    const options = siblingTokenOptions(value, tokens);
    if (options.length > 1) return { ...base, type: 'scale', options };
  }

  if (kind === 'keyword') {
    const keywords = keywordOptionsFor(property);
    if (keywords && keywords.length > 1)
      return {
        ...base,
        type: 'choose',
        options: keywords.map((keyword) => ({ label: keyword, value: keyword })),
      };
  }

  const ranged = numericRange(property, value, kind);
  if (ranged) return { ...base, type: 'range', ...ranged };

  return null;
}

function numericRange(
  property: string,
  value: string,
  kind: string | undefined,
): {
  min: number;
  max: number;
  step: number;
  numeric: number;
  before: string;
  after: string;
} | null {
  const direct = NUMBER_RANGES[property];
  if (direct && kind === 'number') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    // 当前值可能超出预设范围（例如 opacity 1.5），把范围撑开到能表达它，
    // 否则控件初始化就落在滑轨外。
    return {
      min: Math.min(direct.min, parsed),
      max: Math.max(direct.max, parsed),
      step: direct.step,
      numeric: parsed,
      before: '',
      after: '',
    };
  }

  const table =
    kind === 'filter-list' ? FILTER_RANGES : kind === 'transform-list' ? TRANSFORM_RANGES : null;
  if (!table) return null;
  // 取第一个带数值参数的函数：`blur(12px) saturate(140%)` → 调 blur。
  const match = /([a-z-]+)\(\s*(-?[\d.]+)([a-z%]*)\s*\)/i.exec(value);
  if (!match) return null;
  const range = table[match[1].toLowerCase()];
  const parsed = Number(match[2]);
  if (!range || !Number.isFinite(parsed)) return null;
  const start = value.indexOf(match[0]);
  return {
    min: Math.min(range.min, parsed),
    max: Math.max(range.max, parsed),
    step: range.step,
    numeric: parsed,
    // 按切片拼而不是用占位符替换：值里本来就可能含 `{`（token 别名）
    before: `${value.slice(0, start)}${match[1]}(`,
    after: `${range.unit})${value.slice(start + match[0].length)}`,
  };
}

/**
 * 同组同类型的兄弟 token。
 *
 * 按数值排序，所以 `radius.sm/md/lg` 自然排成小→大；颜色没有数值，保持
 * 主题里的书写顺序。
 */
function siblingTokenOptions(alias: string, tokens: TokenTable): DesignControlOption[] {
  const path = alias.slice(1, -1);
  const current = tokens.get(path);
  if (!current) return [];
  const group = parentPath(path);
  const siblings = [...tokens.values()].filter(
    (token) => parentPath(token.path) === group && token.type === current.type,
  );
  if (siblings.length < 2) return [];
  return siblings
    .sort((left, right) => numericOrder(left) - numericOrder(right))
    .map((token) => ({
      label: `${token.path.slice(group ? group.length + 1 : 0)} · ${shortValue(token)}`,
      value: `{${token.path}}`,
      // 颜色档位也要能画出来：前端的色块拿不到 token 表
      swatch: token.type === 'color' && typeof token.value === 'string' ? token.value : undefined,
    }));
}

function paletteOptions(value: string, tokens: TokenTable): DesignControlOption[] {
  if (isTokenAlias(value)) {
    const siblings = siblingTokenOptions(value, tokens);
    if (siblings.length > 1) return siblings;
  }
  const options = [...tokens.values()]
    .filter((token) => token.type === 'color')
    .map((token) => ({
      label: token.path,
      value: `{${token.path}}`,
      swatch: typeof token.value === 'string' ? token.value : undefined,
    }));
  // 当前值不在色板里（模型直接给了 hex）时必须放进去，否则用户看不到自己现在是什么色
  if (!options.some((option) => option.value === value))
    options.unshift({ label: '当前', value, swatch: value });
  return options;
}

function parentPath(path: string): string {
  const cut = path.lastIndexOf('.');
  return cut < 0 ? '' : path.slice(0, cut);
}

function numericOrder(token: ResolvedToken): number {
  if (typeof token.value === 'number') return token.value;
  if (typeof token.value === 'string') {
    const match = /^-?[\d.]+/.exec(token.value.trim());
    if (match) return Number(match[0]);
  }
  return Number.MAX_SAFE_INTEGER;
}

function shortValue(token: ResolvedToken): string {
  if (typeof token.value === 'string' || typeof token.value === 'number')
    return String(token.value);
  return token.type;
}

function controlLabel(property: string, target: DeclarationTarget): string {
  const base = PROPERTY_LABELS[property] ?? property;
  if (target.kind === 'state') return `${STATE_LABELS[target.state] ?? target.state} · ${base}`;
  if (target.kind === 'pseudo')
    return `${target.element === 'before' ? '前置元素' : '后置元素'} · ${base}`;
  return base;
}

// ==================== 编辑 ====================

/**
 * 把控件编辑套回内容。
 *
 * 两道闸：目标块和声明必须**已经存在**，取值必须在该控件给出的选项里。
 * 于是这个函数只能产出"值不同的同一份结构"，不可能被用来注入新属性。
 */
export function applyControlEdits(
  content: JsonRecord,
  tokens: TokenTable,
  edits: Record<string, string | number>,
): ApplyControlResult {
  const controls = deriveControls(content, tokens);
  const next = structuredClone(content);
  const applied: string[] = [];
  const skipped: ApplyControlResult['skipped'] = [];

  for (const [key, raw] of Object.entries(edits)) {
    const control = controls.find((item) => item.key === key);
    if (!control) {
      skipped.push({ key, reason: '该控件不存在或已失效' });
      continue;
    }
    const block = resolveBlock(next, control.target);
    if (!block) {
      skipped.push({ key, reason: '目标块不存在' });
      continue;
    }
    if (!(control.property in block)) {
      skipped.push({ key, reason: `${control.property} 在当前内容里不存在` });
      continue;
    }

    let value: string;
    if (typeof raw === 'number') {
      if (control.type !== 'range') {
        skipped.push({ key, reason: '该控件不接受数值' });
        continue;
      }
      const stepped = Math.round(raw / control.step!) * control.step!;
      value = `${control.before}${Number(stepped.toFixed(4))}${control.after}`;
    } else {
      if (!control.options?.some((option) => option.value === raw)) {
        skipped.push({ key, reason: '取值不在该控件的可选范围内' });
        continue;
      }
      value = raw;
    }

    block[control.property] = value;
    applied.push(key);
  }

  return { content: next, applied, skipped };
}

function resolveBlock(content: JsonRecord, target: DeclarationTarget): JsonRecord | null {
  if (target.kind === 'keyframe') {
    if (!Array.isArray(content.keyframes)) return null;
    const frame = content.keyframes.find((item) => isRecord(item) && item.at === target.at);
    return isRecord(frame) && isRecord(frame.declarations) ? frame.declarations : null;
  }

  if (!isRecord(content.variants)) return null;
  const variant = content.variants[target.variant];
  if (!isRecord(variant)) return null;

  if (target.kind === 'variant')
    return isRecord(variant.declarations) ? variant.declarations : null;

  if (target.kind === 'state') {
    if (!isRecord(variant.states)) return null;
    const state = variant.states[target.state];
    return isRecord(state) ? state : null;
  }

  if (!isRecord(variant.pseudo)) return null;
  const element = variant.pseudo[target.element];
  return isRecord(element) ? element : null;
}

// ==================== 遍历 ====================

interface DeclarationSite {
  target: DeclarationTarget;
  declarations: JsonRecord;
}

/** 走遍内容里所有能承载声明的位置。 */
function* walkDeclarationSites(content: JsonRecord): Generator<DeclarationSite> {
  if (Array.isArray(content.keyframes)) {
    for (const frame of content.keyframes) {
      if (isRecord(frame) && typeof frame.at === 'string' && isRecord(frame.declarations))
        yield { target: { kind: 'keyframe', at: frame.at }, declarations: frame.declarations };
    }
  }
  if (!isRecord(content.variants)) return;
  for (const [variant, definition] of Object.entries(content.variants)) {
    if (!isRecord(definition)) continue;
    if (isRecord(definition.declarations))
      yield { target: { kind: 'variant', variant }, declarations: definition.declarations };
    if (isRecord(definition.states)) {
      for (const [state, block] of Object.entries(definition.states)) {
        if (isRecord(block))
          yield { target: { kind: 'state', variant, state }, declarations: block };
      }
    }
    if (isRecord(definition.pseudo)) {
      for (const [element, block] of Object.entries(definition.pseudo)) {
        if (isRecord(block))
          yield { target: { kind: 'pseudo', variant, element }, declarations: block };
      }
    }
  }
}

function targetKey(target: DeclarationTarget): string {
  if (target.kind === 'variant') return `variant:${target.variant}`;
  if (target.kind === 'state') return `state:${target.variant}.${target.state}`;
  if (target.kind === 'pseudo') return `pseudo:${target.variant}.${target.element}`;
  return `keyframe:${target.at}`;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
