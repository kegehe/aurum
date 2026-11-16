import { describe, expect, it, vi } from 'vitest';
import { DesignStudioService } from './design-studio.service';

function makeService() {
  const prisma = {
    candidateProposal: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    designDraftSnapshot: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    designDraft: {
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    designDraftFile: {
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    studioMessage: { create: vi.fn(), updateMany: vi.fn() },
    changeSession: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
  };
  const assets = { get: vi.fn() };
  const agent = { streamAssetPatch: vi.fn(), generateAssetPatch: vi.fn() };
  const preview = { compile: vi.fn().mockResolvedValue({}) };
  return {
    prisma,
    assets,
    agent,
    preview,
    service: new DesignStudioService(
      prisma as never,
      assets as never,
      agent as never,
      preview as never,
    ),
  };
}

describe('DesignStudioService', () => {
  it('rejects applying a candidate after the draft changed', async () => {
    const { service, prisma } = makeService();
    prisma.candidateProposal.findUnique.mockResolvedValue({
      id: 'c1',
      status: 'planned',
      draftId: 'd1',
      createdAt: new Date('2026-01-02T00:00:00Z'),
      patch: '{"operations":[]}',
      draft: { id: 'd1', sessionId: 's1', draftRevision: 1, files: [] },
    });
    prisma.designDraftSnapshot.findFirst.mockResolvedValue({
      createdAt: new Date('2026-01-03T00:00:00Z'),
    });

    await expect(service.applyCandidate('c1')).rejects.toThrow(/草稿已经变化/);
  });

  it('retries only when a user message exists', async () => {
    const { service, prisma } = makeService();
    prisma.changeSession.findUnique.mockResolvedValue({
      id: 's1',
      documentId: 'doc-1',
      messages: [],
      drafts: [
        {
          id: 'd1',
          sessionId: 's1',
          baseVersionId: 'v1',
          draftRevision: 1,
          files: [],
          candidates: [],
        },
      ],
    });
    const send = vi.fn();
    await service.retryMessage('s1', send);

    expect(send).toHaveBeenCalledWith('error', {
      message: '还没有可重试的用户消息',
    });
    expect(prisma.studioMessage.create).not.toHaveBeenCalled();
  });

  it('undo pops the newest snapshot instead of stacking a redo state', async () => {
    const { service, prisma, assets, preview } = makeService();
    const session = {
      id: 's1',
      title: '会话',
      status: 'editing',
      createdAt: new Date(),
      updatedAt: new Date(),
      documentId: 'doc-1',
      messages: [],
      drafts: [
        {
          id: 'd1',
          sessionId: 's1',
          baseVersionId: 'v1',
          draftRevision: 3,
          status: 'editing',
          files: [
            {
              path: 'card.tsx',
              target: null,
              type: 'registry:ui',
              language: 'tsx',
              content: 'B',
            },
          ],
          candidates: [],
        },
      ],
    };
    prisma.changeSession.findUnique.mockResolvedValue(session);
    assets.get.mockResolvedValue({ id: 'doc-1', manifest: {} });
    prisma.designDraftSnapshot.findMany.mockResolvedValue([
      {
        id: 'snap-3',
        revision: 3,
        manifest: '{}',
        files: JSON.stringify(session.drafts[0].files),
      },
      {
        id: 'snap-2',
        revision: 2,
        manifest: '{}',
        files: JSON.stringify([{ ...session.drafts[0].files[0], content: 'A' }]),
      },
    ]);
    prisma.candidateProposal.findFirst.mockResolvedValue(null);

    await service.undoSession('s1');

    // 被撤销的那一版被弹出，版本号退回上一版；不能再写一版同内容快照。
    expect(prisma.designDraftSnapshot.deleteMany).toHaveBeenCalledWith({
      where: { draftId: 'd1', revision: 3 },
    });
    expect(prisma.designDraftSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.designDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', draftRevision: 3 },
      data: { draftRevision: 2, lockVersion: { increment: 1 } },
    });
    expect(prisma.designDraftFile.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ draftId: 'd1', path: 'card.tsx', content: 'A' })],
    });
    expect(preview.compile).toHaveBeenCalled();
  });

  it('undo keeps walking backwards on the next call', async () => {
    const { service, prisma, assets } = makeService();
    const session = {
      id: 's1',
      title: '会话',
      status: 'editing',
      createdAt: new Date(),
      updatedAt: new Date(),
      documentId: 'doc-1',
      messages: [],
      drafts: [
        {
          id: 'd1',
          sessionId: 's1',
          baseVersionId: 'v1',
          draftRevision: 2,
          status: 'editing',
          files: [
            {
              path: 'card.tsx',
              target: null,
              type: 'registry:ui',
              language: 'tsx',
              content: 'A',
            },
          ],
          candidates: [],
        },
      ],
    };
    prisma.changeSession.findUnique.mockResolvedValue(session);
    assets.get.mockResolvedValue({ id: 'doc-1', manifest: {} });
    // 第一次撤销后的快照序列：rev2 是当前状态，rev1 是再上一版。
    prisma.designDraftSnapshot.findMany.mockResolvedValue([
      {
        id: 'snap-2',
        revision: 2,
        manifest: '{}',
        files: JSON.stringify(session.drafts[0].files),
      },
      {
        id: 'snap-1',
        revision: 1,
        manifest: '{}',
        files: JSON.stringify([{ ...session.drafts[0].files[0], content: 'initial' }]),
      },
    ]);
    prisma.candidateProposal.findFirst.mockResolvedValue(null);

    await service.undoSession('s1');

    // 第二次撤销恢复的是 rev1，而不是把 rev2 的内容再套一遍。
    expect(prisma.designDraftFile.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ path: 'card.tsx', content: 'initial' })],
    });
    expect(prisma.designDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', draftRevision: 2 },
      data: { draftRevision: 1, lockVersion: { increment: 1 } },
    });
  });

  it('undo aborts when the draft changed after snapshots were read', async () => {
    const { service, prisma, assets } = makeService();
    const file = {
      path: 'card.tsx',
      target: null,
      type: 'registry:ui',
      language: 'tsx',
      content: 'A',
    };
    prisma.changeSession.findUnique.mockResolvedValue({
      id: 's1',
      title: '会话',
      status: 'editing',
      createdAt: new Date(),
      updatedAt: new Date(),
      documentId: 'doc-1',
      messages: [],
      drafts: [
        {
          id: 'd1',
          sessionId: 's1',
          baseVersionId: 'v1',
          draftRevision: 3,
          status: 'editing',
          files: [file],
          candidates: [],
        },
      ],
    });
    assets.get.mockResolvedValue({ id: 'doc-1', manifest: {} });
    prisma.designDraftSnapshot.findMany.mockResolvedValue([
      { id: 'snap-3', revision: 3, manifest: '{}', files: JSON.stringify([file]) },
      { id: 'snap-2', revision: 2, manifest: '{}', files: JSON.stringify([file]) },
    ]);
    // 事务内发现 draftRevision 已被并发修改（不再是 3）
    prisma.designDraft.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.undoSession('s1')).rejects.toThrow('草稿已发生变化');
    expect(prisma.designDraftSnapshot.deleteMany).not.toHaveBeenCalled();
  });
});
