import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AI_REPAIR_ATTEMPTS } from './design-agent.service';
import { canonicalJson, contentHash, getCandidateContent } from './design-content';
import { DesignService } from './design.service';

function createMediaStub() {
  return {
    describe: vi.fn(),
    resolveContent: vi.fn().mockResolvedValue(null),
    assertAvailable: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * AI 输出的修复重试。
 *
 * 守的是"整批判死"这个缺口：模型少写一个合法颜色，曾经让这一批候选全部丢失，
 * 运营看到的是"设计任务失败"而不是"这一个方案没做出来"。
 */
describe('DesignService.createCandidateWithRepair', () => {
  type Outcome = { id: string } | { error: string };

  function build(agent: unknown) {
    const service = new DesignService(
      {} as never,
      agent as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      createMediaStub() as never,
    );
    const internals = service as never as {
      createCandidate: ReturnType<typeof vi.fn>;
      assertTaskLease: ReturnType<typeof vi.fn>;
      createCandidateWithRepair(args: Record<string, unknown>): Promise<Outcome>;
    };
    internals.createCandidate = vi.fn();
    internals.assertTaskLease = vi.fn().mockResolvedValue(undefined);
    return internals;
  }

  const args = {
    draftId: 'draft-1',
    taskId: 'task-1',
    leaseToken: 'lease-1',
    kind: 'component',
    baseContent: { schemaVersion: 'aurum.component.v2' },
    label: 'AI 方案 1',
    rationale: '理由',
    content: { schemaVersion: 'aurum.component.v2', variants: {} },
    generationKey: 'task-1:0',
  };
  const repaired = { schemaVersion: 'aurum.component.v2', variants: { default: {} } };

  it('recovers when a repair round produces a legal candidate', async () => {
    const repairCandidate = vi.fn().mockResolvedValue(repaired);
    const internals = build({ repairCandidate });
    internals.createCandidate
      .mockRejectedValueOnce(new BadRequestException('背景色不合法'))
      .mockResolvedValueOnce({ id: 'candidate-1' });

    await expect(internals.createCandidateWithRepair(args)).resolves.toEqual({ id: 'candidate-1' });
    expect(repairCandidate).toHaveBeenCalledTimes(1);
    expect(repairCandidate.mock.calls[0][0].error).toBe('背景色不合法');
    // 第二次提交的必须是修好的内容，而不是原样重试
    expect(internals.createCandidate.mock.calls[1][1].content).toEqual(repaired);
  });

  it('gives up after the repair budget and reports the last error', async () => {
    const repairCandidate = vi.fn().mockResolvedValue(repaired);
    const internals = build({ repairCandidate });
    internals.createCandidate.mockRejectedValue(new BadRequestException('仍然不合法'));

    await expect(internals.createCandidateWithRepair(args)).resolves.toEqual({
      error: '仍然不合法',
    });
    expect(internals.createCandidate).toHaveBeenCalledTimes(AI_REPAIR_ATTEMPTS + 1);
    expect(repairCandidate).toHaveBeenCalledTimes(AI_REPAIR_ATTEMPTS);
  });

  it('does not spend an AI call on errors the model cannot fix', async () => {
    const repairCandidate = vi.fn();
    const internals = build({ repairCandidate });
    internals.createCandidate.mockRejectedValue(new ConflictException('任务已取消'));

    await expect(internals.createCandidateWithRepair(args)).rejects.toThrow('任务已取消');
    expect(repairCandidate).not.toHaveBeenCalled();
  });

  it('still reports the schema error when the repair call itself fails', async () => {
    const repairCandidate = vi.fn().mockRejectedValue(new ServiceUnavailableException('AI 未配置'));
    const internals = build({ repairCandidate });
    internals.createCandidate.mockRejectedValue(new BadRequestException('背景色不合法'));

    await expect(internals.createCandidateWithRepair(args)).resolves.toEqual({
      error: '背景色不合法',
    });
    // 修复调用失败不该把候选变成"另一个错误"，运营要看到真正的失败原因
    expect(repairCandidate).toHaveBeenCalledTimes(1);
  });
});

/**
 * 一键保存并发布。
 *
 * 核心主张：门禁在写库**之前**跑完，不通过就一个字都不写——"发布门禁必须全部
 * 通过"因此是结构性保证，而不是靠事后回滚。
 */
describe('DesignService.composeAndPublish', () => {
  const DOCUMENT_ID = '0e0c21c4-44f1-4e53-8daa-ff796d722049';
  const VERSION_ID = '1e0c21c4-44f1-4e53-8daa-ff796d722049';

  const THEME_VERSION = {
    id: VERSION_ID,
    documentId: DOCUMENT_ID,
    content: JSON.stringify({
      tokenSchemaVersion: 'aurum.tokens.v1',
      tokens: { color: { primary: { $type: 'color', $value: '#1f6feb' } } },
    }),
  };

  function build() {
    const prisma = {
      designDocument: {
        findUnique: vi.fn().mockResolvedValue({
          id: DOCUMENT_ID,
          currentPublishedVersion: { id: VERSION_ID },
        }),
        create: vi.fn(),
      },
      designVersion: { findMany: vi.fn().mockResolvedValue([THEME_VERSION]) },
      $transaction: vi.fn(),
    };
    const service = new DesignService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      createMediaStub() as never,
    );
    const internals = service as never as {
      createDocument: ReturnType<typeof vi.fn>;
      createDraft: ReturnType<typeof vi.fn>;
      createCandidate: ReturnType<typeof vi.fn>;
      renderAndValidateCandidate: ReturnType<typeof vi.fn>;
    };
    internals.createDocument = vi.fn().mockResolvedValue({
      id: 'doc-1',
      currentPublishedVersionId: 'ver-1',
    });
    internals.createDraft = vi.fn().mockResolvedValue({ id: 'draft-1' });
    internals.createCandidate = vi.fn().mockResolvedValue({ id: 'candidate-1' });
    internals.renderAndValidateCandidate = vi.fn().mockResolvedValue({ id: 'task-1' });
    return { service, prisma, internals };
  }

  function content(declarations: Record<string, string>) {
    return {
      schemaVersion: 'aurum.component.v2',
      componentType: 'glass-card',
      appliesTo: 'container',
      dependencies: [{ documentId: DOCUMENT_ID, versionId: VERSION_ID }],
      variants: { default: { declarations } },
    };
  }

  const input = {
    name: '毛玻璃卡片',
    slug: 'glass-card',
    kind: 'component' as const,
    content: content({ color: '#0f172a', 'background-color': '#ffffff' }),
  };

  it('chains document → draft → candidate → auto-publishing render', async () => {
    const { service, internals } = build();

    const result = await service.composeAndPublish(input);

    expect(result).toMatchObject({ published: true, documentId: 'doc-1', taskId: 'task-1' });
    // 渲染任务必须带上 autoPublish，否则 Worker 只渲染不发布，用户点了保存却什么都没上线
    expect(internals.renderAndValidateCandidate).toHaveBeenCalledWith('candidate-1', {
      autoPublish: true,
    });
  });

  it('pins the theme version the operator picked', async () => {
    const { service, internals, prisma } = build();
    const withoutDependencies = content({ 'background-color': '{color.primary}' });
    delete (withoutDependencies as Record<string, unknown>).dependencies;

    await service.composeAndPublish({
      ...input,
      content: withoutDependencies,
      themeDocumentId: DOCUMENT_ID,
    });

    // 外行只说"用哪套配色"，钉版本由服务端补上——没补的话组件 v2 会校验失败
    expect(prisma.designDocument.findUnique).toHaveBeenCalled();
    expect(internals.createDocument.mock.calls[0][0].content.dependencies).toEqual([
      { documentId: DOCUMENT_ID, versionId: VERSION_ID },
    ]);
  });

  it('writes nothing at all when the contrast gate rejects the content', async () => {
    const { service, prisma, internals } = build();

    const result = await service.composeAndPublish({
      ...input,
      // 白底白字：结构完全合法，只有门禁能拦下它
      content: content({ color: '#ffffff', 'background-color': '#ffffff' }),
    });

    expect(result.published).toBe(false);
    expect('gate' in result && result.gate.errors.join()).toContain('对比度');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.designDocument.create).not.toHaveBeenCalled();
    expect(internals.createDocument).not.toHaveBeenCalled();
    // 失败原因要带上实测比值，否则"帮我修好"没有依据
    expect(
      'gate' in result && result.gate.contrasts.length + result.gate.errors.length,
    ).toBeGreaterThan(0);
  });
});

