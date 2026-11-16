import { createHash } from 'crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PSEUDO_STATES } from './design-css';
import { getPinnedDependencies, validateDesignContent } from './design-schema';
import type { DesignKind, DomainPatch, JsonRecord } from './design.types';

/**
 * 设计内容的规范化、校验与依赖解析。
 *
 * 这些规则此前散在 `design.service.ts` 的私有方法和文件末尾，被 **四个不同职责簇**
 * 共用：发布文档、生成候选、跨文档变更集、AI 任务处理。它们不属于任何单个工作流，
 * 所以先抽成独立内核，后续按工作流拆服务时才有干净的接缝可用——
 * 否则每拆一个服务都要把这几条规则复制一遍，或者制造跨服务调用。
 *
 * 命名约定与同目录的 `design-schema.ts` / `design-css.ts` / `design-export.ts` 一致：
 * 无状态函数模块。需要数据库的函数把 client 作为第一个参数显式传入，
 * 避免为了共享几条规则就在服务之间建立依赖边。
 */

// ==================== 内容规范化与校验 ====================

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 按稳定顺序序列化，用于内容哈希与去重。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function parseContent(content: string): JsonRecord {
  try {
    return JSON.parse(content) as JsonRecord;
  } catch {
    throw new BadRequestException('已发布设计版本内容损坏');
  }
}

/**
 * 从候选的受限领域协议 Patch 中取出内容。
 *
 * 校验的是协议本身而不是内容——内容交给 `validateDesignContent`。
 * 两者分开是因为失败含义不同：协议不符说明候选根本不该入库（可能是模型跑偏或篡改），
 * 内容不符才是"模型能自己修"的那类问题。
 */
export function getCandidateContent(serializedPatch: string, expectedKind: DesignKind): JsonRecord {
  let patch: DomainPatch;
  try {
    patch = JSON.parse(serializedPatch) as DomainPatch;
  } catch {
    throw new BadRequestException('候选 Patch 已损坏');
  }
  const operation = patch.operations?.[0];
  if (
    patch.schema !== 'aurum.domain-patch.v1' ||
    operation?.op !== 'replace_document_content' ||
    operation.documentKind !== expectedKind
  ) {
    throw new BadRequestException('候选 Patch 不符合受限领域协议');
  }
  const content = validateDesignContent(operation.documentKind, operation.value);
  // 候选是历史数据时也要按当前结构约定解释：旧候选发布/渲染前归一化，
  // 否则页面预览（已归一化）和最终发布物会不一致。
  return operation.documentKind === 'component'
    ? normalizeComponentStateVariants(content)
    : content;
}

/**
 * 把 AI 误写成同级 variant 的交互状态折回 `default.states`。
 *
 * 模型的常见手滑：返回 `variants: { hover: {...}, default: {...}, active: {...} }`。
 * 这在 schema 里是合法文档，但预览/导出只给骨架挂一个 variant 类，`hover` 与
 * `active` 会永远不生效；而 `default` 还未必是第一个键。这里只做结构归位，
 * 不改声明值，也不处理带额外字段的变体（可能有别的语义）。
 */
export function normalizeComponentStateVariants(content: JsonRecord): JsonRecord {
  if (!isRecord(content.variants)) return content;
  const variants = content.variants;
  const names = Object.keys(variants);
  const stateNames = new Set<string>(PSEUDO_STATES);
  const nextVariants: JsonRecord = { ...variants };
  let changed = false;

  // 模型会把状态写成 `{ "hover": { "declarations": {...} } }`，因为基底里的
  // variant 就是这种形状。states 的值本身就该是声明对象，这里拆掉多余的一层。
  for (const name of names) {
    const variant = nextVariants[name];
    if (!isRecord(variant) || !isRecord(variant.states)) continue;
    const states = { ...variant.states };
    let stateChanged = false;
    for (const [stateName, state] of Object.entries(states)) {
      if (!isRecord(state)) continue;
      const keys = Object.keys(state);
      if (keys.length === 1 && keys[0] === 'declarations' && isRecord(state.declarations)) {
        states[stateName] = state.declarations;
        stateChanged = true;
      }
    }
    if (stateChanged) {
      nextVariants[name] = { ...variant, states };
      changed = true;
    }
  }

  const baseName = names.includes('default')
    ? 'default'
    : names.find((name) => !stateNames.has(name) && isRecord(nextVariants[name]));
  if (!baseName) return changed ? { ...content, variants: nextVariants } : content;
  const base = nextVariants[baseName];
  if (!isRecord(base)) return changed ? { ...content, variants: nextVariants } : content;

  const foldable = names.filter((name) => {
    if (name === baseName || !stateNames.has(name)) return false;
    const sibling = nextVariants[name];
    return (
      isRecord(sibling) &&
      isRecord(sibling.declarations) &&
      Object.keys(sibling).every((key) => key === 'declarations')
    );
  });
  if (foldable.length === 0) return changed ? { ...content, variants: nextVariants } : content;

  const states = isRecord(base.states) ? { ...base.states } : {};
  for (const name of foldable) {
    const declarations = (nextVariants[name] as JsonRecord).declarations;
    if (!isRecord(declarations)) continue;
    const existing = isRecord(states[name]) ? states[name] : {};
    // 已经写进 states 的优先级更高：那是模型明确表达的伪状态。
    states[name] = { ...declarations, ...existing };
  }

  nextVariants[baseName] = { ...base, states };
  for (const name of foldable) delete nextVariants[name];
  return { ...content, variants: nextVariants };
}

