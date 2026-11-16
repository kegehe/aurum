import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, contentHash } from './design-content';
import { DesignDocumentService } from './design-document.service';
import { DesignPublishService } from './design-publish.service';

/**
 * 发布路径的特征化测试。
 *
 * 这一段此前完全没有覆盖，而 `publishDraft` / `restoreVersion` 是设计运营台里最不能
 * 出错的地方：版本号、乐观并发守卫、状态机转移、ChangeSet 的原子发布约束。
 * 拆 `design.service.ts` 之前必须先把这些行为锁住，否则就是盲拆。
 */

const DOCUMENT_ID = '0e0c21c4-44f1-4e53-8daa-ff796d722049';
const BASE_VERSION_ID = '1e0c21c4-44f1-4e53-8daa-ff796d722049';
const CANDIDATE_ID = '4e0c21c4-44f1-4e53-8daa-ff796d722049';
const DRAFT_ID = '5e0c21c4-44f1-4e53-8daa-ff796d722049';

function componentContent() {
  return {
    schemaVersion: 'aurum.component.v2',
    componentType: 'glass-card',
    appliesTo: 'container',
    dependencies: [
      {
        documentId: '2e0c21c4-44f1-4e53-8daa-ff796d722049',
        versionId: '3e0c21c4-44f1-4e53-8daa-ff796d722049',
      },
    ],
    variants: { default: { declarations: { color: '#1769aa' } } },
  };
}

function serializedPatch(content: unknown) {
  return JSON.stringify({
    schema: 'aurum.domain-patch.v1',
    operations: [{ op: 'replace_document_content', documentKind: 'component', value: content }],
  });
}

function buildPublishHarness(draftOverrides: Record<string, unknown> = {}) {
  const draft = {
    id: DRAFT_ID,
    documentId: DOCUMENT_ID,
    baseVersionId: BASE_VERSION_ID,
    status: 'ready',
    document: {
      id: DOCUMENT_ID,
      kind: 'component',
      currentPublishedVersionId: BASE_VERSION_ID,
    },
    candidates: [
      {
        id: CANDIDATE_ID,
        label: '方案 A',
        rationale: '',
        patch: serializedPatch(componentContent()),
        validationRuns: [{ status: 'succeeded' }],
      },
    ],
    changeSet: null,
    changeSetMemberships: [],
    ...draftOverrides,
  };

  const tx = {
    designVersion: {
      aggregate: vi.fn().mockResolvedValue({ _max: { versionNumber: 3 } }),
      create: vi
        .fn()
        .mockResolvedValue({ id: '6e0c21c4-44f1-4e53-8daa-ff796d722049', versionNumber: 4 }),
      findFirst: vi.fn().mockResolvedValue({ id: '3e0c21c4-44f1-4e53-8daa-ff796d722049' }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: BASE_VERSION_ID, versionNumber: 1 }),
    },
    designDocument: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    candidateProposal: { update: vi.fn().mockResolvedValue({}) },
    designDraft: { update: vi.fn().mockResolvedValue({}) },
    changeSet: { update: vi.fn().mockResolvedValue({}) },
    changeSetItem: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    designDependency: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };

  const prisma = {
    designDraft: { findUnique: vi.fn().mockResolvedValue(draft) },
    designVersion: {
      findFirst: vi.fn().mockResolvedValue({ id: '3e0c21c4-44f1-4e53-8daa-ff796d722049' }),
    },
    designDocument: {
      findUnique: vi.fn().mockResolvedValue({ id: DOCUMENT_ID, versions: [] }),
    },
    $transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(tx)),
  };

  const media = { assertAvailable: vi.fn().mockResolvedValue(undefined) };
  const service = new DesignPublishService(
    prisma as never,
    new DesignDocumentService(prisma as never),
    media as never,
  );
  return { service, prisma, tx, media };
}