describe('DesignService candidate snapshots', () => {
  it('copies rendered snapshots onto the published version without removing the candidate copies', async () => {
    const prisma = {
      previewSnapshot: {
        findMany: vi.fn().mockResolvedValue([
          {
            viewport: 'desktop',
            state: 'default',
            kind: 'full',
            format: 'png',
            width: 1440,
            height: 960,
            browser: 'chromium',
            fixtureVersion: 'fixture',
            artifactHash: 'abc',
            storagePath: 'covers/button.png',
          },
        ]),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'snap-1' }),
        update: vi.fn(),
      },
    };
    const service = new DesignService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await (
      service as unknown as {
        copyCandidateSnapshotsToVersion: (candidateId: string, versionId: string) => Promise<void>;
      }
    ).copyCandidateSnapshotsToVersion('candidate-1', 'version-1');

    expect(prisma.previewSnapshot.findMany).toHaveBeenCalledWith({
      where: { candidateId: 'candidate-1' },
    });
    expect(prisma.previewSnapshot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        versionId: 'version-1',
        viewport: 'desktop',
        storagePath: 'covers/button.png',
      }),
    });
    expect(prisma.previewSnapshot.update).not.toHaveBeenCalled();
  });
});

/**
 * 一键发布的收尾。
 *
 * 守的是失败恢复：选择候选之后任何一步失败，重试都必须能继续，而不是卡在
 * 「候选已 selected，selectCandidate 只接受 validated」的死循环里；封面复制
 * 失败也不能把已经上线的版本改写成发布失败。
 */
