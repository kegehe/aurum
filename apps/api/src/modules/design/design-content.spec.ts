import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  assertDraftCurrent,
  canonicalJson,
  contentHash,
  getCandidateContent,
  normalizeAiComponentContent,
  normalizeComponentStateVariants,
  resolveFixtureContent,
} from './design-content';

/**
 * 设计内容内核的特征化测试。
 *
 * 这些规则原先散在 `design.service.ts` 的私有方法里，只能通过 `service as never as {...}`
 * 这种强转间接测到；抽成内核后可以直接测函数本身。
 */

describe('resolveFixtureContent', () => {
  it('flattens nested style-pack dependencies into renderable leaf documents', async () => {
    const nestedPack = {
      schemaVersion: 'aurum.style-pack.v1',
      dependencies: [{ documentId: 'theme-document', versionId: 'theme-v1' }],
    };
    const versions = new Map([
      [
        'pack-v1',
        { id: 'pack-v1', documentId: 'pack-document', content: JSON.stringify(nestedPack) },
      ],
      [
        'theme-v1',
        {
          id: 'theme-v1',
          documentId: 'theme-document',
          content: JSON.stringify({
            tokenSchemaVersion: 'aurum.tokens.v1',
            tokens: { color: { primary: { $type: 'color', $value: '#1769aa' } } },
          }),
        },
      ],
    ]);
    const prisma = {
      designVersion: {
        findMany: vi
          .fn()
          .mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
            Promise.resolve(where.id.in.map((id) => versions.get(id)).filter(Boolean)),
          ),
      },
    };
    const root = {
      schemaVersion: 'aurum.style-pack.v1',
      dependencies: [{ documentId: 'pack-document', versionId: 'pack-v1' }],
    };

    const resolved = await resolveFixtureContent(prisma as never, root);

    expect(resolved.__aurumFixtureDependencies).toEqual([
      expect.objectContaining({ documentId: 'theme-document', versionId: 'theme-v1' }),
    ]);
  });

  it('rejects cyclic nested style-pack version references', async () => {
    const versions = new Map([
      [
        'pack-a',
        {
          id: 'pack-a',
          documentId: 'pack-a-document',
          content: JSON.stringify({
            schemaVersion: 'aurum.style-pack.v1',
            dependencies: [{ documentId: 'pack-b-document', versionId: 'pack-b' }],
          }),
        },
      ],
      [
        'pack-b',
        {
          id: 'pack-b',
          documentId: 'pack-b-document',
          content: JSON.stringify({
            schemaVersion: 'aurum.style-pack.v1',
            dependencies: [{ documentId: 'pack-a-document', versionId: 'pack-a' }],
          }),
        },
      ],
    ]);
    const prisma = {
      designVersion: {
        findMany: vi
          .fn()
          .mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
            Promise.resolve(where.id.in.map((id) => versions.get(id)).filter(Boolean)),
          ),
      },
    };

    await expect(
      resolveFixtureContent(prisma as never, {
        schemaVersion: 'aurum.style-pack.v1',
        dependencies: [{ documentId: 'pack-a-document', versionId: 'pack-a' }],
      }),
    ).rejects.toThrow('循环版本引用');
  });

  it('无依赖的内容原样返回，不查库', async () => {
    const prisma = { designVersion: { findMany: vi.fn() } };
    const content = { schemaVersion: 'aurum.tokens.v1', tokens: {} };

    await expect(resolveFixtureContent(prisma as never, content)).resolves.toEqual(content);
    expect(prisma.designVersion.findMany).not.toHaveBeenCalled();
  });

  it('依赖版本归属与声明不符时拒绝，避免解析到别的文档的内容', async () => {
    const prisma = {
      designVersion: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: 'v1', documentId: 'some-other-document', content: '{}' }]),
      },
    };

    await expect(
      resolveFixtureContent(prisma as never, {
        schemaVersion: 'aurum.style-pack.v1',
        dependencies: [{ documentId: 'expected-document', versionId: 'v1' }],
      }),
    ).rejects.toThrow('不属于声明的文档');
  });
});

