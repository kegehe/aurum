import { BadRequestException } from '@nestjs/common';
import { validateMediaDescriptor } from './design-media';
import type { DesignKind, JsonRecord } from './design.types';

const TOKEN_TYPES = new Set([
  'color',
  'dimension',
  'number',
  'fontFamily',
  'fontWeight',
  'duration',
  'cubicBezier',
  'strokeStyle',
  'border',
  'transition',
  'shadow',
  'typography',
  'string',
]);

export function validateDesignContent(kind: DesignKind, content: unknown): JsonRecord {
  if (!isRecord(content)) throw new BadRequestException('设计规范内容必须是 JSON 对象');
  assertSafeJson(content);

  if (kind === 'foundation' || kind === 'theme') return validateTokenDocument(content);
  if (kind === 'layout') return validateLayoutDocument(content);
  if (kind === 'style_pack') return validateStylePack(content);
  if (kind === 'animation') return validateAnimationDocument(content);
  if (kind === 'component') return validateComponentDocument(content);
  // 显式失败而不是兜底：这里曾经是 `return validateStylePack(content)`，
  // 于是新增 kind 却忘了加分支时会被当成样式包校验，报错信息完全误导，
  // 而且 TypeScript 的穷尽检查也不会提示（kind 是窄化后的联合类型）。
  const exhaustive: never = kind;
  throw new BadRequestException(`未知的设计资产类型: ${String(exhaustive)}`);
}

/**
 * 取出内容里钉住的依赖版本。
 *
 * 名字从 getStylePackDependencies 改过来：style_pack / 组件 v2 / 动画 共用同一种
 * 依赖结构，不再是样式包专属。
 */
export function getPinnedDependencies(
  content: JsonRecord,
): Array<{ documentId: string; versionId: string }> {
  const raw = content.dependencies;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const dependency = item as JsonRecord;
    return {
      documentId: dependency.documentId as string,
      versionId: dependency.versionId as string,
    };
  });
}

function validateTokenDocument(content: JsonRecord): JsonRecord {
  if (content.tokenSchemaVersion !== 'aurum.tokens.v1') {
    throw new BadRequestException('Token 文档必须使用 tokenSchemaVersion: aurum.tokens.v1');
  }
  if (!isRecord(content.tokens)) throw new BadRequestException('Token 文档必须包含 tokens 对象');
  validateTokenGroup(content.tokens, 'tokens');
  validateTokenAliases(content.tokens);
  return content;
}

function validateTokenAliases(tokens: JsonRecord): void {
  const definitions = new Map<string, { type: string; value: unknown }>();
  collectTokenDefinitions(tokens, '', definitions);
  const resolving = new Set<string>();
  const resolved = new Set<string>();

  const resolve = (path: string): void => {
    if (resolved.has(path)) return;
    const token = definitions.get(path);
    if (!token) throw new BadRequestException(`Token alias target does not exist: ${path}`);
    if (resolving.has(path)) throw new BadRequestException(`Token alias cycle detected at: ${path}`);
    resolving.add(path);
    if (typeof token.value === 'string' && isTokenAlias(token.value)) {
      const targetPath = token.value.slice(1, -1);
      const target = definitions.get(targetPath);
      if (!target) {
        throw new BadRequestException(`Token alias target does not exist: ${targetPath}`);
      }
      if (target.type !== token.type) {
        throw new BadRequestException(
          `Token alias type must match: ${path} (${token.type}) -> ${targetPath} (${target.type})`,
        );
      }
      resolve(targetPath);
    }
    resolving.delete(path);
    resolved.add(path);
  };

  for (const path of definitions.keys()) resolve(path);
}

function collectTokenDefinitions(
  group: JsonRecord,
  prefix: string,
  definitions: Map<string, { type: string; value: unknown }>,
): void {
  for (const [name, value] of Object.entries(group)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (!isRecord(value)) continue;
    if ('$type' in value || '$value' in value) {
      definitions.set(path, { type: value.$type as string, value: value.$value });
      continue;
    }
    collectTokenDefinitions(value, path, definitions);
  }
}