describe('DesignService.finishAutoPublish', () => {
  function build(
    candidate: {
      status: string;
      draft: { status: string; documentId?: string; baseVersionId?: string };
    } | null,
  ) {
    const state = candidate
      ? {
          ...candidate,
          draft: {
            documentId: 'doc-1',
            baseVersionId: 'version-1',
            ...candidate.draft,
          },
        }
      : null;
    const prisma = {
      candidateProposal: { findUnique: vi.fn().mockResolvedValue(state) },
      designTask: {
        update: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue({ id: 'task-1', status: 'succeeded' }),
      },
    };
    const internals = new DesignService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      createMediaStub() as never,
    ) as unknown as {
      selectCandidate: ReturnType<typeof vi.fn>;
      publishDraft: ReturnType<typeof vi.fn>;
      copyCandidateSnapshotsToVersion: ReturnType<typeof vi.fn>;
      resolvePublishedVersionId: ReturnType<typeof vi.fn>;
      finishAutoPublish(
        taskId: string,
        candidateId: string,
        draftId: string,
        gatePassed: boolean,
        validation: unknown,
      ): Promise<unknown>;
    };
    internals.selectCandidate = vi.fn().mockResolvedValue({});
    internals.publishDraft = vi.fn().mockResolvedValue({ id: 'version-2', versionNumber: 2 });
    internals.copyCandidateSnapshotsToVersion = vi.fn().mockResolvedValue(undefined);
    internals.resolvePublishedVersionId = vi.fn().mockResolvedValue('version-3');
    return { service: internals, prisma };
  }

  const publishArgs = ['task-1', 'candidate-1', 'draft-1', true, {}] as const;

  it('resumes a retry that already selected the candidate', async () => {
    const { service, prisma } = build({ status: 'selected', draft: { status: 'ready' } });

    await service.finishAutoPublish(...publishArgs);

    // 重试时不能再调 selectCandidate：它只接受 validated，会永久失败
    expect(service.selectCandidate).not.toHaveBeenCalled();
    expect(service.publishDraft).toHaveBeenCalledWith('draft-1');
    expect(service.copyCandidateSnapshotsToVersion).toHaveBeenCalledWith(
      'candidate-1',
      'version-2',
    );
    expect(prisma.designTask.update).not.toHaveBeenCalled();
  });

  it('does not reselect when the draft is already published', async () => {
    const { service } = build({ status: 'published', draft: { status: 'published' } });

    await service.finishAutoPublish(...publishArgs);

    expect(service.selectCandidate).not.toHaveBeenCalled();
    expect(service.publishDraft).not.toHaveBeenCalled();
    // 幂等分支返回的是「文档当前版本」，期间可能已被别的发布推进；
    // 必须按候选内容哈希定位它自己发布出的版本，否则会把旧封面盖到新版本上
    expect(service.resolvePublishedVersionId).toHaveBeenCalledWith(
      'candidate-1',
      'doc-1',
      'version-1',
    );
    expect(service.copyCandidateSnapshotsToVersion).toHaveBeenCalledWith(
      'candidate-1',
      'version-3',
    );
  });

  it('skips the cover copy when another candidate published the draft', async () => {
    const { service } = build({ status: 'validated', draft: { status: 'published' } });

    await service.finishAutoPublish(...publishArgs);

    // 草稿是别人的候选发布的，不能用本候选的封面覆盖
    expect(service.selectCandidate).not.toHaveBeenCalled();
    expect(service.publishDraft).not.toHaveBeenCalled();
    expect(service.copyCandidateSnapshotsToVersion).not.toHaveBeenCalled();
  });

  it('skips the cover copy when the draft is published concurrently during the retry', async () => {
    const { service } = build({ status: 'selected', draft: { status: 'ready' } });
    // 读状态时还是 ready，publishDraft 却命中了幂等分支 → 别的候选抢先发布
    service.publishDraft.mockResolvedValue({
      id: 'doc-1',
      currentPublishedVersionId: 'version-9',
    });

    await service.finishAutoPublish(...publishArgs);

    expect(service.copyCandidateSnapshotsToVersion).not.toHaveBeenCalled();
  });

  it('falls back to the base version when publishing adopted it without a new version', async () => {
    const { service } = build({ status: 'published', draft: { status: 'published' } });
    // 内容与基准一致时 adoptCurrentVersion 不新建版本，发布的仍是 baseVersion
    service.resolvePublishedVersionId.mockResolvedValue('version-1');

    await service.finishAutoPublish(...publishArgs);

    expect(service.copyCandidateSnapshotsToVersion).toHaveBeenCalledWith(
      'candidate-1',
      'version-1',
    );
  });

  it('skips the cover copy when no published version matches the candidate', async () => {
    const { service } = build({ status: 'published', draft: { status: 'published' } });
    // 内容哈希对不上任何版本（例如数据异常）→ 宁可跳过也不能覆盖错版本
    service.resolvePublishedVersionId.mockResolvedValue(null);

    await service.finishAutoPublish(...publishArgs);

    expect(service.copyCandidateSnapshotsToVersion).not.toHaveBeenCalled();
  });

  it('keeps the publish successful when the version cannot be resolved', async () => {
    const { service, prisma } = build({ status: 'published', draft: { status: 'published' } });
    service.resolvePublishedVersionId.mockRejectedValue(new Error('候选 Patch 已损坏'));

    await service.finishAutoPublish(...publishArgs);

    // 发布已经生效，解析失败只应跳过封面复制
    expect(prisma.designTask.update).not.toHaveBeenCalled();
    expect(service.copyCandidateSnapshotsToVersion).not.toHaveBeenCalled();
  });

  it('keeps the publish successful when the cover copy fails', async () => {
    const { service, prisma } = build({ status: 'validated', draft: { status: 'ready' } });
    service.copyCandidateSnapshotsToVersion.mockRejectedValue(new Error('P2002'));

    await service.finishAutoPublish(...publishArgs);

    // 版本已经上线，任务不能被改写成发布失败
    expect(prisma.designTask.update).not.toHaveBeenCalled();
    expect(prisma.designTask.findUnique).toHaveBeenCalledWith({ where: { id: 'task-1' } });
  });

  it('still marks the task failed when publication itself fails', async () => {
    const { service, prisma } = build({ status: 'validated', draft: { status: 'ready' } });
    service.publishDraft.mockRejectedValue(new Error('草稿基准版本已过期'));

    await service.finishAutoPublish(...publishArgs);

    expect(prisma.designTask.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: expect.objectContaining({
        status: 'failed',
        errorCode: 'DESIGN_PUBLISH_FAILED',
        errorMessage: '草稿基准版本已过期',
      }),
    });
    expect(service.copyCandidateSnapshotsToVersion).not.toHaveBeenCalled();
  });
});

/**
 * 重试时定位“本草稿发布出的版本”。
 *
 * 只用 baseVersionId 不够：adopt 不新建版本，之后基于同一基准的新草稿还会
 * 产出新版本。内容哈希是唯一能把候选和版本对上号的依据。
 */