describe('normalizeComponentStateVariants', () => {
  it('folds hover/active sibling variants into default.states', () => {
    const content = {
      schemaVersion: 'aurum.component.v2',
      componentType: 'lime-pill-button',
      appliesTo: 'element',
      variants: {
        active: { declarations: { transform: 'scale(0.97)' } },
        default: {
          declarations: { 'background-color': 'rgb(161, 255, 20)' },
          states: { hover: { 'background-color': 'rgb(180, 255, 60)' } },
        },
        hover: { declarations: { 'background-color': 'rgb(192, 255, 20)' } },
      },
    };

    const normalized = normalizeComponentStateVariants(content);
    const variants = normalized.variants as Record<string, Record<string, unknown>>;
    expect(Object.keys(variants)).toEqual(['default']);
    // 已写进 states 的 hover 优先；active 被搬进来。
    expect(variants.default.states).toEqual({
      hover: { 'background-color': 'rgb(180, 255, 60)' },
      active: { transform: 'scale(0.97)' },
    });
    // 原对象不被修改。
    expect(Object.keys(content.variants)).toContain('active');
  });

  it('uses the first non-state variant when the model drops default', () => {
    const normalized = normalizeComponentStateVariants({
      schemaVersion: 'aurum.component.v2',
      componentType: 'badge',
      variants: {
        hover: { declarations: { opacity: '0.8' } },
        primary: { declarations: { color: '#ffffff' } },
      },
    });
    const variants = normalized.variants as Record<string, Record<string, unknown>>;
    expect(Object.keys(variants)).toEqual(['primary']);
    expect(variants.primary.states).toEqual({ hover: { opacity: '0.8' } });
  });

  it('leaves state-named variants alone when they carry other semantics', () => {
    const content = {
      schemaVersion: 'aurum.component.v2',
      componentType: 'badge',
      variants: {
        default: { declarations: { color: '#ffffff' } },
        hover: { declarations: { opacity: '0.8' }, pseudo: { before: { content: "''" } } },
      },
    };
    expect(normalizeComponentStateVariants(content)).toBe(content);
  });

  it('unwraps an extra declarations layer inside a state', () => {
    // 基底的 variant 是 { declarations: {...} }，模型照着写成了 { hover: { declarations: {...} } }。
    const normalized = normalizeComponentStateVariants({
      schemaVersion: 'aurum.component.v2',
      componentType: 'lime-pill-button',
      variants: {
        default: {
          declarations: { color: '#0f172a' },
          states: {
            hover: { declarations: { 'background-color': '#c0ff14' } },
            active: { declarations: { transform: 'scale(0.97)' } },
          },
        },
      },
    });
    const variants = normalized.variants as Record<string, Record<string, unknown>>;
    expect(variants.default.states).toEqual({
      hover: { 'background-color': '#c0ff14' },
      active: { transform: 'scale(0.97)' },
    });
  });

  it('drops AI pseudo elements that cannot render', () => {
    const normalized = normalizeAiComponentContent({
      schemaVersion: 'aurum.component.v2',
      componentType: 'lime-pill-button',
      variants: {
        default: {
          declarations: { color: '#0f172a' },
          pseudo: {
            before: { 'font-size': '14px' },
            after: { content: "'+'" },
            placeholder: { content: "''" },
          },
        },
      },
    });
    const variants = normalized.variants as Record<string, Record<string, unknown>>;
    expect(variants.default.pseudo).toEqual({ after: { content: "'+'" } });
  });
});