describe('DesignService.publishDraft', () => {
  it('草稿不存在时抛 NotFound', async () => {
    const { service, prisma } = buildPublishHarness();
    prisma.designDraft.findUnique.mockResolvedValue(null);

    await expect(service.publishDraft(DRAFT_ID)).rejects.toThrow('不存在');
  });

  it('已发布的草稿幂等返回，不重复建版本', async () => {
    const { service, tx } = buildPublishHarness({ status: 'published' });

    await service.publishDraft(DRAFT_ID);

    expect(tx.designVersion.create).not.toHaveBeenCalled();
    expect(tx.designDocument.updateMany).not.toHaveBeenCalled();
  });

  it('草稿未就绪时拒绝发布', async () => {
    const { service } = buildPublishHarness({ status: 'editing' });

    await expect(service.publishDraft(DRAFT_ID)).rejects.toThrow('请先选择一个通过校验的候选方案');
  });

  it('位于多文档 ChangeSet 的草稿必须走 ChangeSet 原子发布', async () => {
    const { service } = buildPublishHarness({
      changeSetMemberships: [
        { changeSet: { status: 'draft', drafts: [{ id: DRAFT_ID }, { id: 'other-draft' }] } },
      ],
    });

    await expect(service.publishDraft(DRAFT_ID)).rejects.toThrow('必须通过 ChangeSet 原子发布');
  });

  it('ChangeSet 已发布时不再拦截', async () => {
    const { service, tx } = buildPublishHarness({
      changeSetMemberships: [
        {
          changeSet: {
            status: 'published',
            drafts: [{ id: DRAFT_ID }, { id: 'other-draft' }],
          },
        },
      ],
    });

    await service.publishDraft(DRAFT_ID);

    expect(tx.designVersion.create).toHaveBeenCalled();
  });

  it('没有通过校验的候选时拒绝发布', async () => {
    const { service } = buildPublishHarness({
      candidates: [
        {
          id: CANDIDATE_ID,
          label: '方案 A',
          rationale: '',
          patch: serializedPatch(componentContent()),
          validationRuns: [{ status: 'failed' }],
        },
      ],
    });

    await expect(service.publishDraft(DRAFT_ID)).rejects.toThrow('没有可发布的已校验候选方案');
  });

  it('最近一次校验失败时拒绝发布，旧的成功记录不能兜底', async () => {
    const { service, prisma } = buildPublishHarness({
      candidates: [
        {
          id: CANDIDATE_ID,
          label: '方案 A',
          rationale: '',
          patch: serializedPatch(componentContent()),
          // 查询已按 createdAt desc + take 1；这里模拟最新一条是 failed
          validationRuns: [{ status: 'failed' }, { status: 'succeeded' }],
        },
      ],
    });

    await expect(service.publishDraft(DRAFT_ID)).rejects.toThrow('没有可发布的已校验候选方案');
    expect(prisma.designDraft.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          candidates: expect.objectContaining({
            include: {
              validationRuns: {
                where: { status: { in: ['succeeded', 'failed'] } },
                orderBy: { createdAt: 'desc' },
                take: 1,
              },
            },
          }),
        }),
      }),
    );
  });

  it('草稿基准版本已过期时拒绝发布', async () => {
    const { service } = buildPublishHarness({
      document: {
        id: DOCUMENT_ID,
        kind: 'component',
        currentPublishedVersionId: 'ae0c21c4-44f1-4e53-8daa-ff796d722049',
      },
    });

    await expect(service.publishDraft(DRAFT_ID)).rejects.toThrow('草稿基准版本已过期');
  });

  it('乐观并发：正式版本在事务中被改走时抛 Conflict', async () => {
    const { service, tx } = buildPublishHarness();
    tx.designDocument.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.publishDraft(DRAFT_ID)).rejects.toThrow('正式版本已变化');
  });

  it('发布用条件更新认领版本，避免与并发发布互相覆盖', async () => {
    const { service, tx } = buildPublishHarness();

    await service.publishDraft(DRAFT_ID);

    expect(tx.designDocument.updateMany).toHaveBeenCalledWith({
      where: { id: DOCUMENT_ID, currentPublishedVersionId: BASE_VERSION_ID },
      data: {
        currentPublishedVersionId: '6e0c21c4-44f1-4e53-8daa-ff796d722049',
        status: 'published',
      },
    });
  });

  it('发布前校验素材仍可读，缺失时拒绝发布且不建版本', async () => {
    const { service, media, tx } = buildPublishHarness();
    media.assertAvailable.mockRejectedValue(new Error('素材不可用'));

    await expect(service.publishDraft(DRAFT_ID)).rejects.toThrow('素材不可用');
    expect(tx.designVersion.create).not.toHaveBeenCalled();
  });

  it('版本号取 max+1，changeKind 为 update', async () => {
    const { service, tx } = buildPublishHarness();

    const version = await service.publishDraft(DRAFT_ID);

    expect(tx.designVersion.aggregate).toHaveBeenCalledWith({
      where: { documentId: DOCUMENT_ID },
      _max: { versionNumber: true },
    });
    const created = tx.designVersion.create.mock.calls[0][0].data;
    expect(created.versionNumber).toBe(4);
    expect(created.changeKind).toBe('update');
    expect(created.baseVersionId).toBe(BASE_VERSION_ID);
    expect(created.publishedAt).toBeInstanceOf(Date);
    expect(version).toEqual({ id: '6e0c21c4-44f1-4e53-8daa-ff796d722049', versionNumber: 4 });
  });

  it('候选转为 published，草稿转为 published 并递增锁版本', async () => {
    const { service, tx } = buildPublishHarness();

    await service.publishDraft(DRAFT_ID);

    expect(tx.candidateProposal.update).toHaveBeenCalledWith({
      where: { id: CANDIDATE_ID },
      data: { status: 'published' },
    });
    expect(tx.designDraft.update).toHaveBeenCalledWith({
      where: { id: DRAFT_ID },
      data: { status: 'published', lockVersion: { increment: 1 } },
    });
  });

  it('单文档 ChangeSet 随草稿一起发布并写入发布事务号', async () => {
    const { service, tx } = buildPublishHarness({
      changeSet: { id: 'cs-1', drafts: [{ id: DRAFT_ID }] },
    });

    await service.publishDraft(DRAFT_ID);

    const changeSetUpdate = tx.changeSet.update.mock.calls[0][0];
    expect(changeSetUpdate.where).toEqual({ id: 'cs-1' });
    expect(changeSetUpdate.data.status).toBe('published');
    // 发布事务号是"这次跨文档发布是一件事"的持久化证据
    expect(typeof changeSetUpdate.data.publishTransactionId).toBe('string');
    expect(tx.changeSetItem.updateMany).toHaveBeenCalledWith({
      where: { changeSetId: 'cs-1' },
      data: { status: 'published' },
    });
  });

  it('内容与当前正式版本相同时不另建版本', async () => {
    const encoded = canonicalJson(componentContent());
    const { service, tx } = buildPublishHarness({
      baseVersion: {
        id: BASE_VERSION_ID,
        content: encoded,
        contentHash: contentHash(encoded),
      },
    });

    const version = await service.publishDraft(DRAFT_ID);

    expect(tx.designVersion.create).not.toHaveBeenCalled();
    expect(version).toEqual({ id: BASE_VERSION_ID, versionNumber: 1 });
    expect(tx.designDocument.updateMany).toHaveBeenCalledWith({
      where: { id: DOCUMENT_ID, currentPublishedVersionId: BASE_VERSION_ID },
      data: { status: 'published' },
    });
    expect(tx.candidateProposal.update).toHaveBeenCalledWith({
      where: { id: CANDIDATE_ID },
      data: { status: 'published' },
    });
  });

  it('多文档 ChangeSet 不会因单个草稿发布而被标记完成', async () => {
    const { service, tx } = buildPublishHarness({
      changeSet: { id: 'cs-1', drafts: [{ id: DRAFT_ID }, { id: 'other' }] },
    });

    await service.publishDraft(DRAFT_ID);

    expect(tx.changeSet.update).not.toHaveBeenCalled();
  });
});