describe('DesignService.resolvePublishedVersionId', () => {
  const patch = JSON.stringify({
    schema: 'aurum.domain-patch.v1',
    operations: [
      {
        op: 'replace_document_content',
        documentKind: 'component',
        value: {
          schemaVersion: 'aurum.component.v2',
          componentType: 'glass-card',
          variants: { default: { declarations: { color: '#1769aa' } } },
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
  const candidateHash = contentHash(canonicalJson(getCandidateContent(patch, 'component')));

  function build(baseHash: string, successor: { id: string } | null) {
    const prisma = {
      candidateProposal: {
        findUnique: vi.fn().mockResolvedValue({
          patch,
          draft: {
            document: { kind: 'component' },
            baseVersion: { contentHash: baseHash },
          },
        }),
      },
      designVersion: { findFirst: vi.fn().mockResolvedValue(successor) },
    };
    const service = new DesignService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      createMediaStub() as never,
    ) as unknown as {
      resolvePublishedVersionId(
        candidateId: string,
        documentId: string,
        baseVersionId: string,
      ): Promise<string | null>;
    };
    return { service, prisma };
  }

  it('returns the base version when publishing adopted the current content', async () => {
    const { service, prisma } = build(candidateHash, null);

    await expect(
      service.resolvePublishedVersionId('candidate-1', 'doc-1', 'version-1'),
    ).resolves.toBe('version-1');
    // adopt 不新建版本，按哈希匹配也不该去查后代
    expect(prisma.designVersion.findFirst).not.toHaveBeenCalled();
  });

  it('matches the successor by content hash, not just the base version', async () => {
    const { service, prisma } = build('different-hash', { id: 'version-2' });

    await expect(
      service.resolvePublishedVersionId('candidate-1', 'doc-1', 'version-1'),
    ).resolves.toBe('version-2');
    expect(prisma.designVersion.findFirst).toHaveBeenCalledWith({
      where: { documentId: 'doc-1', baseVersionId: 'version-1', contentHash: candidateHash },
      orderBy: { versionNumber: 'desc' },
      select: { id: true },
    });
  });

  it('returns null when no version matches the candidate content', async () => {
    const { service } = build('different-hash', null);

    await expect(
      service.resolvePublishedVersionId('candidate-1', 'doc-1', 'version-1'),
    ).resolves.toBeNull();
  });
});

describe('DesignService.selectCandidate', () => {
  it('rejects when the latest validation run failed even if an older one succeeded', async () => {
    const prisma = {
      candidateProposal: {
        findUnique: vi.fn().mockResolvedValue({
          status: 'validated',
          draft: {
            baseVersionId: 'version-1',
            document: { currentPublishedVersionId: 'version-1' },
          },
          // 查询已按 createdAt desc + take 1，这里模拟最新一条是 failed
          validationRuns: [{ status: 'failed' }],
        }),
      },
    };
    const service = new DesignService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      createMediaStub() as never,
    ) as unknown as {
      selectCandidate(candidateId: string): Promise<unknown>;
    };

    await expect(service.selectCandidate('candidate-1')).rejects.toThrow('最近一次校验未通过');
    expect(prisma.candidateProposal.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          validationRuns: {
            where: { status: { in: ['succeeded', 'failed'] } },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        }),
      }),
    );
  });
});

