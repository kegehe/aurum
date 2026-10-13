import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AI_REPAIR_ATTEMPTS } from './design-agent.service';
import { DesignService } from './design.service';

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