function validateTokenGroup(group: JsonRecord, path: string): void {
  for (const [name, value] of Object.entries(group)) {
    if (!/^[a-z][a-z0-9-]*$/i.test(name))
      throw new BadRequestException(`无效 Token 名称: ${path}.${name}`);
    if (!isRecord(value)) throw new BadRequestException(`Token ${path}.${name} 必须是对象`);
    const isToken = '$type' in value || '$value' in value;
    if (!isToken) {
      validateTokenGroup(value, `${path}.${name}`);
      continue;
    }
    if (typeof value.$type !== 'string' || !TOKEN_TYPES.has(value.$type)) {
      throw new BadRequestException(`Token ${path}.${name} 的 $type 不受支持`);
    }
    if (!('$value' in value)) throw new BadRequestException(`Token ${path}.${name} 缺少 $value`);
    validateTokenValue(value.$type, value.$value, `${path}.${name}`);
    for (const key of Object.keys(value)) {
      if (!['$type', '$value', '$description'].includes(key)) {
        throw new BadRequestException(`Token ${path}.${name} 包含不支持字段: ${key}`);
      }
    }
  }
}

/** 组件文档的已知 schema 版本。v2 引入声明契约；v1 保持历史语义不变。 */
const COMPONENT_SCHEMA_VERSIONS = ['aurum.component.v1', 'aurum.component.v2'];

const ANIMATION_TRIGGERS = [
  'on-load',
  'on-enter',
  'on-hover',
  'on-focus',
  'on-scroll-enter',
  'continuous',
];

function validateComponentDocument(content: JsonRecord): JsonRecord {
  const schemaVersion = content.schemaVersion;
  if (typeof schemaVersion !== 'string' || !COMPONENT_SCHEMA_VERSIONS.includes(schemaVersion)) {
    throw new BadRequestException(
      '组件文档必须使用 schemaVersion: aurum.component.v1 或 aurum.component.v2',
    );
  }
  if (
    typeof content.componentType !== 'string' ||
    !/^[a-z][a-z0-9-]*$/.test(content.componentType)
  ) {
    throw new BadRequestException('componentType 必须是小写 kebab-case');
  }
  if (!isRecord(content.variants)) throw new BadRequestException('组件文档必须包含 variants 对象');
  const variantNames = Object.keys(content.variants);
  if (variantNames.length === 0) throw new BadRequestException('组件文档至少需要一个 variant');
  for (const name of variantNames) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new BadRequestException(`variant 名必须是小写 kebab-case: ${name}`);
    }
  }
  if (content.appliesTo !== undefined) {
    if (!['element', 'container', 'text'].includes(content.appliesTo as string)) {
      throw new BadRequestException('appliesTo 必须是 element / container / text 之一');
    }
  }

  // v2 的声明引用了 token，必须钉住依赖版本才能在渲染与导出时解析出来
  if (schemaVersion === 'aurum.component.v2') {
    validatePinnedDependencies(content, '组件文档 v2');
    validateVariantDeclarations(content.variants as JsonRecord);
    if (content.media !== undefined) {
      // 媒体组件用 figure + figcaption 的容器骨架；按钮/文字骨架没有放图的位置。
      if (content.appliesTo !== 'container') {
        throw new BadRequestException('带素材的组件必须使用 appliesTo: container');
      }
      validateMediaDescriptor(content.media);
    }
    return content;
  }

  if (content.media !== undefined) {
    throw new BadRequestException('媒体素材只支持 aurum.component.v2');
  }

  // v1 保持历史语义：variants 内容不做结构约束，渲染/导出退化为 JSON 文本示意
  return content;
}

/**
 * 动画文档。
 *
 * 与组件不同，动画不参与对比度门禁（关键帧描述的是动画中途状态，不是可读性
 * 基线），但必须声明 reducedMotion —— 没有它，资产导出到任何真实项目都是
 * 无障碍负债。
 */