describe('DesignService.demoteSelectedCandidate', () => {
  function build() {
    const service = new DesignService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      createMediaStub() as never,
    ) as unknown as {
      demoteSelectedCandidate(tx: unknown, candidateId: string, draftId: string): Promise<void>;
    };
    return service;
  }

  it('demotes a selected candidate and returns the draft to editing', async () => {
    const tx = {
      candidateProposal: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      designDraft: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };

    await build().demoteSelectedCandidate(tx, 'candidate-1', 'draft-1');

    expect(tx.candidateProposal.updateMany).toHaveBeenCalledWith({
      where: { id: 'candidate-1', status: 'selected' },
      data: { status: 'rendered' },
    });
    expect(tx.designDraft.updateMany).toHaveBeenCalledWith({
      where: { id: 'draft-1', status: 'ready' },
      data: { status: 'editing' },
    });
  });

  it('leaves the draft alone when the candidate was not selected', async () => {
    const tx = {
      candidateProposal: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      designDraft: { updateMany: vi.fn() },
    };

    await build().demoteSelectedCandidate(tx, 'candidate-1', 'draft-1');

    expect(tx.designDraft.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * 对话生成：让 AI 出方案。
 *
 * 生成结果不落库——它是提案，不是资产。所以这里只需要一个任务 + 结果 blob，
 * 不建文档、不占候选名额。
 */
describe('DesignService.composeGenerate', () => {
  const DOCUMENT_ID = '0e0c21c4-44f1-4e53-8daa-ff796d722049';
  const VERSION_ID = '1e0c21c4-44f1-4e53-8daa-ff796d722049';
  const THEME_VERSION = {
    id: VERSION_ID,
    documentId: DOCUMENT_ID,
    content: JSON.stringify({
      tokenSchemaVersion: 'aurum.tokens.v1',
      tokens: {
        color: {
          primary: { $type: 'color', $value: '#1f6feb' },
          'on-primary': { $type: 'color', $value: '#ffffff' },
          surface: { $type: 'color', $value: '#ffffff' },
          border: { $type: 'color', $value: '#d8e0ea' },
          text: { $type: 'color', $value: '#0f172a' },
        },
        radius: {
          md: { $type: 'dimension', $value: '10px' },
          full: { $type: 'dimension', $value: '999px' },
        },
        space: {
          sm: { $type: 'dimension', $value: '8px' },
          lg: { $type: 'dimension', $value: '20px' },
        },
        duration: { fast: { $type: 'duration', $value: '150ms' } },
      },
    }),
  };

  function build() {
    const prisma = {
      designTask: { create: vi.fn().mockResolvedValue({ id: 'task-1' }) },
      designDocument: {
        findUnique: vi.fn().mockResolvedValue({
          id: DOCUMENT_ID,
          currentPublishedVersion: { id: VERSION_ID, content: THEME_VERSION.content },
        }),
      },
      designVersion: { findMany: vi.fn().mockResolvedValue([THEME_VERSION]) },
    };
    const service = new DesignService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      createMediaStub() as never,
    );
    return { service, prisma };
  }

  it('enqueues an async task with the recipe as the base', async () => {
    const { service, prisma } = build();

    const result = await service.composeGenerate({
      kind: 'component',
      themeDocumentId: DOCUMENT_ID,
      intent: '做一个毛玻璃卡片',
      recipeId: 'card-glass',
    });

    expect(result).toEqual({ taskId: 'task-1' });
    const input = JSON.parse(prisma.designTask.create.mock.calls[0][0].data.input);
    expect(prisma.designTask.create.mock.calls[0][0].data.taskType).toBe('ai_compose');
    expect(input.kind).toBe('component');
    expect(input.count).toBe(3);
    // 外行只说"用哪套配色"，钉版本由服务端补
    expect(input.baseContent.dependencies).toEqual([
      { documentId: DOCUMENT_ID, versionId: VERSION_ID },
    ]);
    // 配方必须真的进了基底：不然"从玻璃拟态起手"就只是一句空话
    expect(input.baseContent.variants.default.declarations['backdrop-filter']).toContain('blur');
  });

  it('refuses to guess a palette for theme assets', async () => {
    const { service } = build();

    // 随便挑一套配色当基底会让模型以为那是用户选的，生成一堆基于错误配色的效果
    await expect(
      service.composeGenerate({ kind: 'theme', themeDocumentId: DOCUMENT_ID, intent: '冷色调' }),
    ).rejects.toThrow('需要先选一套配色方案');
  });

  it('rejects an unknown recipe instead of silently falling back', async () => {
    const { service } = build();

    await expect(
      service.composeGenerate({
        kind: 'component',
        themeDocumentId: DOCUMENT_ID,
        intent: '毛玻璃卡片',
        recipeId: 'no-such-recipe',
      }),
    ).rejects.toThrow('不存在');
  });
});

/**
 * 一句话生成。
 *
 * 与 `composeGenerate` 的关键差别是**不收 kind**：三种基底一起交给模型，由它
 * 判断用户要的是配色、组件还是动效。用户因此不必先学我们的分类学。
 */
describe('DesignService.composeAuto', () => {
  const DOCUMENT_ID = '0e0c21c4-44f1-4e53-8daa-ff796d722049';
  const VERSION_ID = '1e0c21c4-44f1-4e53-8daa-ff796d722049';
  const THEME_VERSION = {
    id: VERSION_ID,
    documentId: DOCUMENT_ID,
    content: JSON.stringify({
      tokenSchemaVersion: 'aurum.tokens.v1',
      tokens: {
        color: {
          primary: { $type: 'color', $value: '#1f6feb' },
          'on-primary': { $type: 'color', $value: '#ffffff' },
          surface: { $type: 'color', $value: '#ffffff' },
          border: { $type: 'color', $value: '#d8e0ea' },
          text: { $type: 'color', $value: '#0f172a' },
        },
        radius: { md: { $type: 'dimension', $value: '10px' } },
      },
    }),
  };

  function build(theme: unknown) {
    const prisma = {
      designTask: { create: vi.fn().mockResolvedValue({ id: 'task-1' }) },
      designDocument: {
        findFirst: vi.fn().mockResolvedValue(theme),
        findUnique: vi.fn().mockResolvedValue({
          id: DOCUMENT_ID,
          currentPublishedVersion: { id: VERSION_ID, content: THEME_VERSION.content },
        }),
      },
      designVersion: {
        findUnique: vi.fn().mockResolvedValue(THEME_VERSION),
        findMany: vi.fn().mockResolvedValue([THEME_VERSION]),
      },
    };
    const media = createMediaStub();
    const service = new DesignService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      media as never,
    );
    return { service, prisma, media };
  }

  it('hands the model all three bases and lets it pick the kind', async () => {
    const { service, prisma } = build({ id: DOCUMENT_ID, currentPublishedVersionId: VERSION_ID });

    const result = await service.composeAuto({ intent: '悬停会发光的磨砂按钮' });

    expect(result).toEqual({ taskId: 'task-1', themeDocumentId: DOCUMENT_ID });
    const data = prisma.designTask.create.mock.calls[0][0].data;
    expect(data.taskType).toBe('ai_compose');
    const input = JSON.parse(data.input);
    expect(input.mode).toBe('auto');
    expect(Object.keys(input.bases).sort()).toEqual(['animation', 'component', 'theme']);
    // 组件与动效必须钉住默认配色，否则门禁解析不到 token 别名
    expect(input.bases.component.dependencies).toEqual([
      { documentId: DOCUMENT_ID, versionId: VERSION_ID },
    ]);
    // 三份基底共享同一套 token 词表：配色基底就是默认主题的正式版本
    expect(input.bases.theme).toEqual(JSON.parse(THEME_VERSION.content));
  });

  it('pins a resource as media and only offers the component base', async () => {
    const { service, prisma, media } = build({
      id: DOCUMENT_ID,
      currentPublishedVersionId: VERSION_ID,
    });
    media.describe.mockResolvedValue({
      resourceId: '2e0c21c4-44f1-4e53-8daa-ff796d722049',
      kind: 'image',
      alt: '示例图片',
      width: 800,
      height: 600,
      fit: 'cover',
      position: 'center',
    });

    await service.composeAuto({
      intent: '用这张图做一个有质感的卡片',
      mediaResourceId: '2e0c21c4-44f1-4e53-8daa-ff796d722049',
    });

    const input = JSON.parse(prisma.designTask.create.mock.calls[0][0].data.input);
    expect(Object.keys(input.bases)).toEqual(['component']);
    expect(input.bases.component.media).toMatchObject({
      resourceId: '2e0c21c4-44f1-4e53-8daa-ff796d722049',
      kind: 'image',
      alt: '示例图片',
    });
    expect(input.bases.component.appliesTo).toBe('container');
    expect(input.bases.component.variants.default.declarations['aspect-ratio']).toBe(1.333);
    expect(input.bases.component.variants.default.declarations['max-width']).toBe('533px');
  });

  it('keeps portrait media within the preview frame height', async () => {
    const { service, prisma, media } = build({
      id: DOCUMENT_ID,
      currentPublishedVersionId: VERSION_ID,
    });
    media.describe.mockResolvedValue({
      resourceId: '2e0c21c4-44f1-4e53-8daa-ff796d722049',
      kind: 'image',
      alt: '竖图',
      width: 896,
      height: 1152,
      fit: 'cover',
      position: 'center',
    });

    await service.composeAuto({
      intent: '用这张竖图做一个卡片',
      mediaResourceId: '2e0c21c4-44f1-4e53-8daa-ff796d722049',
    });

    const input = JSON.parse(prisma.designTask.create.mock.calls[0][0].data.input);
    const declarations = input.bases.component.variants.default.declarations;
    expect(declarations['aspect-ratio']).toBe(0.778);
    expect(declarations['max-width']).toBe('311px');
  });

  it('refuses to invent a palette when the library has none', async () => {
    const { service } = build(null);

    await expect(service.composeAuto({ intent: '冷色按钮' })).rejects.toThrow('配色');
  });
});

/**
 * 一句话生成的任务侧：类别是模型给的，服务端要按那个类别校验并把结果带回去。
 *
 * 这条链路里最容易静默出错的是依赖注入——模型不会自己钉配色版本，漏了就会
 * 让门禁解析不到别名，用户只看到"方案没过校验"。
 */
describe('DesignService.processAiComposeTask 的一句话生成', () => {
  const DOCUMENT_ID = '0e0c21c4-44f1-4e53-8daa-ff796d722049';
  const VERSION_ID = '1e0c21c4-44f1-4e53-8daa-ff796d722049';

  function build() {
    const designAgent = {
      generateAutoCandidates: vi.fn().mockResolvedValue([
        {
          kind: 'component',
          name: '磨砂按钮',
          label: '方案 A',
          rationale: '理由',
          // 刻意编一组假依赖：服务端必须覆盖成基底里那套，否则门禁解析不到 token
          content: {
            schemaVersion: 'aurum.component.v2',
            componentType: 'glass-button',
            appliesTo: 'element',
            dependencies: [{ documentId: 'bogus-document', versionId: 'bogus-version' }],
            variants: {
              default: { declarations: { color: '#0f172a', 'background-color': '#ffffff' } },
            },
          },
        },
      ]),
      repairCandidate: vi.fn().mockResolvedValue(null),
    };
    const prisma = {
      designTask: {
        findFirst: vi.fn().mockResolvedValue({ id: 'task-1' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ id: 'task-1', status: 'succeeded' }),
      },
      designDocument: {
        findUnique: vi.fn().mockResolvedValue({
          id: DOCUMENT_ID,
          currentPublishedVersion: { id: VERSION_ID, content: '{}' },
        }),
      },
      designVersion: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: VERSION_ID,
            documentId: DOCUMENT_ID,
            content: JSON.stringify({
              tokenSchemaVersion: 'aurum.tokens.v1',
              tokens: {
                color: {
                  primary: { $type: 'color', $value: '#1f6feb' },
                  'on-primary': { $type: 'color', $value: '#ffffff' },
                  surface: { $type: 'color', $value: '#ffffff' },
                  text: { $type: 'color', $value: '#0f172a' },
                },
              },
            }),
          },
        ]),
      },
    };
    const service = new DesignService(
      prisma as never,
      designAgent as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      createMediaStub() as never,
    );
    return { service, prisma, designAgent };
  }

  it('keeps the kind the model picked and pins the default theme', async () => {
    const { service, prisma } = build();

    await (
      service as never as {
        processAiComposeTask(task: {
          id: string;
          input: string;
          leaseToken: string;
        }): Promise<unknown>;
      }
    ).processAiComposeTask({
      id: 'task-1',
      leaseToken: 'lease-1',
      input: JSON.stringify({
        mode: 'auto',
        intent: '悬停会发光的磨砂按钮',
        count: 1,
        themeDocumentId: DOCUMENT_ID,
        bases: {
          component: {
            schemaVersion: 'aurum.component.v2',
            componentType: 'custom-component',
            appliesTo: 'container',
            dependencies: [{ documentId: DOCUMENT_ID, versionId: VERSION_ID }],
            variants: { default: { declarations: {} } },
          },
        },
      }),
    });

    const result = JSON.parse(prisma.designTask.updateMany.mock.calls[0][0].data.result);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].kind).toBe('component');
    expect(result.candidates[0].name).toBe('磨砂按钮');
    expect(result.candidates[0].content.dependencies).toEqual([
      { documentId: DOCUMENT_ID, versionId: VERSION_ID },
    ]);
  });

  it('forces the base media back onto the candidate', async () => {
    const { service, prisma } = build();
    const media = {
      resourceId: '2e0c21c4-44f1-4e53-8daa-ff796d722049',
      kind: 'image',
      alt: '示例图片',
      width: 800,
      height: 600,
      fit: 'cover',
      position: 'center',
    };

    await (
      service as never as {
        processAiComposeTask(task: {
          id: string;
          input: string;
          leaseToken: string;
        }): Promise<unknown>;
      }
    ).processAiComposeTask({
      id: 'task-1',
      leaseToken: 'lease-1',
      input: JSON.stringify({
        mode: 'auto',
        intent: '用这张图做一个卡片',
        count: 1,
        themeDocumentId: DOCUMENT_ID,
        bases: {
          component: {
            schemaVersion: 'aurum.component.v2',
            componentType: 'media-showcase',
            appliesTo: 'container',
            dependencies: [{ documentId: DOCUMENT_ID, versionId: VERSION_ID }],
            media,
            variants: { default: { declarations: {} } },
          },
        },
      }),
    });

    const result = JSON.parse(prisma.designTask.updateMany.mock.calls[0][0].data.result);
    const content = result.candidates[0].content;
    expect(content.media).toEqual(media);
    expect(content.appliesTo).toBe('container');
    expect(content.schemaVersion).toBe('aurum.component.v2');
  });

  it('treats unresolved dependency versions as a repairable content error', async () => {
    const { service, designAgent } = build();
    designAgent.repairCandidate.mockResolvedValue({
      schemaVersion: 'aurum.component.v2',
      componentType: 'glass-button',
      appliesTo: 'container',
      dependencies: [{ documentId: DOCUMENT_ID, versionId: VERSION_ID }],
      variants: { default: { declarations: { color: '#0f172a' } } },
    });

    const outcome = await (
      service as never as {
        composeCandidateWithRepair(
          kind: string,
          baseContent: Record<string, unknown>,
          candidate: Record<string, unknown>,
          context: { taskId: string; leaseToken: string },
        ): Promise<{ content?: Record<string, unknown>; error?: string }>;
      }
    ).composeCandidateWithRepair(
      'component',
      {
        schemaVersion: 'aurum.component.v2',
        componentType: 'glass-button',
        appliesTo: 'container',
        dependencies: [{ documentId: DOCUMENT_ID, versionId: VERSION_ID }],
        variants: { default: { declarations: {} } },
      },
      {
        label: 'A',
        rationale: 'r',
        content: {
          schemaVersion: 'aurum.component.v2',
          componentType: 'glass-button',
          appliesTo: 'container',
          // 合法 UUID 但数据库里不存在：validateDesignContent 会放行，
          // resolveFixtureContent 才会抛；这正是需要进入修复轮的情况。
          dependencies: [
            {
              documentId: '3e0c21c4-44f1-4e53-8daa-ff796d722049',
              versionId: '4e0c21c4-44f1-4e53-8daa-ff796d722049',
            },
          ],
          variants: { default: { declarations: { color: '#0f172a' } } },
        },
      },
      { taskId: 'task-1', leaseToken: 'lease-1' },
    );

    expect(outcome).toHaveProperty('content');
    expect(designAgent.repairCandidate).toHaveBeenCalledTimes(1);
  });

  it('folds state-named sibling variants before validating an AI candidate', async () => {
    const { service } = build();
    const base = {
      schemaVersion: 'aurum.component.v2',
      componentType: 'glass-button',
      appliesTo: 'element',
      dependencies: [{ documentId: DOCUMENT_ID, versionId: VERSION_ID }],
      variants: { default: { declarations: { color: '#0f172a' } } },
    };
    const outcome = await (
      service as never as {
        composeCandidateWithRepair(
          kind: string,
          baseContent: Record<string, unknown>,
          candidate: Record<string, unknown>,
          context: { taskId: string; leaseToken: string },
        ): Promise<{ content?: Record<string, unknown>; error?: string }>;
      }
    ).composeCandidateWithRepair(
      'component',
      base,
      {
        label: 'A',
        rationale: 'r',
        content: {
          ...base,
          componentType: 'lime-pill-button',
          variants: {
            active: { declarations: { transform: 'scale(0.97)' } },
            default: {
              declarations: { color: '#0f172a', 'background-color': '#ffffff' },
            },
            hover: { declarations: { transform: 'translateY(-1px)' } },
          },
        },
      },
      { taskId: 'task-1', leaseToken: 'lease-1' },
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.content?.variants).toEqual({
      default: {
        declarations: { color: '#0f172a', 'background-color': '#ffffff' },
        states: {
          active: { transform: 'scale(0.97)' },
          hover: { transform: 'translateY(-1px)' },
        },
      },
    });
  });

  it('re-locks media after a repair round that dropped it', async () => {
    const { service, prisma, designAgent } = build();
    const media = {
      resourceId: '2e0c21c4-44f1-4e53-8daa-ff796d722049',
      kind: 'image',
      alt: '示例图片',
      width: 800,
      height: 600,
      fit: 'cover',
      position: 'center',
    };
    designAgent.generateAutoCandidates.mockResolvedValue([
      {
        kind: 'component',
        name: '媒体卡',
        label: '方案 A',
        rationale: 'r',
        content: {
          schemaVersion: 'aurum.component.v2',
          componentType: 'media-showcase',
          appliesTo: 'container',
          dependencies: [{ documentId: DOCUMENT_ID, versionId: VERSION_ID }],
          media,
          variants: { default: { declarations: { color: 'not-a-color' } } },
        },
      },
    ]);
    designAgent.repairCandidate.mockResolvedValue({
      schemaVersion: 'aurum.component.v2',
      componentType: 'media-showcase',
      // 修复轮故意丢掉 media、改回 element、编造依赖：服务端必须全部重新锁回来
      appliesTo: 'element',
      dependencies: [{ documentId: 'bogus', versionId: 'bogus' }],
      variants: { default: { declarations: { color: '#ffffff' } } },
    });

    await (
      service as never as {
        processAiComposeTask(task: {
          id: string;
          input: string;
          leaseToken: string;
        }): Promise<unknown>;
      }
    ).processAiComposeTask({
      id: 'task-1',
      leaseToken: 'lease-1',
      input: JSON.stringify({
        mode: 'auto',
        intent: '用这张图做一个卡片',
        count: 1,
        themeDocumentId: DOCUMENT_ID,
        bases: {
          component: {
            schemaVersion: 'aurum.component.v2',
            componentType: 'media-showcase',
            appliesTo: 'container',
            dependencies: [{ documentId: DOCUMENT_ID, versionId: VERSION_ID }],
            media,
            variants: { default: { declarations: {} } },
          },
        },
      }),
    });

    const result = JSON.parse(prisma.designTask.updateMany.mock.calls[0][0].data.result);
    const content = result.candidates[0].content;
    expect(content.media).toEqual(media);
    expect(content.appliesTo).toBe('container');
    expect(content.dependencies).toEqual([{ documentId: DOCUMENT_ID, versionId: VERSION_ID }]);
    expect(content.variants.default.declarations.color).toBe('#ffffff');
  });
});