describe('DesignService.restoreVersion', () => {
  const CURRENT_VERSION_ID = '7e0c21c4-44f1-4e53-8daa-ff796d722049';
  const TARGET_VERSION_ID = '8e0c21c4-44f1-4e53-8daa-ff796d722049';

  function buildRestoreHarness(overrides: Record<string, unknown> = {}) {
    const tx = {
      designVersion: {
        aggregate: vi.fn().mockResolvedValue({ _max: { versionNumber: 7 } }),
        create: vi
          .fn()
          .mockResolvedValue({ id: '9e0c21c4-44f1-4e53-8daa-ff796d722049', versionNumber: 8 }),
        findFirst: vi.fn().mockResolvedValue({ id: '3e0c21c4-44f1-4e53-8daa-ff796d722049' }),
      },
      designDocument: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      designDependency: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };

    const prisma = {
      designDocument: {
        findUnique: vi.fn().mockResolvedValue({
          id: DOCUMENT_ID,
          currentPublishedVersionId: CURRENT_VERSION_ID,
          ...(overrides.document as Record<string, unknown> | undefined),
        }),
      },
      designVersion: {
        findFirst: vi.fn().mockResolvedValue({
          id: TARGET_VERSION_ID,
          documentId: DOCUMENT_ID,
          versionNumber: 2,
          content: '{"schemaVersion":"aurum.component.v2"}',
          contentHash: 'hash-of-v2',
          ...(overrides.targetVersion as Record<string, unknown> | undefined),
        }),
      },
      $transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(tx)),
    };

    const service = new DesignPublishService(
      prisma as never,
      new DesignDocumentService(prisma as never),
      { assertAvailable: vi.fn().mockResolvedValue(undefined) } as never,
    );
    return { service, prisma, tx };
  }

  it('文档不存在或尚未发布时抛 NotFound', async () => {
    const { service } = buildRestoreHarness({ document: { currentPublishedVersionId: null } });

    await expect(service.restoreVersion(DOCUMENT_ID, TARGET_VERSION_ID)).rejects.toThrow(
      '不存在或尚未发布',
    );
  });

  it('目标版本不属于该文档或未发布时抛 NotFound', async () => {
    const { service, prisma } = buildRestoreHarness();
    prisma.designVersion.findFirst.mockResolvedValue(null);

    await expect(service.restoreVersion(DOCUMENT_ID, TARGET_VERSION_ID)).rejects.toThrow(
      '不是该文档的正式版本',
    );
  });

  it('只认可已发布的版本，草稿版本不能拿来恢复', async () => {
    const { service, prisma } = buildRestoreHarness();

    await service.restoreVersion(DOCUMENT_ID, TARGET_VERSION_ID);

    expect(prisma.designVersion.findFirst).toHaveBeenCalledWith({
      where: { id: TARGET_VERSION_ID, documentId: DOCUMENT_ID, publishedAt: { not: null } },
    });
  });

  it('恢复当前版本时拒绝，不做无意义的版本记录', async () => {
    const { service, tx } = buildRestoreHarness({
      targetVersion: { id: CURRENT_VERSION_ID },
    });

    await expect(service.restoreVersion(DOCUMENT_ID, CURRENT_VERSION_ID)).rejects.toThrow(
      '当前已经是该版本',
    );
    expect(tx.designVersion.create).not.toHaveBeenCalled();
  });

  it('乐观并发：正式版本被改走时抛 Conflict', async () => {
    const { service, tx } = buildRestoreHarness();
    tx.designDocument.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.restoreVersion(DOCUMENT_ID, TARGET_VERSION_ID)).rejects.toThrow(
      '正式版本已变化',
    );
  });

  it('恢复产生新版本而非改写历史：changeKind 为 restore 并记录来源', async () => {
    const { service, tx } = buildRestoreHarness();

    await service.restoreVersion(DOCUMENT_ID, TARGET_VERSION_ID);

    const created = tx.designVersion.create.mock.calls[0][0].data;
    expect(created.versionNumber).toBe(8);
    expect(created.changeKind).toBe('restore');
    expect(created.restoredFromVersionId).toBe(TARGET_VERSION_ID);
    expect(created.baseVersionId).toBe(CURRENT_VERSION_ID);
    // 内容原样复制自被恢复的版本，不能重新生成
    expect(created.content).toBe('{"schemaVersion":"aurum.component.v2"}');
    expect(created.contentHash).toBe('hash-of-v2');
    expect(created.summary).toContain('v2');
  });

  it('恢复同样用条件更新认领版本', async () => {
    const { service, tx } = buildRestoreHarness();

    await service.restoreVersion(DOCUMENT_ID, TARGET_VERSION_ID);

    expect(tx.designDocument.updateMany).toHaveBeenCalledWith({
      where: { id: DOCUMENT_ID, currentPublishedVersionId: CURRENT_VERSION_ID },
      data: { currentPublishedVersionId: '9e0c21c4-44f1-4e53-8daa-ff796d722049' },
    });
  });
});