function validateAnimationDocument(content: JsonRecord): JsonRecord {
  if (content.schemaVersion !== 'aurum.animation.v1') {
    throw new BadRequestException('动画文档必须使用 schemaVersion: aurum.animation.v1');
  }
  if (
    typeof content.animationType !== 'string' ||
    !/^[a-z][a-z0-9-]*$/.test(content.animationType)
  ) {
    throw new BadRequestException('animationType 必须是小写 kebab-case');
  }
  if (typeof content.trigger !== 'string' || !ANIMATION_TRIGGERS.includes(content.trigger)) {
    throw new BadRequestException(`trigger 必须是以下之一: ${ANIMATION_TRIGGERS.join(' / ')}`);
  }
  validatePinnedDependencies(content, '动画文档');

  if (!Array.isArray(content.keyframes) || content.keyframes.length < 2) {
    throw new BadRequestException('动画文档至少需要两个 keyframe');
  }
  const offsets = new Set<string>();
  for (const [index, frame] of content.keyframes.entries()) {
    if (!isRecord(frame)) throw new BadRequestException(`keyframes[${index}] 必须是对象`);
    const at = frame.at;
    if (typeof at !== 'string' || !isValidKeyframeOffset(at)) {
      throw new BadRequestException(
        `keyframes[${index}].at 必须是 from / to / 0%~100% 的百分比`,
      );
    }
    if (offsets.has(at)) throw new BadRequestException(`keyframes 出现重复的 at: ${at}`);
    offsets.add(at);
    if (!isRecord(frame.declarations) || Object.keys(frame.declarations).length === 0) {
      throw new BadRequestException(`keyframes[${index}] 必须包含非空的 declarations`);
    }
    assertSafeJson(frame.declarations);
  }
  const hasStart = offsets.has('from') || offsets.has('0%');
  const hasEnd = offsets.has('to') || offsets.has('100%');
  if (!hasStart || !hasEnd) {
    throw new BadRequestException('动画必须同时定义起点（from 或 0%）与终点（to 或 100%）');
  }

  if (!isRecord(content.timing)) throw new BadRequestException('动画文档必须包含 timing');
  const timing = content.timing;
  const duration = timing.duration;
  if (duration === undefined) throw new BadRequestException('timing.duration 是必填的');
  if (typeof duration === 'string' && !isTokenAlias(duration) && !isValidDurationValue(duration)) {
    throw new BadRequestException('timing.duration 必须是时长字面量（如 200ms）或 token 别名');
  }
  if (typeof duration !== 'string' && typeof duration !== 'number') {
    throw new BadRequestException('timing.duration 必须是字符串或数字');
  }
  if (timing.delay !== undefined) {
    const delay = timing.delay;
    if (typeof delay !== 'string' && typeof delay !== 'number') {
      throw new BadRequestException('timing.delay 必须是字符串或数字');
    }
    if (typeof delay === 'string' && !isTokenAlias(delay) && !isValidDurationValue(delay)) {
      throw new BadRequestException('timing.delay 必须是时长字面量或 token 别名');
    }
  }
  if (timing.iterationCount !== undefined) {
    const count = timing.iterationCount;
    if (count !== 'infinite' && (typeof count !== 'number' || !Number.isFinite(count) || count <= 0)) {
      throw new BadRequestException('timing.iterationCount 必须是正数或 infinite');
    }
  }
  // 预览与导出一律按 `both` 生成，否则首尾两帧会退回未动画的基础样式。
  // 文档不能声明一个导出后不会生效的 fillMode，那是静默的不一致。
  if (timing.fillMode !== undefined && timing.fillMode !== 'both') {
    throw new BadRequestException('timing.fillMode 只支持 both（预览与导出一律按 both 生成）');
  }

  if (!isRecord(content.reducedMotion) || !isRecord(content.reducedMotion.declarations)) {
    throw new BadRequestException(
      '动画必须声明 reducedMotion.declarations（prefers-reduced-motion 下的静止形态）',
    );
  }
  assertSafeJson(content.reducedMotion.declarations);

  return content;
}

function isValidKeyframeOffset(value: string): boolean {
  if (value === 'from' || value === 'to') return true;
  const match = /^(\d+(?:\.\d+)?)%$/.exec(value);
  if (!match) return false;
  const percent = Number.parseFloat(match[1]);
  return percent >= 0 && percent <= 100;
}

/**
 * v2 组件的变体声明结构校验（纯形状，不解析别名）。
 *
 * 别名是否存在、解析出的类型是否与属性相容，都需要已解析的 token 表，
 * 那是 design-css.ts 的 `validateAssetAgainstTokens` 在渲染任务里做的。
 */
