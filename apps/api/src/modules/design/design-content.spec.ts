import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  assertDraftCurrent,
  canonicalJson,
  contentHash,
  getCandidateContent,
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