/**
 * 跨文档变更集合。
 *
 * ChangeSet 存在的唯一理由是「主题、组件、布局必须一起发布」——所以这里的测试
 * 全部围绕两件事：**能不能拦住不该发布的**，以及**失败时是不是整体回滚**。
 */
describe('DesignPublishService.createChangeSet', () => {
  const DOC_A = '0e0c21c4-44f1-4e53-8daa-ff796d722049';
  const DOC_B = '1e0c21c4-44f1-4e53-8daa-ff796d722049';
  const VER_A = '2e0c21c4-44f1-4e53-8daa-ff796d722049';
  const VER_B = '3e0c21c4-44f1-4e53-8daa-ff796d722049';
  const DRAFT_A = '4e0c21c4-44f1-4e53-8daa-ff796d722049';
  const DRAFT_B = '5e0c21c4-44f1-4e53-8daa-ff796d722049';

  function draft(id: string, documentId: string, versionId: string) {
    return {
      id,
      documentId,
      baseVersionId: versionId,
      status: 'ready',
      document: { id: documentId, currentPublishedVersionId: versionId },
      candidates: [
        {
          id: `cand-${id}`,
          patch: serializedPatch(componentContent()),
          validationRuns: [{ status: 'succeeded' }],
        },
      ],
    };
  }

  function build(drafts: unknown[], memberships: unknown[] = []) {
    const tx = {
      changeSet: {
        upsert: vi.fn().mockResolvedValue({ id: 'cs-1' }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'cs-1', drafts: [], items: [] }),
      },
      changeSetDraft: { deleteMany: vi.fn(), create: vi.fn() },
      changeSetItem: { deleteMany: vi.fn(), create: vi.fn() },
    };
    const prisma = {
      designDraft: { findMany: vi.fn().mockResolvedValue(drafts) },
      changeSetDraft: { findMany: vi.fn().mockResolvedValue(memberships) },
      $transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(tx)),
    };
    const service = new DesignPublishService(
      prisma as never,
      new DesignDocumentService(prisma as never),
      { assertAvailable: vi.fn().mockResolvedValue(undefined) } as never,
    );
    return { service, prisma, tx };
  }

  it('少于两个草稿时拒绝——单文档走草稿发布接口', async () => {
    const { service } = build([]);

    await expect(service.createChangeSet([DRAFT_A])).rejects.toThrow('至少需要两个草稿');
  });

  it('去重后不足两个也拒绝', async () => {
    const { service } = build([]);

    await expect(service.createChangeSet([DRAFT_A, DRAFT_A])).rejects.toThrow('至少需要两个草稿');
  });

  it('有草稿不存在时拒绝', async () => {
    const { service } = build([draft(DRAFT_A, DOC_A, VER_A)]);

    await expect(service.createChangeSet([DRAFT_A, DRAFT_B])).rejects.toThrow('至少一个草稿不存在');
  });

  it('同一文档的两个草稿不能进同一个 ChangeSet', async () => {
    const { service } = build([draft(DRAFT_A, DOC_A, VER_A), draft(DRAFT_B, DOC_A, VER_A)]);

    await expect(service.createChangeSet([DRAFT_A, DRAFT_B])).rejects.toThrow(
      '不能包含同一设计文档的多个草稿',
    );
  });

  it('草稿基准版本已过期时拒绝组装', async () => {
    const stale = draft(DRAFT_A, DOC_A, VER_A);
    stale.document.currentPublishedVersionId = 'ae0c21c4-44f1-4e53-8daa-ff796d722049';
    const { service } = build([stale, draft(DRAFT_B, DOC_B, VER_B)]);

    await expect(service.createChangeSet([DRAFT_A, DRAFT_B])).rejects.toThrow(
      '尚未准备好或基准版本已过期',
    );
  });

  it('草稿没有已校验的候选方案时拒绝', async () => {
    const noCandidate = draft(DRAFT_A, DOC_A, VER_A);
    noCandidate.candidates[0].validationRuns = [{ status: 'failed' }];
    const { service } = build([noCandidate, draft(DRAFT_B, DOC_B, VER_B)]);

    await expect(service.createChangeSet([DRAFT_A, DRAFT_B])).rejects.toThrow(
      '没有已校验且被选择的候选方案',
    );
  });

  it('草稿已属于其他 ChangeSet 时拒绝重复组装', async () => {
    const { service } = build(
      [draft(DRAFT_A, DOC_A, VER_A), draft(DRAFT_B, DOC_B, VER_B)],
      [{ draftId: DRAFT_A, changeSet: { draftId: 'someone-else', status: 'ready' } }],
    );

    await expect(service.createChangeSet([DRAFT_A, DRAFT_B])).rejects.toThrow(
      '已经属于其他 ChangeSet',
    );
  });

  it('组装成功：重建条目并冻结候选 Patch', async () => {
    const a = draft(DRAFT_A, DOC_A, VER_A);
    const b = draft(DRAFT_B, DOC_B, VER_B);
    const { service, tx } = build([a, b]);

    await service.createChangeSet([DRAFT_A, DRAFT_B]);

    // 先清空再重建，避免残留上一次组装的条目
    expect(tx.changeSetDraft.deleteMany).toHaveBeenCalledWith({ where: { changeSetId: 'cs-1' } });
    expect(tx.changeSetItem.deleteMany).toHaveBeenCalledWith({ where: { changeSetId: 'cs-1' } });
    expect(tx.changeSetItem.create).toHaveBeenCalledTimes(2);
    const firstItem = tx.changeSetItem.create.mock.calls[0][0].data;
    expect(firstItem.documentId).toBe(DOC_A);
    expect(firstItem.baseVersionId).toBe(VER_A);
    // 冻结 Patch：发布时用的是组装那一刻的候选，不受之后草稿变化影响
    expect(firstItem.selectedPatch).toBe(a.candidates[0].patch);
  });
});