function validateVariantDeclarations(variants: JsonRecord): void {
  for (const [variantName, variant] of Object.entries(variants)) {
    if (!isRecord(variant)) throw new BadRequestException(`variants.${variantName} 必须是对象`);
    if (!isRecord(variant.declarations)) {
      throw new BadRequestException(`variants.${variantName} 必须包含 declarations 对象`);
    }
    if (Object.keys(variant.declarations).length === 0) {
      throw new BadRequestException(`variants.${variantName}.declarations 不能为空`);
    }
    assertSafeJson(variant.declarations);
    if (variant.states !== undefined && !isRecord(variant.states)) {
      throw new BadRequestException(`variants.${variantName}.states 必须是对象`);
    }
    if (variant.pseudo !== undefined && !isRecord(variant.pseudo)) {
      throw new BadRequestException(`variants.${variantName}.pseudo 必须是对象`);
    }
  }
}

/**
 * 钉住的依赖版本校验。
 *
 * style_pack / 组件 v2 / 动画共用。抽出来的直接原因：原先这套 UUID 校验与
 * 「同一文档不能钉多个版本」的去重只写在 validateStylePack 里，组件若漏掉，
 * 非 UUID 值会在查库时静默查不到，而**两项完全相同**会撞
 * `@@unique([fromVersionId, toVersionId, dependencyType])` 抛出未捕获的 P2002。
 */
function validatePinnedDependencies(content: JsonRecord, label: string): void {
  if (!Array.isArray(content.dependencies) || content.dependencies.length === 0) {
    throw new BadRequestException(`${label}必须至少固定一个依赖版本`);
  }
  for (const dependency of content.dependencies) {
    if (!isRecord(dependency) || !isUuid(dependency.documentId) || !isUuid(dependency.versionId)) {
      throw new BadRequestException(`${label}的依赖必须包含合法的 documentId 和 versionId`);
    }
  }
  const documentIds = new Set<string>();
  for (const dependency of content.dependencies as JsonRecord[]) {
    const documentId = dependency.documentId as string;
    if (documentIds.has(documentId)) {
      throw new BadRequestException(`${label}不能固定同一设计文档的多个版本`);
    }
    documentIds.add(documentId);
  }
}

function validateLayoutDocument(content: JsonRecord): JsonRecord {
  if (content.schemaVersion !== 'aurum.layout.v1') {
    throw new BadRequestException('布局文档必须使用 schemaVersion: aurum.layout.v1');
  }
  if (typeof content.layoutType !== 'string' || !/^[a-z][a-z0-9-]*$/.test(content.layoutType)) {
    throw new BadRequestException('layoutType 必须是小写 kebab-case');
  }
  if (!Array.isArray(content.regions) || content.regions.length === 0) {
    throw new BadRequestException('布局文档必须至少定义一个 region');
  }
  return content;
}

function validateStylePack(content: JsonRecord): JsonRecord {
  if (content.schemaVersion !== 'aurum.style-pack.v1') {
    throw new BadRequestException('样式包必须使用 schemaVersion: aurum.style-pack.v1');
  }
  validatePinnedDependencies(content, '样式包');
  return content;
}

function assertSafeJson(value: unknown, depth = 0): void {
  if (depth > 20) throw new BadRequestException('设计规范 JSON 嵌套过深');
  if (typeof value === 'string') {
    // 先剔除合法的 token 别名再跑字符黑名单。
    //
    // 必须这样做：`"{space.md} {space.lg}"` 这类「别名 + 其它内容」的多值写法，
    // 以及 `linear-gradient(90deg, {color.a}, {color.b})`，它们的 `{`/`}` 会被
    // 黑名单误伤，而 isTokenAlias 只赦免「整串就是一个别名」的情形。
    // 不完整别名（如 `a{b`）不会被剔除，`{` 仍在 → 仍然被拒。
    const withoutAliases = value.replace(TOKEN_ALIAS_PATTERN, '');
    if (
      value.length > 10_000 ||
      (!isTokenAlias(value) &&
        /[;{}<>]|<\s*script|javascript\s*:|url\s*\(|@import|expression\s*\(/i.test(withoutAliases))
    ) {
      throw new BadRequestException('设计规范不允许包含脚本或不安全 URL');
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 200) throw new BadRequestException('设计规范数组过长');
    value.forEach((item) => assertSafeJson(item, depth + 1));
    return;
  }
  if (isRecord(value)) {
    if (Object.keys(value).length > 200) throw new BadRequestException('设计规范对象字段过多');
    Object.entries(value).forEach(([key, child]) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new BadRequestException('设计规范包含不安全字段');
      }
      // `__` 前缀是渲染期的内部注入命名空间（如 __aurumFixtureDependencies）。
      // 放行它们会让运营手贴的内容把这个键写进正式版本，再出现在 json 导出里。
      if (key.startsWith('__')) {
        throw new BadRequestException(`设计规范不允许使用保留字段前缀: ${key}`);
      }
      assertSafeJson(child, depth + 1);
    });
  }
}

