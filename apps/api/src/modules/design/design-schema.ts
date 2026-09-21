import { BadRequestException } from '@nestjs/common';
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
  if (kind === 'component') return validateComponentDocument(content);
  if (kind === 'layout') return validateLayoutDocument(content);
  return validateStylePack(content);
}

export function getStylePackDependencies(
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

function validateComponentDocument(content: JsonRecord): JsonRecord {
  if (content.schemaVersion !== 'aurum.component.v1') {
    throw new BadRequestException('组件文档必须使用 schemaVersion: aurum.component.v1');
  }
  if (
    typeof content.componentType !== 'string' ||
    !/^[a-z][a-z0-9-]*$/.test(content.componentType)
  ) {
    throw new BadRequestException('componentType 必须是小写 kebab-case');
  }
  if (!isRecord(content.variants)) throw new BadRequestException('组件文档必须包含 variants 对象');
  return content;
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
  if (!Array.isArray(content.dependencies) || content.dependencies.length === 0) {
    throw new BadRequestException('样式包必须至少固定一个依赖版本');
  }
  for (const dependency of content.dependencies) {
    if (!isRecord(dependency) || !isUuid(dependency.documentId) || !isUuid(dependency.versionId)) {
      throw new BadRequestException('样式包依赖必须包含合法的 documentId 和 versionId');
    }
  }
  const documentIds = new Set<string>();
  for (const dependency of content.dependencies as JsonRecord[]) {
    const documentId = dependency.documentId as string;
    if (documentIds.has(documentId)) {
      throw new BadRequestException('样式包不能固定同一设计文档的多个版本');
    }
    documentIds.add(documentId);
  }
  return content;
}

function assertSafeJson(value: unknown, depth = 0): void {
  if (depth > 20) throw new BadRequestException('设计规范 JSON 嵌套过深');
  if (typeof value === 'string') {
    if (
      value.length > 10_000 ||
      (!isTokenAlias(value) && /[;{}<>]|<\s*script|javascript\s*:|url\s*\(|@import|expression\s*\(/i.test(value))
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
      assertSafeJson(child, depth + 1);
    });
  }
}

function validateTokenValue(type: string, value: unknown, path: string): void {
  const fail = () => {
    throw new BadRequestException(`Token ${path} 的 $value 不符合 ${type} 类型`);
  };
  if (typeof value === 'string' && /^\{[a-zA-Z0-9_.-]+\}$/.test(value)) return;
  if (type === 'color') {
    if (
      typeof value !== 'string' ||
      !(
        /^(?:#[0-9a-f]{3,8}|transparent|currentColor)$/i.test(value) ||
        /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(
          value,
        ) ||
        /^hsla?\(\s*\d{1,3}(?:\.\d+)?(?:deg)?\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(
          value,
        )
      )
    )
      fail();
    return;
  }
  if (type === 'dimension') {
    if (
      !(typeof value === 'number' && Number.isFinite(value)) &&
      !(
        typeof value === 'string' &&
        /^(?:0|-?\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|pt|pc|in|cm|mm))$/.test(value)
      )
    )
      fail();
    return;
  }
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail();
    return;
  }
  if (type === 'fontWeight') {
    if (
      !(typeof value === 'number' && Number.isFinite(value)) &&
      !(
        typeof value === 'string' &&
        /^(?:thin|extra-light|light|normal|regular|medium|semi-bold|bold|extra-bold|black)$/i.test(
          value,
        )
      )
    )
      fail();
    return;
  }
  if (type === 'duration') {
    if (
      !(typeof value === 'number' && Number.isFinite(value)) &&
      !(typeof value === 'string' && /^-?\d+(?:\.\d+)?(?:ms|s)$/.test(value))
    )
      fail();
    return;
  }
  if (type === 'fontFamily' || type === 'string') {
    if (typeof value !== 'string' || !/^[\w ,.'"-]+$/u.test(value)) fail();
    return;
  }
  if (type === 'cubicBezier') {
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      value.some((item) => typeof item !== 'number' || !Number.isFinite(item))
    )
      fail();
    return;
  }
  if (
    type === 'strokeStyle' ||
    type === 'border' ||
    type === 'transition' ||
    type === 'shadow' ||
    type === 'typography'
  ) {
    if (!isRecord(value)) fail();
  }
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

function isTokenAlias(value: string) {
  return /^\{[a-zA-Z0-9_.-]+\}$/.test(value);
}