describe('canonicalJson', () => {
  // contentHash 建立在它之上；键序不稳定的话，内容相同但键序不同的文档会算出不同哈希，
  // 去重与"内容未变"判断就全失效。
  it('键序不影响结果，保证内容哈希可用于去重', () => {
    const a = { b: 1, a: { d: 2, c: [3, 4] } };
    const b = { a: { c: [3, 4], d: 2 }, b: 1 };

    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(contentHash(canonicalJson(a))).toBe(contentHash(canonicalJson(b)));
  });

  it('数组顺序是有意义的，不能被排序', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('getCandidateContent', () => {
  const validPatch = JSON.stringify({
    schema: 'aurum.domain-patch.v1',
    operations: [
      {
        op: 'replace_document_content',
        documentKind: 'component',
        value: {
          schemaVersion: 'aurum.component.v2',
          componentType: 'glass-card',
          variants: { default: { declarations: { color: '#1769aa' } } },
          // component v2 要求至少钉一个依赖版本
          dependencies: [
            {
              documentId: '2e0c21c4-44f1-4e53-8daa-ff796d722049',
              versionId: '3e0c21c4-44f1-4e53-8daa-ff796d722049',
            },
          ],
        },
      },
    ],
  });

  it('接受符合受限领域协议的候选', () => {
    const content = getCandidateContent(validPatch, 'component');
    expect(content.componentType).toBe('glass-card');
  });

  it('Patch 不是合法 JSON 时给出明确错误', () => {
    expect(() => getCandidateContent('{ not json', 'component')).toThrow('候选 Patch 已损坏');
  });

  it('协议不符时拒绝（可能是模型跑偏或被篡改）', () => {
    const wrongSchema = JSON.stringify({
      schema: 'something-else',
      operations: [{ op: 'replace_document_content', documentKind: 'component', value: {} }],
    });
    expect(() => getCandidateContent(wrongSchema, 'component')).toThrow('不符合受限领域协议');
  });

  it('documentKind 与文档类型不符时拒绝', () => {
    expect(() => getCandidateContent(validPatch, 'theme')).toThrow('不符合受限领域协议');
  });

  it('把旧候选里写成同级 variant 的状态归一化', () => {
    const legacyPatch = JSON.stringify({
      schema: 'aurum.domain-patch.v1',
      operations: [
        {
          op: 'replace_document_content',
          documentKind: 'component',
          value: {
            schemaVersion: 'aurum.component.v2',
            componentType: 'custom-component',
            variants: {
              active: { declarations: { transform: 'scale(0.97)' } },
              default: { declarations: { 'background-color': '#a1ff14' } },
              hover: { declarations: { transform: 'translateY(-1px)' } },
            },
            dependencies: [
              {
                documentId: '2e0c21c4-44f1-4e53-8daa-ff796d722049',
                versionId: '3e0c21c4-44f1-4e53-8daa-ff796d722049',
              },
            ],
          },
        },
      ],
    });
    const content = getCandidateContent(legacyPatch, 'component');
    const variants = content.variants as Record<string, Record<string, unknown>>;
    expect(Object.keys(variants)).toEqual(['default']);
    expect(variants.default.states).toEqual({
      active: { transform: 'scale(0.97)' },
      hover: { transform: 'translateY(-1px)' },
    });
  });
});

describe('assertDraftCurrent', () => {
  it('基准版本一致时放行', () => {
    expect(() =>
      assertDraftCurrent({ baseVersionId: 'v1' }, { currentPublishedVersionId: 'v1' }),
    ).not.toThrow();
  });

  // 409 而非 400：这是并发冲突，不是请求参数错误。
  it('文档已被发布到别的版本时抛 Conflict', () => {
    expect(() =>
      assertDraftCurrent({ baseVersionId: 'v1' }, { currentPublishedVersionId: 'v2' }),
    ).toThrow(ConflictException);
  });

  it('文档尚未发布时也视为过期', () => {
    expect(() =>
      assertDraftCurrent({ baseVersionId: 'v1' }, { currentPublishedVersionId: null }),
    ).toThrow(ConflictException);
  });
});