function validateTokenValue(type: string, value: unknown, path: string): void {
  if (isValidValueForTokenType(type, value)) return;
  throw new BadRequestException(`Token ${path} 的 $value 不符合 ${type} 类型`);
}

/**
 * 按 token 类型校验值语法。
 *
 * 导出给 design-css.ts 的声明契约复用——CSS 声明与 token 的取值语法本来就该
 * 只有一份定义，否则两边会各自漂移。
 */
export function isValidValueForTokenType(type: string, value: unknown): boolean {
  // 别名在整个类型体系里都是合法值，指向是否正确由别名解析负责
  if (typeof value === 'string' && isTokenAlias(value)) return true;
  if (type === 'color') return isValidColorValue(value);
  if (type === 'dimension') return isValidDimensionValue(value);
  if (type === 'number') return isValidNumberValue(value);
  if (type === 'fontWeight') return isValidFontWeightValue(value);
  if (type === 'duration') return isValidDurationValue(value);
  if (type === 'fontFamily' || type === 'string') return isValidFontFamilyValue(value);
  if (type === 'cubicBezier') {
    return (
      Array.isArray(value) &&
      value.length === 4 &&
      value.every((item) => typeof item === 'number' && Number.isFinite(item))
    );
  }
  if (
    type === 'strokeStyle' ||
    type === 'border' ||
    type === 'transition' ||
    type === 'shadow' ||
    type === 'typography'
  ) {
    return isRecord(value);
  }
  return false;
}

/** 是否是该类型 token 可用的类型名 */
export function isTokenType(type: string): boolean {
  return TOKEN_TYPES.has(type);
}

export function isValidColorValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return (
    /^(?:#[0-9a-f]{3,8}|transparent|currentColor)$/i.test(value) ||
    /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(
      value,
    ) ||
    /^hsla?\(\s*\d{1,3}(?:\.\d+)?(?:deg)?\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(
      value,
    )
  );
}

export function isValidDimensionValue(value: unknown): boolean {
  if (typeof value === 'number' && Number.isFinite(value)) return true;
  return (
    typeof value === 'string' && /^(?:0|-?\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|pt|pc|in|cm|mm))$/.test(value)
  );
}

export function isValidNumberValue(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isValidFontWeightValue(value: unknown): boolean {
  if (typeof value === 'number' && Number.isFinite(value)) return true;
  return (
    typeof value === 'string' &&
    /^(?:thin|extra-light|light|normal|regular|medium|semi-bold|bold|extra-bold|black)$/i.test(value)
  );
}

export function isValidDurationValue(value: unknown): boolean {
  if (typeof value === 'number' && Number.isFinite(value)) return true;
  return typeof value === 'string' && /^-?\d+(?:\.\d+)?(?:ms|s)$/.test(value);
}

export function isValidFontFamilyValue(value: unknown): boolean {
  return typeof value === 'string' && /^[\w ,.'"-]+$/u.test(value);
}


function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

/** 整串就是一个别名，例如 `{color.primary}` */
export function isTokenAlias(value: string): boolean {
  return /^\{[a-zA-Z0-9_.-]+\}$/.test(value);
}

/**
 * 值内部的别名匹配（全局）。
 *
 * 只配合 String.prototype.replace 使用：replace 会重置 lastIndex。
 * 不要拿它做 .test()，全局正则的 lastIndex 会在多次调用间残留。
 */
const TOKEN_ALIAS_PATTERN = /\{[a-zA-Z0-9_.-]+\}/g;

/** 提取值里引用的全部 token 路径（不含花括号） */
export function extractTokenAliases(value: string): string[] {
  return [...value.matchAll(TOKEN_ALIAS_PATTERN)].map((match) => match[0].slice(1, -1));
}