describe('DesignService.processAiComposeTask', () => {
  const DOCUMENT_ID = '0e0c21c4-44f1-4e53-8daa-ff796d722049';
  const VERSION_ID = '1e0c21c4-44f1-4e53-8daa-ff796d722049';

  function candidate(declarations: Record<string, string>) {
    return {
      schemaVersion: 'aurum.component.v2',
      componentType: 'glass-card',
      appliesTo: 'container',
      dependencies: [{ documentId: DOCUMENT_ID, versionId: VERSION_ID }],
      variants: { default: { declarations } },
    };
  }

  function build(candidates: Array<{ label: string; rationale: string; content: unknown }>) {
    const designAgent = {
      generateCandidates: vi.fn().mockResolvedValue(candidates),
      repairCandidate: vi.fn().mockResolvedValue(null),
    };
    const prisma = {
      designTask: {
        findFirst: vi.fn().mockResolvedValue({ id: 'task-1' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ id: 'task-1', status: 'succeeded' }),
      },
      designVersion: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: VERSION_ID,
            documentId: DOCUMENT_ID,
            content: JSON.stringify({
              tokenSchemaVersion: 'aurum.tokens.v1',
              tokens: { color: { primary: { $type: 'color', $value: '#1f6feb' } } },
            }),
          },
        ]),
      },
    };
    const service = new DesignService(
      prisma as never,
      designAgent as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      createMediaStub() as never,
    );
    return { service, prisma, designAgent };
  }

  function run(service: DesignService) {
    return (
      service as never as {
        processAiComposeTask(task: {
          id: string;
          input: string;
          leaseToken: string;
        }): Promise<unknown>;
      }
    ).processAiComposeTask({
      id: 'task-1',
      leaseToken: 'lease-1',
      input: JSON.stringify({
        kind: 'component',
        intent: '毛玻璃卡片',
        count: 3,
        baseContent: candidate({ 'background-color': '#ffffff' }),
      }),
    });
  }

  it('keeps the usable proposals when one of them fails the gate', async () => {
    const { service, prisma } = build([
      {
        label: '方案 A',
        rationale: '好',
        content: candidate({ color: '#0f172a', 'background-color': '#ffffff' }),
      },
      // 白底白字：结构合法，只有门禁能拦下它
      {
        label: '方案 B',
        rationale: '坏',
        content: candidate({ color: '#ffffff', 'background-color': '#ffffff' }),
      },
    ]);

    await run(service);

    const result = JSON.parse(prisma.designTask.updateMany.mock.calls[0][0].data.result);
    expect(result.candidates.map((item: { label: string }) => item.label)).toEqual(['方案 A']);
    // 失败的那个不能凭空消失：用户要知道为什么只有两个方案可选
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].label).toBe('方案 B');
    expect(result.failures[0].error).toContain('对比度');
  });

  it('fails the task only when nothing usable came back', async () => {
    const { service, prisma } = build([
      {
        label: '方案 A',
        rationale: '坏',
        content: candidate({ color: '#ffffff', 'background-color': '#ffffff' }),
      },
    ]);

    await expect(run(service)).rejects.toThrow('未能生成任何合规方案');
    expect(prisma.designTask.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * 任务失败的落库。
 *
 * 守的是一个 JS 语义坑，实测确认过：`try { return promise } catch {}` **不会**
 * 捕获 rejection——try 块成功求值并返回了，异常直接逃到调用方。原来的写法正是
 * `return this.processAiGenerationTask(...)`，于是任何生成异常都让任务永远停在
 * `running`：真实原因（"AI 未配置"、模型返回的不是 JSON）只剩一行日志，运营要等
 * lease 过期加重试三轮（约 20 分钟）才看到一句无信息量的 `LEASE_EXPIRED`。
 */
describe('DesignService.processNextTask 的失败落库', () => {
  function buildAiTask() {
    const designAgent = {
      generateCandidates: vi.fn().mockRejectedValue(new ServiceUnavailableException('AI 未配置')),
    };
    const prisma = {
      designTask: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue({
          id: 'task-1',
          taskType: 'ai_compose',
          status: 'pending',
          candidateId: null,
          retryCount: 0,
          input: JSON.stringify({
            kind: 'component',
            intent: '毛玻璃卡片',
            count: 1,
            baseContent: { schemaVersion: 'aurum.component.v2' },
          }),
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ status: 'running' }),
      },
    };
    const service = new DesignService(
      prisma as never,
      designAgent as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      createMediaStub() as never,
    );
    return { service, prisma };
  }

  it('records the real reason instead of leaving the task running', async () => {
    const { service, prisma } = buildAiTask();

    // 不 await 的话这里会抛出，而任务留在 running
    await expect(service.processNextTask()).resolves.not.toThrow();

    const failure = prisma.designTask.updateMany.mock.calls
      .map((call) => call[0].data)
      .find((data) => data?.errorCode === 'DESIGN_TASK_FAILED');
    expect(failure).toBeDefined();
    expect(failure.errorMessage).toContain('AI 未配置');
  });
});

/**
 * 审核台的轮询入口。
 *
 * 守的两件事：任务查询必须能按草稿收窄（否则每次轮询都扫整张任务表），
 * 并且不把 input/result 整行返回给只需要状态字段的列表界面。
 */
describe('DesignService.listTasks', () => {
  function build() {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new DesignService(
      { designTask: { findMany } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, findMany };
  }

  it('按草稿收窄：候选任务走关系，AI 任务按 input 里的 draftId 匹配', async () => {
    const { service, findMany } = build();

    await service.listTasks({ draftId: 'draft-1' });

    const args = findMany.mock.calls[0][0];
    expect(args.where.OR).toEqual([
      { candidate: { draftId: 'draft-1' } },
      { candidateId: null, input: { contains: '"draftId":"draft-1"' } },
    ]);
    expect(args.select.input).toBeUndefined();
    expect(args.select.result).toBeUndefined();
    expect(args.select.status).toBe(true);
  });

  it('status 与 draftId 同时给出时两个条件叠加', async () => {
    const { service, findMany } = build();

    await service.listTasks({ status: 'pending', draftId: 'draft-1' });

    const args = findMany.mock.calls[0][0];
    expect(args.where.status).toBe('pending');
    expect(args.where.OR).toHaveLength(2);
  });

  it('不带参数时保持原有行为：不过滤、仍只选列表字段', async () => {
    const { service, findMany } = build();

    await service.listTasks();

    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({});
    expect(args.select.result).toBeUndefined();
  });
});