describe('DesignPublishService.publishChangeSet', () => {
  const DOC_A = '0e0c21c4-44f1-4e53-8daa-ff796d722049';
  const DOC_B = '1e0c21c4-44f1-4e53-8daa-ff796d722049';
  const VER_A = '2e0c21c4-44f1-4e53-8daa-ff796d722049';
  const VER_B = '3e0c21c4-44f1-4e53-8daa-ff796d722049';
  const DRAFT_A = '4e0c21c4-44f1-4e53-8daa-ff796d722049';
  const DRAFT_B = '5e0c21c4-44f1-4e53-8daa-ff796d722049';
  const CAND_A = '6e0c21c4-44f1-4e53-8daa-ff796d722049';
  const CAND_B = '7e0c21c4-44f1-4e53-8daa-ff796d722049';

  function member(draftId: string, documentId: string, versionId: string, candidateId: string) {
    return {
      draft: {
        id: draftId,
        documentId,
        baseVersionId: versionId,
        status: 'ready',
        document: { id: documentId, kind: 'component', currentPublishedVersionId: versionId },
      },
      item: {
        documentId,
        candidateId,
        selectedPatch: serializedPatch(componentContent()),
        candidate: {
          id: candidateId,
          label: '方案 A',
          rationale: '',
          status: 'selected',
          validationRuns: [{ status: 'succeeded' }],
        },
      },
    };
  }

  function build(members: ReturnType<typeof member>[], overrides: Record<string, unknown> = {}) {
    const tx = {
      designVersion: {
        aggregate: vi.fn().mockResolvedValue({ _max: { versionNumber: 2 } }),
        create: vi
          .fn()
          .mockImplementation(({ data }: { data: { documentId: string } }) =>
            Promise.resolve({ id: `new-${data.documentId}` }),
          ),
        findFirst: vi.fn().mockResolvedValue({ id: 'theme-ver' }),
      },
      designDocument: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      candidateProposal: { update: vi.fn() },
      designDraft: { update: vi.fn() },
      designDependency: { createMany: vi.fn() },
      changeSetItem: { updateMany: vi.fn() },
      changeSet: {
        update: vi.fn().mockResolvedValue({ id: 'cs-1', status: 'published' }),
      },
    };
    const prisma = {
      changeSet: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'cs-1',
          status: 'ready',
          drafts: members.map((m) => ({ draft: m.draft })),
          items: members.map((m) => m.item),
          ...overrides,
        }),
      },
      $transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(tx)),
    };
    const media = { assertAvailable: vi.fn().mockResolvedValue(undefined) };
    const service = new DesignPublishService(
      prisma as never,
      new DesignDocumentService(prisma as never),
      media as never,
    );
    return { service, prisma, tx, media };
  }

  const twoMembers = () => [
    member(DRAFT_A, DOC_A, VER_A, CAND_A),
    member(DRAFT_B, DOC_B, VER_B, CAND_B),
  ];

  it('ChangeSet 不存在时抛 NotFound', async () => {
    const { service, prisma } = build([]);
    prisma.changeSet.findUnique.mockResolvedValue(null);

    await expect(service.publishChangeSet('cs-1')).rejects.toThrow('不存在');
  });

  it('已发布的 ChangeSet 幂等返回，不重复建版本', async () => {
    const { service, tx } = build(twoMembers(), { status: 'published' });

    await service.publishChangeSet('cs-1');

    expect(tx.designVersion.create).not.toHaveBeenCalled();
  });

  it('单文档 ChangeSet 被拒绝，避免两条发布路径语义重叠', async () => {
    const { service } = build([member(DRAFT_A, DOC_A, VER_A, CAND_A)]);

    await expect(service.publishChangeSet('cs-1')).rejects.toThrow('单文档草稿请使用草稿发布接口');
  });

  it('条目数与成员数不符时拒绝发布', async () => {
    const members = twoMembers();
    const { service, prisma } = build(members);
    prisma.changeSet.findUnique.mockResolvedValue({
      id: 'cs-1',
      status: 'ready',
      drafts: members.map((m) => ({ draft: m.draft })),
      items: [members[0].item],
    });

    await expect(service.publishChangeSet('cs-1')).rejects.toThrow('条目不完整');
  });

  it('成员草稿过期或候选未校验时拒绝', async () => {
    const members = twoMembers();
    members[1].item.candidate.validationRuns = [{ status: 'failed' }];
    const { service } = build(members);

    await expect(service.publishChangeSet('cs-1')).rejects.toThrow('已过期或未校验');
  });

  it('任一文档的版本指针被并发改动时整体取消', async () => {
    const { service, tx } = build(twoMembers());
    // 第一个文档成功认领，第二个失败
    tx.designDocument.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(service.publishChangeSet('cs-1')).rejects.toThrow('已整体取消');
  });

  it('发布前校验每个成员的素材，缺失时整体拒绝且不建版本', async () => {
    const { service, media, tx } = build(twoMembers());
    media.assertAvailable.mockRejectedValueOnce(new Error('素材不可用'));

    await expect(service.publishChangeSet('cs-1')).rejects.toThrow('素材不可用');
    expect(tx.designVersion.create).not.toHaveBeenCalled();
  });

  it('成功发布：为每个文档建版本、认领指针、写发布事务号', async () => {
    const { service, tx } = build(twoMembers());

    await service.publishChangeSet('cs-1');

    expect(tx.designVersion.create).toHaveBeenCalledTimes(2);
    expect(tx.designDocument.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.designDocument.updateMany).toHaveBeenCalledWith({
      where: { id: DOC_A, currentPublishedVersionId: VER_A },
      data: { currentPublishedVersionId: `new-${DOC_A}`, status: 'published' },
    });
    expect(tx.candidateProposal.update).toHaveBeenCalledTimes(2);
    expect(tx.designDraft.update).toHaveBeenCalledTimes(2);

    const update = tx.changeSet.update.mock.calls[0][0];
    expect(update.data.status).toBe('published');
    expect(typeof update.data.publishTransactionId).toBe('string');
  });
});