/**
 * AI 输出专用的宽容归位：在状态结构之外，还丢掉渲染不出东西的伪元素。
 *
 * 提示词鼓励模型用 `::before` 放图标，但状态/伪元素是最容易写错形状的两处。
 * 一个没有 content 的伪元素本来就什么都不会渲染，让它否决整份组件没有意义；
 * 其余声明照常进校验。此函数只用于 AI 生成链路，不改变用户手写内容的语义。
 */
export function normalizeAiComponentContent(content: JsonRecord): JsonRecord {
  const normalized = normalizeComponentStateVariants(content);
  if (!isRecord(normalized.variants)) return normalized;
  const variants: JsonRecord = {};
  let changed = false;
  for (const [name, variant] of Object.entries(normalized.variants)) {
    if (!isRecord(variant) || !isRecord(variant.pseudo)) {
      variants[name] = variant;
      continue;
    }
    const pseudo: JsonRecord = {};
    for (const [element, declarations] of Object.entries(variant.pseudo)) {
      if (
        (element === 'before' || element === 'after') &&
        isRecord(declarations) &&
        typeof declarations.content === 'string' &&
        /^(["']).*\1$/s.test(declarations.content.trim())
      ) {
        pseudo[element] = declarations;
      } else {
        changed = true;
      }
    }
    const nextVariant: JsonRecord = { ...variant, pseudo };
    if (Object.keys(pseudo).length === 0) delete nextVariant.pseudo;
    variants[name] = nextVariant;
  }
  return changed ? { ...normalized, variants } : normalized;
}

// ==================== 版本与草稿前置条件 ====================

/**
 * 草稿的基准版本必须仍是文档当前的正式版本。
 *
 * 这是乐观并发的第一道闸：草稿创建后文档可能已被别人发布过新版本，
 * 此时基于旧版本生成的候选直接发布会把别人的改动覆盖掉。
 */
export function assertDraftCurrent(
  draft: { baseVersionId: string },
  document: { currentPublishedVersionId: string | null },
): void {
  if (document.currentPublishedVersionId !== draft.baseVersionId) {
    throw new ConflictException('草稿基准版本已过期，请基于当前正式版本创建新草稿');
  }
}

export async function ensureDraftExists(prisma: PrismaService, id: string): Promise<void> {
  const count = await prisma.designDraft.count({ where: { id } });
  if (count === 0) throw new NotFoundException(`草稿 ${id} 不存在`);
}

// ==================== 依赖规则 ====================

/**
 * 发布前的依赖门禁：钉住的依赖版本必须都已发布。
 *
 * 按内容里有没有依赖判断，而不是按 kind —— 这样新增 pin 依赖的 kind 时
 * 不需要回来补这里的 kind 判断，漏改就会静默跳过校验。
 */
export async function assertDependenciesPublished(
  prisma: PrismaService,
  content: JsonRecord,
  currentDocumentId: string,
): Promise<void> {
  const dependencies = getPinnedDependencies(content);
  if (dependencies.length === 0) return;
  if (dependencies.some((item) => item.documentId === currentDocumentId)) {
    throw new BadRequestException('设计资产不能依赖自身');
  }
  for (const dependency of dependencies) {
    const version = await prisma.designVersion.findFirst({
      where: {
        id: dependency.versionId,
        documentId: dependency.documentId,
        publishedAt: { not: null },
      },
    });
    if (!version)
      throw new BadRequestException(`钉住的依赖版本 ${dependency.versionId} 不存在或未发布`);
  }
}

/**
 * 写入依赖边。
 *
 * 这张表是「共享主题更新不能静默改变已发布样式包」的唯一持久化证据，
 * 所以早退条件曾写成 `kind !== 'style_pack'` 时，组件与动画的依赖边根本写不进来。
 * 与 assertDependenciesPublished 一样按内容判断。
 */
export async function createDependencies(
  tx: Prisma.TransactionClient,
  content: JsonRecord,
  fromDocumentId: string,
  fromVersionId: string,
): Promise<void> {
  const dependencies = getPinnedDependencies(content);
  if (dependencies.length === 0) return;
  for (const dependency of dependencies) {
    if (dependency.documentId === fromDocumentId) {
      throw new BadRequestException('设计资产不能依赖自身');
    }
    const version = await tx.designVersion.findFirst({
      where: {
        id: dependency.versionId,
        documentId: dependency.documentId,
        publishedAt: { not: null },
      },
    });
    if (!version) {
      throw new BadRequestException(
        `钉住的依赖版本 ${dependency.versionId} 不存在、未发布或不属于指定文档`,
      );
    }
  }
  await tx.designDependency.createMany({
    data: dependencies.map((dependency) => ({
      fromDocumentId,
      fromVersionId,
      toDocumentId: dependency.documentId,
      toVersionId: dependency.versionId,
    })),
  });
}

// ==================== 依赖内容解析（渲染用） ====================

type FixtureDependency = { documentId: string; versionId: string; content: JsonRecord };

function isFixtureDependency(value: unknown): value is FixtureDependency {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const dependency = value as JsonRecord;
  return (
    typeof dependency.documentId === 'string' &&
    typeof dependency.versionId === 'string' &&
    dependency.content !== null &&
    typeof dependency.content === 'object' &&
    !Array.isArray(dependency.content)
  );
}

function deduplicateFixtureDependencies(dependencies: FixtureDependency[]): FixtureDependency[] {
  const unique = new Map<string, FixtureDependency>();
  for (const dependency of dependencies) {
    unique.set(`${dependency.documentId}:${dependency.versionId}`, dependency);
  }
  return [...unique.values()];
}

/**
 * 把钉住的依赖版本递归展开成渲染可用的叶子内容。
 *
 * 与 kind 无关：组件 v2 与动画同样钉住依赖版本，也必须能解析出主题 token。
 * 早期这里硬编码了 style-pack 的 schemaVersion，于是组件的 dependencies
 * 永远不进解析，渲染出来是一堆未解析的 `{color.action.primary}` 字面量。
 */
export async function resolveFixtureContent(
  prisma: PrismaService,
  content: JsonRecord,
  visitedVersionIds = new Set<string>(),
): Promise<JsonRecord> {
  if (!Array.isArray(content.dependencies) || content.dependencies.length === 0) {
    return content;
  }
  const dependencies = getPinnedDependencies(content);
  if (!dependencies.length) return content;
  for (const dependency of dependencies) {
    if (visitedVersionIds.has(dependency.versionId)) {
      throw new BadRequestException('设计资产的钉住依赖存在循环版本引用');
    }
  }
  const versions = await prisma.designVersion.findMany({
    where: { id: { in: dependencies.map((dependency) => dependency.versionId) } },
    select: { id: true, documentId: true, content: true },
  });
  const versionById = new Map(versions.map((version) => [version.id, version]));
  const resolvedDependencies: FixtureDependency[] = [];
  for (const dependency of dependencies) {
    const version = versionById.get(dependency.versionId);
    if (!version || version.documentId !== dependency.documentId) {
      throw new BadRequestException('钉住的依赖版本不存在，或不属于声明的文档');
    }
    const nextVisited = new Set(visitedVersionIds);
    nextVisited.add(dependency.versionId);
    const resolved = await resolveFixtureContent(
      prisma,
      parseContent(version.content),
      nextVisited,
    );
    if (Array.isArray(resolved.__aurumFixtureDependencies)) {
      for (const nested of resolved.__aurumFixtureDependencies) {
        if (isFixtureDependency(nested)) resolvedDependencies.push(nested);
      }
    } else {
      resolvedDependencies.push({
        documentId: dependency.documentId,
        versionId: dependency.versionId,
        content: resolved,
      });
    }
  }
  return {
    ...content,
    __aurumFixtureDependencies: deduplicateFixtureDependencies(resolvedDependencies),
  };
}
