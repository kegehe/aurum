import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { evaluateContrast } from '../../common/color/contrast';
import { PrismaService } from '../prisma/prisma.service';
import { DesignDocumentService } from './design-document.service';
import { DesignPublishService } from './design-publish.service';
import { getPinnedDependencies, validateDesignContent } from './design-schema';
import {
  assertDependenciesPublished,
  assertDraftCurrent,
  canonicalJson,
  contentHash,
  createDependencies,
  ensureDraftExists,
  getCandidateContent,
  isRecord,
  normalizeAiComponentContent,
  normalizeComponentStateVariants,
  parseContent,
  resolveFixtureContent,
} from './design-content';
import {
  collectTokenTable,
  collectWithFixtureDependencies,
  toVarName,
  validateAssetAgainstTokens,
  type AssetValidation,
  type ResolvedToken,
  type TokenTable,
} from './design-css';
import { applyControlEdits, describeControls } from './design-controls';
import { findRecipe, listRecipes as listRecipeCatalog } from './design-recipes';
import {
  EXPORT_FORMATS,
  buildBundle,
  flattenTokenLeaves,
  type ExportFormat,
} from './design-export';
import { CreateCandidateDto } from './dto/create-candidate.dto';
import { CreateDesignDocumentDto } from './dto/create-design-document.dto';
import type { DesignKind, DomainPatch, JsonRecord } from './design.types';
import { AI_REPAIR_ATTEMPTS, DesignAgentService } from './design-agent.service';
import type { GeneratedDesignCandidate } from './design-agent.service';
import { GenerateAiCandidatesDto } from './dto/generate-ai-candidates.dto';
import {
  ControlledRendererService,
  FIXTURE_VERSION,
  VIEWPORT_ORDER,
} from './controlled-renderer.service';
import {
  STORAGE_SERVICE,
  type IStorageService,
} from '../storage/interfaces/storage-service.interface';
import {
  DesignMediaService,
  DESIGN_MEDIA_EXPORT_MAX_EDGE,
  DESIGN_MEDIA_PREVIEW_MAX_EDGE,
} from './design-media.service';
import { getMediaDescriptor, type MediaDescriptor } from './design-media';

const ACTIVE_CANDIDATE_LIMIT = 3;
const POLICY_VERSION = 'aurum.publish.v1';
/** 受控渲染器标识。改动渲染逻辑时递增，它会参与渲染任务的幂等键。 */
const RENDERER_ID = 'playwright-controlled-fixture/v2';
const TASK_LEASE_MS = 5 * 60 * 1000;
type AiTaskInput = JsonRecord & { draftId: string; intent: string; count: number };
type AiComposeInput = JsonRecord & {
  kind: DesignKind;
  intent: string;
  count: number;
  baseContent: JsonRecord;
  reference?: JsonRecord;
};
/**
 * 一句话生成的任务输入：带 `mode: 'auto'`，类别由模型在 `bases` 里挑。
 * 与 `AiComposeInput` 并存而不是合并，是为了让旧任务的输入保持原样可回放。
 */
type AiAutoComposeInput = JsonRecord & {
  mode: 'auto';
  intent: string;
  count: number;
  bases: JsonRecord;
  themeDocumentId: string;
  reference?: JsonRecord;
};

@Injectable()
export class DesignService {
  private readonly logger = new Logger(DesignService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly designAgent: DesignAgentService,
    private readonly renderer: ControlledRendererService,
    @Inject(STORAGE_SERVICE) private readonly storage: IStorageService,
    private readonly documents: DesignDocumentService,
    private readonly publish: DesignPublishService,
    private readonly media: DesignMediaService,
  ) {}

  /** 效果配方清单，供创建向导的"试试这些"芯片使用。 */
  listRecipes() {
    return listRecipeCatalog();
  }

  async listDocuments(kind?: string) {
    return this.prisma.designDocument.findMany({
      where: kind ? { kind } : undefined,
      include: {
        currentPublishedVersion: {
          select: { id: true, versionNumber: true, summary: true, publishedAt: true },
        },
      },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    });
  }

  async searchPublished(query?: string, kind?: string) {
    const term = query?.trim();
    return this.prisma.designDocument.findMany({
      where: {
        status: 'published',
        ...(kind ? { kind } : {}),
        ...(term ? { OR: [{ name: { contains: term } }, { slug: { contains: term } }] } : {}),
      },
      include: {
        currentPublishedVersion: {
          select: {
            id: true,
            versionNumber: true,
            summary: true,
            contentHash: true,
            publishedAt: true,
          },
        },
      },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      take: 100,
    });
  }

  async getPublishedAsset(idOrSlug: string) {
    const document = await this.prisma.designDocument.findFirst({
      where: { status: 'published', OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      include: {
        currentPublishedVersion: true,
        dependenciesFrom: {
          where: { fromVersionId: { not: '' } },
          include: {
            toDocument: { select: { id: true, slug: true, name: true, kind: true } },
            toVersion: { select: { id: true, versionNumber: true, contentHash: true } },
          },
        },
      },
    });
    if (!document?.currentPublishedVersion)
      throw new NotFoundException(`已发布设计资产 ${idOrSlug} 不存在`);
    return {
      document: { id: document.id, slug: document.slug, name: document.name, kind: document.kind },
      version: {
        id: document.currentPublishedVersion.id,
        number: document.currentPublishedVersion.versionNumber,
        contentHash: document.currentPublishedVersion.contentHash,
        publishedAt: document.currentPublishedVersion.publishedAt,
      },
      content: parseContent(document.currentPublishedVersion.content),
      dependencies: document.dependenciesFrom
        .filter((item) => item.fromVersionId === document.currentPublishedVersionId)
        .map((item) => ({
          document: item.toDocument,
          version: item.toVersion,
          type: item.dependencyType,
        })),
    };
  }

  async exportPublishedAsset(idOrSlug: string, format: ExportFormat) {
    if (!EXPORT_FORMATS.includes(format)) {
      throw new BadRequestException(`format 必须为 ${EXPORT_FORMATS.join('、')}`);
    }
    const asset = await this.getPublishedAsset(idOrSlug);
    if (format === 'json') return { format, content: asset.content };

    // 依赖要递归展开：style_pack / 组件 v2 / 动画的 token 都来自钉住的主题版本。
    // 只看顶层 content.tokens 的话，样式包（它根本没有该字段）永远导出为空。
    const resolved = await resolveFixtureContent(this.prisma, asset.content);
    const kind = asset.document.kind as DesignKind;
    // 已发布的历史内容不做迁移；导出 CSS/骨架时按当前结构约定解释。
    const renderable = kind === 'component' ? normalizeComponentStateVariants(resolved) : resolved;
    const tokens = collectWithFixtureDependencies(renderable);
    // 导出时把素材内嵌成 data URI；资源已被删除则导出占位，不影响其余内容。
    const media =
      format === 'bundle' || format === 'css'
        ? await this.media.resolveContent(asset.content, {
            strict: false,
            maxEdge: DESIGN_MEDIA_EXPORT_MAX_EDGE,
          })
        : null;

    if (format === 'bundle')
      return { format, content: buildBundle(kind, renderable, tokens, media) };
    if (format === 'css') {
      const bundle = buildBundle(kind, renderable, tokens, media);
      return {
        format,
        content: bundle.css || '/* 该资产不含可导出的 CSS。 */\n',
      };
    }
    if (format === 'tailwind') return { format, content: buildTailwindExport(resolved) };
    return { format, content: buildMarkdownExport(asset) };
  }

  async recordReadAccess(
    documentId: string | undefined,
    endpoint: string,
    accessType: string,
    key: string | undefined,
    clientId: string | undefined,
  ) {
    return this.prisma.designAccessLog.create({
      data: {
        documentId,
        endpoint,
        accessType,
        keyFingerprint: key ? contentHash(key).slice(0, 16) : null,
        clientId: clientId?.slice(0, 128) || null,
      },
    });
  }

  async getDocument(id: string) {
    return this.documents.getDocument(id);
  }

  /**
   * 以下四个发布方法保留为委托入口，维持控制器的既有契约不变。
   * 实现落在 `DesignPublishService`。
   */
  async createChangeSet(draftIds: string[]) {
    return this.publish.createChangeSet(draftIds);
  }

  async publishChangeSet(changeSetId: string) {
    return this.publish.publishChangeSet(changeSetId);
  }

  async publishDraft(draftId: string) {
    return this.publish.publishDraft(draftId);
  }

  async restoreVersion(documentId: string, restoredVersionId: string) {
    return this.publish.restoreVersion(documentId, restoredVersionId);
  }

  async createDocument(dto: CreateDesignDocumentDto) {
    const content = validateDesignContent(dto.kind, dto.content);
    await this.media.assertAvailable(content);
    const encoded = canonicalJson(content);
    const hash = contentHash(encoded);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const document = await tx.designDocument.create({
          data: {
            slug: dto.slug,
            name: dto.name.trim(),
            kind: dto.kind,
            description: dto.description?.trim() || null,
            status: 'draft',
            visibility: 'internal',
          },
        });
        const version = await tx.designVersion.create({
          data: {
            documentId: document.id,
            versionNumber: 1,
            content: encoded,
            contentHash: hash,
            summary: dto.summary?.trim() || '初始版本',
            changeKind: 'create',
            publishedAt: new Date(),
          },
        });
        await createDependencies(tx, content, document.id, version.id);
        return tx.designDocument.update({
          where: { id: document.id },
          data: { status: 'published', currentPublishedVersionId: version.id },
          include: { currentPublishedVersion: true },
        });
      });
    } catch (error) {
      if (isUniqueError(error)) throw new ConflictException(`设计文档 slug "${dto.slug}" 已存在`);
      throw error;
    }
  }

  async createDraft(documentId: string) {
    const document = await this.prisma.designDocument.findUnique({ where: { id: documentId } });
    if (!document) throw new NotFoundException(`设计文档 ${documentId} 不存在`);
    if (!document.currentPublishedVersionId)
      throw new BadRequestException('设计文档尚无正式版本，不能创建草稿');
    const baseVersionId = document.currentPublishedVersionId;

    return this.prisma.$transaction(async (tx) => {
      const draft = await tx.designDraft.create({
        data: { documentId, baseVersionId, status: 'editing' },
      });
      await tx.designDraftVersion.create({ data: { draftId: draft.id, versionId: baseVersionId } });
      return draft;
    });
  }

  async createCandidate(
    draftId: string,
    dto: CreateCandidateDto,
    options: { slotAlreadyReserved?: boolean; taskId?: string; leaseToken?: string } = {},
  ) {
    const draft = await this.getEditableDraft(draftId);
    const content = validateDesignContent(draft.document.kind as DesignKind, dto.content);
    await assertDependenciesPublished(this.prisma, content, draft.documentId);
    const baseContent = parseContent(draft.baseVersion.content);
    const structuredDiff = buildStructuredDiff(baseContent, content);
    const patch: DomainPatch = {
      schema: 'aurum.domain-patch.v1',
      operations: [
        {
          op: 'replace_document_content',
          documentKind: draft.document.kind as DesignKind,
          value: content,
        },
      ],
    };

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (options.taskId && options.leaseToken) {
          const owned = await tx.designTask.updateMany({
            where: {
              id: options.taskId,
              status: 'running',
              leaseToken: options.leaseToken,
              leaseExpiresAt: { gt: new Date() },
            },
            data: { leaseExpiresAt: new Date(Date.now() + TASK_LEASE_MS) },
          });
          if (owned.count !== 1) {
            throw new ConflictException('AI 任务已取消、超时或被其他工作进程接管');
          }
        }
        if (!options.slotAlreadyReserved) await this.reserveCandidateSlots(tx, draftId, 1);
        const candidate = await tx.candidateProposal.create({
          data: {
            draftId,
            baseVersionId: draft.baseVersionId,
            label: dto.label.trim(),
            rationale: dto.rationale?.trim(),
            patch: canonicalJson(patch),
            structuredDiff: canonicalJson(structuredDiff),
            impactReport: canonicalJson({
              changedPaths: structuredDiff.map((item) => item.path),
              dependencyChange: getPinnedDependencies(content).length > 0,
            }),
            status: 'generated',
            generationKey: dto.generationKey,
          },
        });
        // 这条记录只覆盖结构校验，刻意**不写成 succeeded**：
        // selectCandidate / publishDraft 只认最近一次真正的门禁 run（succeeded/failed），
        // 一条什么都没测却宣称 passed 的记录不能参与那个判断。
        await tx.validationRun.create({
          data: {
            candidateId: candidate.id,
            status: 'skipped',
            policyVersion: POLICY_VERSION,
            result: canonicalJson({
              scope: 'structural',
              schema: 'passed',
              dependencies: 'passed',
              note: '创建候选时仅执行结构化规范与依赖校验；渲染与门禁结果见 render_validate 任务',
            }),
            finishedAt: new Date(),
          },
        });
        return candidate;
      });
    } catch (error) {
      if (isUniqueError(error) && dto.generationKey) {
        const existing = await this.prisma.candidateProposal.findFirst({
          where: { draftId, generationKey: dto.generationKey },
        });
        if (existing) return existing;
      }
      throw error;
    }
  }

  async queueAiCandidates(draftId: string, dto: GenerateAiCandidatesDto) {
    const draft = await this.getEditableDraft(draftId);
    const count = dto.count ?? 3;
    return this.prisma.$transaction(async (tx) => {
      await this.reserveCandidateSlots(tx, draftId, count);
      return tx.designTask.create({
        data: {
          sessionId: draft.sessionId,
          taskType: 'ai_generate',
          status: 'pending',
          input: canonicalJson({
            draftId,
            intent: dto.intent.trim(),
            count,
            baseVersionId: draft.baseVersionId,
          }),
        },
      });
    });
  }

  async listCandidates(draftId: string) {
    await ensureDraftExists(this.prisma, draftId);
    return this.prisma.candidateProposal.findMany({
      where: { draftId },
      include: { validationRuns: { orderBy: { createdAt: 'desc' } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * 删除一个尚未被采用的候选方案。
   *
   * 存在的必要性：人工候选在 createCandidate 里占掉一个候选名额，而名额原先
   * **只会被 AI 路径释放**（releaseCandidateSlots 的三个调用点全在 AI 分支），
   * 加上没有删除入口，`ACTIVE_CANDIDATE_LIMIT = 3` 意味着同一草稿连续 3 次
   * 门禁或渲染失败就永久锁死，唯一出路是重建草稿。
   *
   * 顺带回收 storage 产物：候选删除会级联清掉 PreviewSnapshot / DesignTask 等
   * 数据库行，但**不级联 storage 对象**，预览 PNG 会变成孤儿。
   */
  async deleteCandidate(candidateId: string) {
    const candidate = await this.prisma.candidateProposal.findUnique({
      where: { id: candidateId },
      include: {
        draft: { include: { changeSetMemberships: { include: { changeSet: true } } } },
        previewSnapshots: { select: { storagePath: true } },
        tasks: { select: { result: true } },
      },
    });
    if (!candidate) throw new NotFoundException(`候选方案 ${candidateId} 不存在`);
    if (['selected', 'published'].includes(candidate.status)) {
      throw new BadRequestException('已选择或已发布的候选方案不能删除');
    }
    if (
      candidate.draft.changeSetMemberships.some(
        (membership) => membership.changeSet.status !== 'published',
      )
    ) {
      throw new ConflictException('候选方案已加入待发布 ChangeSet，已冻结');
    }

    const keys = new Set<string>();
    for (const snapshot of candidate.previewSnapshots) {
      if (snapshot.storagePath) keys.add(snapshot.storagePath);
    }
    for (const task of candidate.tasks) {
      const result = parseContent(task.result ?? '{}');
      if (!Array.isArray(result.previews)) continue;
      for (const preview of result.previews) {
        if (!isJsonRecord(preview)) continue;
        if (typeof preview.snapshotKey === 'string') keys.add(preview.snapshotKey);
        if (typeof preview.diffKey === 'string') keys.add(preview.diffKey);
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.candidateProposal.deleteMany({
        where: { id: candidateId, status: { notIn: ['selected', 'published'] } },
      });
      if (deleted.count !== 1) throw new ConflictException('候选方案状态已变化，删除已取消');
      await tx.designDraft.updateMany({
        where: { id: candidate.draftId, candidateSlotsUsed: { gt: 0 } },
        data: { candidateSlotsUsed: { decrement: 1 } },
      });
    });

    // 产物清理是尽力而为：删不掉不该让删除操作失败（key 已在库里消失）
    const outcomes = await Promise.all(
      [...keys].map((key) =>
        this.storage.delete(key).then(
          () => true,
          () => false,
        ),
      ),
    );
    return { deleted: true, removedArtifacts: outcomes.filter(Boolean).length };
  }

  async selectCandidate(candidateId: string) {
    const candidate = await this.prisma.candidateProposal.findUnique({
      where: { id: candidateId },
      include: {
        draft: { include: { document: true } },
        // 只看最近一次真正的门禁 run：结构校验的 skipped 记录不参与
        validationRuns: {
          where: { status: { in: ['succeeded', 'failed'] } },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
    if (!candidate) throw new NotFoundException(`候选方案 ${candidateId} 不存在`);
    if (candidate.status !== 'validated')
      throw new BadRequestException('只有通过校验的候选方案可以被选择');
    if (candidate.validationRuns[0]?.status !== 'succeeded') {
      throw new BadRequestException('候选方案最近一次校验未通过');
    }
    assertDraftCurrent(candidate.draft, candidate.draft.document);

    return this.prisma.$transaction(async (tx) => {
      const membership = await tx.changeSetDraft.findFirst({
        where: { draftId: candidate.draftId, changeSet: { status: { not: 'published' } } },
        select: { id: true },
      });
      if (membership) {
        throw new ConflictException('草稿已加入待发布 ChangeSet，候选方案已冻结');
      }
      await tx.candidateProposal.updateMany({
        where: { draftId: candidate.draftId, status: 'selected' },
        data: { status: 'validated' },
      });
      const selected = await tx.candidateProposal.update({
        where: { id: candidateId },
        data: { status: 'selected' },
      });
      await tx.designDraft.update({
        where: { id: candidate.draftId },
        data: { status: 'ready', lockVersion: { increment: 1 } },
      });
      return selected;
    });
  }

  async renderAndValidateCandidate(candidateId: string, options: { autoPublish?: boolean } = {}) {
    const candidate = await this.prisma.candidateProposal.findUnique({
      where: { id: candidateId },
      include: { draft: { include: { document: true } } },
    });
    if (!candidate) throw new NotFoundException(`候选方案 ${candidateId} 不存在`);
    if (!['generated', 'rendered', 'validated'].includes(candidate.status))
      throw new BadRequestException('当前候选状态不能执行渲染和校验');
    // 幂等键必须包含夹具版本：只按 patch 哈希的话，升级夹具后所有已渲染过的
    // 候选会永远命中旧任务，`if (existing) return existing` 让它们继续显示旧图。
    // autoPublish 也要进键：它改变任务的后半段行为，不能和普通渲染互相命中。
    const key = contentHash(
      `${candidate.patch}|${FIXTURE_VERSION}|${RENDERER_ID}${options.autoPublish ? '|autopublish' : ''}`,
    );
    const existing = await this.prisma.designTask.findFirst({
      where: { candidateId, taskType: 'render_validate', idempotencyKey: key },
    });
    if (existing?.status === 'canceled') {
      return this.prisma.designTask.update({
        where: { id: existing.id },
        data: {
          status: 'pending',
          errorCode: null,
          errorMessage: null,
          startedAt: null,
          finishedAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
    }
    if (existing) return existing;
    return this.prisma.designTask.create({
      data: {
        candidateId,
        taskType: 'render_validate',
        status: 'pending',
        idempotencyKey: key,
        input: canonicalJson({
          fixtureVersion: FIXTURE_VERSION,
          viewports: ['desktop', 'tablet', 'mobile'],
          autoPublish: options.autoPublish === true,
        }),
      },
    });
  }

  async processNextTask() {
    await this.recoverExpiredTasks();
    const pending = await this.prisma.designTask.findFirst({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
    if (!pending) return null;
    const leaseToken = randomUUID();
    const claimed = await this.prisma.designTask.updateMany({
      where: { id: pending.id, status: 'pending' },
      data: {
        status: 'running',
        startedAt: new Date(),
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + TASK_LEASE_MS),
      },
    });
    if (claimed.count !== 1) return null;
    const heartbeat = setInterval(
      () => {
        // 必须吞掉异常：未处理的 rejection 在 Node 默认策略下会直接终止进程。
        // 渲染量越大，心跳与繁忙的 SQLite 重叠概率越高，这个隐患越明显。
        this.extendTaskLease(pending.id, leaseToken).catch(() => undefined);
      },
      Math.floor(TASK_LEASE_MS / 3),
    );
    try {
      // 必须 `await`：`return promise` 不会把 rejection 交给这个 try 的 catch
      // ——try 块本身成功求值并返回了，异常会直接逃到调用方。后果是任务永远停在
      // running，真实原因（"AI 未配置"、模型返回的不是 JSON）只剩一行日志，
      // 运营要等 lease 过期 → 重试 3 轮（约 20 分钟）才看到一句 LEASE_EXPIRED。
      if (pending.taskType === 'ai_generate')
        return await this.processAiGenerationTask({ ...pending, leaseToken });
      if (pending.taskType === 'ai_compose')
        return await this.processAiComposeTask({ ...pending, leaseToken });
      if (pending.taskType !== 'render_validate' || !pending.candidateId)
        throw new BadRequestException('不支持的设计任务');
      const candidate = await this.prisma.candidateProposal.findUniqueOrThrow({
        where: { id: pending.candidateId },
        include: { draft: { include: { document: true, baseVersion: true } } },
      });
      const kind = candidate.draft.document.kind as DesignKind;
      const content = getCandidateContent(candidate.patch, kind);
      const baseContent = parseContent(candidate.draft.baseVersion.content);
      const [fixtureContent, fixtureBaseContent] = await Promise.all([
        resolveFixtureContent(this.prisma, content),
        resolveFixtureContent(this.prisma, baseContent),
      ]);
      const [media, baseMedia] = await Promise.all([
        this.media.resolveContent(fixtureContent, {
          strict: false,
          maxEdge: DESIGN_MEDIA_PREVIEW_MAX_EDGE,
        }),
        this.media.resolveContent(fixtureBaseContent, {
          strict: false,
          maxEdge: DESIGN_MEDIA_PREVIEW_MAX_EDGE,
        }),
      ]);
      const rendered = await this.renderer.render(
        { kind, content: fixtureContent, baseContent: fixtureBaseContent, media, baseMedia },
        candidate.id,
      );
      const screenshots = rendered.outputs;

      // 门禁在渲染之后执行，且**不抛异常**：运营必须能看到自己改坏了什么，
      // 所以预览照常落库，失败只体现在候选不被置为 validated。
      // 抛异常的话事务不会执行，一张预览图都不会落盘。
      const validation = validateAssetAgainstTokens(
        kind,
        fixtureContent,
        collectWithFixtureDependencies(fixtureContent),
        evaluateContrast,
      );
      const gatePassed = validation.errors.length === 0;
      const validationResult = canonicalJson({
        schema: 'passed',
        dependencies: 'passed',
        renderer: `playwright-controlled-fixture/${FIXTURE_VERSION}`,
        viewports: [...new Set(rendered.outputs.map((output) => output.viewport))],
        browser: rendered.browserVersion,
        fontStack: rendered.fontStack,
        declarations: gatePassed ? 'passed' : 'failed',
        accessibility: {
          status: validation.errors.some((error) => error.includes('对比度'))
            ? 'failed'
            : validation.contrasts.length
              ? 'passed'
              : 'not_applicable',
          measured: validation.contrasts,
          // "无法判定"的计数必须上报，否则全绿没有信息量
          undeterminable: validation.undeterminable,
        },
        errors: validation.errors,
      });

      const completedTask = await this.prisma.$transaction(async (tx) => {
        // Claim completion before changing candidate state. cancelTask uses the
        // same status predicate, so either cancellation or completion wins.
        const completed = await tx.designTask.updateMany({
          where: { id: pending.id, status: 'running', leaseToken },
          data: {
            status: 'succeeded',
            result: canonicalJson({
              previews: screenshots.map(({ viewport, snapshotKey, diffKey, changedPixels }) => ({
                viewport,
                snapshotKey,
                diffKey,
                changedPixels,
              })),
              validation: gatePassed ? 'passed' : 'failed',
              gateErrors: validation.errors,
            }),
            finishedAt: new Date(),
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        if (completed.count !== 1) return null;
        await tx.previewSnapshot.deleteMany({ where: { candidateId: candidate.id } });
        await tx.previewSnapshot.createMany({
          data: screenshots.map((snapshot) => ({
            candidateId: candidate.id,
            viewport: snapshot.viewport,
            browser: rendered.browserVersion,
            fixtureVersion: FIXTURE_VERSION,
            artifactHash: snapshot.artifactHash,
            storagePath: snapshot.snapshotKey,
          })),
        });
        await tx.validationRun.create({
          data: {
            candidateId: candidate.id,
            status: gatePassed ? 'succeeded' : 'failed',
            policyVersion: POLICY_VERSION,
            result: validationResult,
            errorMessage: gatePassed ? null : validation.errors.join('; ').slice(0, 2000),
            finishedAt: new Date(),
          },
        });
        if (gatePassed) {
          await tx.candidateProposal.updateMany({
            where: { id: candidate.id, status: { in: ['generated', 'rendered', 'validated'] } },
            data: { status: 'validated' },
          });
        } else {
          // 已选中的候选若这次门禁失败，必须降级并把草稿退回编辑态：
          // 否则「最近一次门禁失败」会同时挡住发布、重渲染（只接受未选中）
          // 和重新选择（只接受 validated），运营只能废弃整份草稿。
          await this.demoteSelectedCandidate(tx, candidate.id, candidate.draftId);
          // 未选中的候选维持原行为：卡在 generated/rendered，发布不出去。
          await tx.candidateProposal.updateMany({
            where: { id: candidate.id, status: { in: ['generated', 'rendered'] } },
            data: { status: 'rendered' },
          });
        }
        return tx.designTask.findUnique({ where: { id: pending.id } });
      });
      if (!completedTask) return null;
      // 一键发布的任务在渲染与门禁之后还要走完「选择 → 发布」。
      return parseContent(pending.input ?? '{}').autoPublish === true
        ? await this.finishAutoPublish(
            pending.id,
            candidate.id,
            candidate.draftId,
            gatePassed,
            validation,
          )
        : completedTask;
    } catch (error) {
      const task = await this.prisma.designTask.findUnique({
        where: { id: pending.id },
        select: { status: true },
      });
      if (task?.status === 'canceled') {
        if (pending.taskType === 'ai_generate') {
          await this.cleanupCanceledAiCandidates(pending.id, parseContent(pending.input ?? '{}'));
        }
        return task;
      }
      const failed = await this.prisma.designTask.updateMany({
        where: {
          id: pending.id,
          status: 'running',
          leaseToken,
          leaseExpiresAt: { gt: new Date() },
        },
        data: {
          status: 'failed',
          errorCode: 'DESIGN_TASK_FAILED',
          errorMessage: error instanceof Error ? error.message : String(error),
          finishedAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      if (failed.count === 1 && pending.taskType === 'ai_generate') {
        await this.releaseUnusedAiTaskSlots(pending.id, parseContent(pending.input ?? '{}'));
      }
      return failed;
    } finally {
      clearInterval(heartbeat);
    }
  }

  /**
   * 编译预览：结构化内容 → CSS + HTML 骨架 + 门禁结论 + 反推控件。
   *
   * 不落库、不花 AI 调用、**不开浏览器**，所以滑块每动一下都能调得动。
   * 返回的 css/html 由服务端从 content **派生**（方案 §15.4：事实来源是结构化
   * 数据，不是模型返回的 HTML，也不是前端拼的字符串）。
   *
   * 注意这里返回的预览是**实时视图**，不是发布依据：权威预览仍由受控渲染器
   * （Playwright，固定视口与字体）产出。
   */
  async composePreview(input: {
    kind: DesignKind;
    content: JsonRecord;
    themeDocumentId?: string;
    edits?: Record<string, string | number>;
  }) {
    const withTheme = await this.attachThemeDependency(input.content, input.themeDocumentId);
    // 历史/模型内容可能把 hover/active 写成同级 variant；预览与后续发布都用
    // 规范化后的内容，否则骨架只会挂上其中一个 variant 类。
    const canonical =
      input.kind === 'component' ? normalizeComponentStateVariants(withTheme) : withTheme;
    const base = validateDesignContent(input.kind, canonical);
    // 控件要按主题的 token 分组推导（"圆角：小/中/大"），所以这里先要 token 表
    const tokens = collectWithFixtureDependencies(await resolveFixtureContent(this.prisma, base));

    // 编辑套在**未注入**的内容上：注入的 __aurumFixtureDependencies 是渲染期
    // 内部数据，不该进版本内容，也不该被当成可编辑的声明来源。
    const edited = input.edits
      ? applyControlEdits(base, tokens, input.edits)
      : { content: base, applied: [], skipped: [] };
    const validated = validateDesignContent(input.kind, edited.content);

    const {
      resolved,
      tokens: editedTokens,
      validation,
    } = await this.resolveAndEvaluate(input.kind, validated);
    // 素材缺失不应让运营看不到自己的内容：预览用占位，发布时再严格校验。
    const media = await this.media.resolveContent(validated, {
      strict: false,
      maxEdge: DESIGN_MEDIA_PREVIEW_MAX_EDGE,
    });
    const bundle = buildBundle(input.kind, resolved, editedTokens, media);

    return {
      content: validated,
      css: bundle.copyCss || bundle.css,
      html: bundle.html,
      tokensUsed: bundle.tokensUsed,
      skippedTokens: bundle.skippedTokens,
      controls: describeControls(validated, editedTokens),
      applied: edited.applied,
      skipped: edited.skipped,
      gate: {
        passed: validation.errors.length === 0,
        errors: validation.errors,
        contrasts: validation.contrasts,
        undeterminable: validation.undeterminable,
      },
    };
  }

  /**
   * 一次调用完成「建文档 → 记录候选 → 渲染校验 → 选择 → 发布」。
   *
   * 之所以能一键：对比度门禁是**纯函数**（`validateAssetAgainstTokens`），不需要
   * 浏览器；Playwright 只产出预览图。所以门禁在请求线程里同步跑完，不通过就
   * **一个字都不写库**——"发布门禁必须全部通过"因此是结构性保证，而不是靠事后
   * 回滚。渲染仍留在 Worker（方案 §15.3：渲染与校验不占请求线程，且 AI 与渲染
   * 分属两个任务，渲染失败不会重复扣 AI 费用）。
   *
   * 门禁结果返回结构化对象而不是抛 4xx：对向导来说"门禁没过"是正常分支，
   * 需要把实测比值交给"帮我修好"，不是异常。
   */
  async composeAndPublish(input: {
    name: string;
    slug: string;
    kind: DesignKind;
    content: JsonRecord;
    themeDocumentId?: string;
    summary?: string;
  }) {
    const withTheme = await this.attachThemeDependency(input.content, input.themeDocumentId);
    const content = validateDesignContent(
      input.kind,
      input.kind === 'component' ? normalizeComponentStateVariants(withTheme) : withTheme,
    );
    // 发布是严格边界：素材必须读得到字节，否则一个字都不写库。
    await this.media.assertAvailable(content);
    if (getMediaDescriptor(content)) {
      await this.media.resolveContent(content, {
        strict: true,
        maxEdge: DESIGN_MEDIA_PREVIEW_MAX_EDGE,
      });
    }
    const { validation } = await this.resolveAndEvaluate(input.kind, content);
    if (validation.errors.length > 0) {
      return {
        published: false as const,
        gate: {
          errors: validation.errors,
          contrasts: validation.contrasts,
          undeterminable: validation.undeterminable,
        },
      };
    }

    const summary = input.summary?.trim() || '由创建向导发布';
    const document = await this.createDocument({
      name: input.name,
      slug: input.slug,
      kind: input.kind,
      content,
      summary,
      description: summary,
    });
    const draft = await this.createDraft(document.id);
    const candidate = await this.createCandidate(draft.id, {
      label: '一键保存',
      content,
      rationale: '由创建向导直接发布',
    });
    const task = await this.renderAndValidateCandidate(candidate.id, { autoPublish: true });

    return {
      published: true as const,
      documentId: document.id,
      versionId: document.currentPublishedVersionId,
      candidateId: candidate.id,
      taskId: task.id,
    };
  }

  /**
   * 门禁失败时把已选中的候选降级，并让草稿退回编辑态。
   *
   * 不降级会形成死角：发布要求最近一次门禁成功，重渲染只接受未选中状态，
   * 重新选择只接受 validated——三条恢复路径会同时关闭。
   */
  private async demoteSelectedCandidate(
    tx: Prisma.TransactionClient,
    candidateId: string,
    draftId: string,
  ): Promise<void> {
    const demoted = await tx.candidateProposal.updateMany({
      where: { id: candidateId, status: 'selected' },
      data: { status: 'rendered' },
    });
    if (demoted.count > 0) {
      await tx.designDraft.updateMany({
        where: { id: draftId, status: 'ready' },
        data: { status: 'editing' },
      });
    }
  }

  /**
   * 一键发布的收尾：门禁通过就选择并发布，否则把任务标成"门禁未通过"。
   *
   * 两种情况下预览图都已经落库了——运营必须能看到自己改坏了什么，所以失败只
   * 体现在"有没有发布"上，不吞掉产物。
   */
  private async finishAutoPublish(
    taskId: string,
    candidateId: string,
    draftId: string,
    gatePassed: boolean,
    validation: AssetValidation,
  ) {
    if (gatePassed) {
      let versionId: string;
      try {
        const state = await this.prisma.candidateProposal.findUnique({
          where: { id: candidateId },
          select: {
            status: true,
            draft: { select: { status: true, documentId: true, baseVersionId: true } },
          },
        });
        if (state?.draft.status === 'published') {
          // 草稿已发布，但发布它的不一定是本候选：publishDraft 会把真正发布的
          // 候选置为 published。否则（例如运营改选了别的候选）不能把本候选的
          // 封面复制到别人的版本上。
          if (state.status !== 'published') {
            this.logger.warn(
              `草稿 ${draftId} 已由其它候选发布，跳过候选 ${candidateId} 的封面复制`,
            );
            return this.prisma.designTask.findUnique({ where: { id: taskId } });
          }
          // publishDraft 的幂等分支返回「文档当前版本」，期间若又有人发布新版本，
          // 直接复制会把旧封面盖到新版本上。按候选内容哈希定位本草稿发布出的版本。
          // 解析失败只影响封面：发布已经生效，不能让任务显示成发布失败。
          let resolvedVersionId: string | null;
          try {
            resolvedVersionId = await this.resolvePublishedVersionId(
              candidateId,
              state.draft.documentId,
              state.draft.baseVersionId,
            );
          } catch (error) {
            this.logger.error(
              `无法解析候选 ${candidateId} 对应的正式版本，跳过封面复制：${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return this.prisma.designTask.findUnique({ where: { id: taskId } });
          }
          if (!resolvedVersionId) {
            this.logger.warn(`找不到候选 ${candidateId} 对应的正式版本，跳过封面复制`);
            return this.prisma.designTask.findUnique({ where: { id: taskId } });
          }
          versionId = resolvedVersionId;
        } else {
          // 重试路径：上一轮可能已经选择过候选。selectCandidate 只接受 validated，
          // 再调一次必然失败，所以「已选择」按幂等成功处理。
          if (state?.status !== 'selected') {
            await this.selectCandidate(candidateId);
          }
          const published = await this.publishDraft(draftId);
          if (!('versionNumber' in published) || typeof published.versionNumber !== 'number') {
            // 并发窗口：读状态时草稿还没发布，publishDraft 却走了幂等分支，
            // 说明另一个候选刚刚抢先发布。不要用本候选的封面覆盖它。
            this.logger.warn(
              `草稿 ${draftId} 在发布过程中已被其它候选发布，跳过候选 ${candidateId} 的封面复制`,
            );
            return this.prisma.designTask.findUnique({ where: { id: taskId } });
          }
          versionId = published.id;
        }
      } catch (error) {
        // 发布本身失败（例如基准版本被并发改动）必须与门禁失败区分开：否则
        // 运营会跑去改颜色，而真正的问题在别处。
        await this.prisma.designTask.update({
          where: { id: taskId },
          data: {
            status: 'failed',
            errorCode: 'DESIGN_PUBLISH_FAILED',
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        });
        return this.prisma.designTask.findUnique({ where: { id: taskId } });
      }
      // 版本已经上线：封面复制只是展示产物，失败不能把成功发布改写成失败，
      // 否则运营会对着一个已经生效的版本反复点重试。
      try {
        await this.copyCandidateSnapshotsToVersion(candidateId, versionId);
      } catch (error) {
        this.logger.error(
          `设计版本 ${versionId} 已发布，但候选 ${candidateId} 的封面复制失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return this.prisma.designTask.findUnique({ where: { id: taskId } });
    }
    // 正常情况下到不了这里：请求线程已经用同一套纯函数预检过。留着是因为
    // 校验在 Worker 侧同样要权威——两处结论不一致时，以不发布为准。
    await this.prisma.designTask.update({
      where: { id: taskId },
      data: {
        status: 'failed',
        errorCode: 'DESIGN_PUBLISH_GATE_FAILED',
        errorMessage: validation.errors.join('; ').slice(0, 2_000),
      },
    });
    return this.prisma.designTask.findUnique({ where: { id: taskId } });
  }

  /**
   * 渲染图挂在候选上。资产库封面读的是正式版本的桌面快照，
   * 所以发布后把同一批图再记到该版本，候选上的原件留着给审核台。
   */
  private async copyCandidateSnapshotsToVersion(candidateId: string, versionId: string) {
    const snapshots = await this.prisma.previewSnapshot.findMany({ where: { candidateId } });
    for (const snapshot of snapshots) {
      const existing = await this.prisma.previewSnapshot.findFirst({
        where: {
          versionId,
          viewport: snapshot.viewport,
          state: snapshot.state,
          kind: snapshot.kind,
        },
        select: { id: true },
      });
      const data = {
        viewport: snapshot.viewport,
        state: snapshot.state,
        kind: snapshot.kind,
        format: snapshot.format,
        width: snapshot.width,
        height: snapshot.height,
        browser: snapshot.browser,
        fixtureVersion: snapshot.fixtureVersion,
        artifactHash: snapshot.artifactHash,
        storagePath: snapshot.storagePath,
      };
      if (existing) {
        await this.prisma.previewSnapshot.update({ where: { id: existing.id }, data });
      } else {
        await this.prisma.previewSnapshot.create({ data: { ...data, versionId } });
      }
    }
  }

  /**
   * 定位本草稿发布出的正式版本。
   *
   * 不能只看 baseVersionId：adoptCurrentVersion 不新建版本，之后基于同一基准
   * 创建的新草稿又会产出新的版本。因此用候选内容哈希做二次校验——发布事务
   * 创建的版本一定是这个哈希，内容与基准一致时则直接是 baseVersion 本身。
   * 找不到匹配时返回 null，调用方应跳过复制而不是猜一个版本。
   */
  private async resolvePublishedVersionId(
    candidateId: string,
    documentId: string,
    baseVersionId: string,
  ): Promise<string | null> {
    const candidate = await this.prisma.candidateProposal.findUnique({
      where: { id: candidateId },
      select: {
        patch: true,
        draft: {
          select: {
            document: { select: { kind: true } },
            baseVersion: { select: { contentHash: true } },
          },
        },
      },
    });
    if (!candidate) return null;
    const hash = contentHash(
      canonicalJson(
        getCandidateContent(candidate.patch, candidate.draft.document.kind as DesignKind),
      ),
    );
    // 内容与基准一致时 publishDraft 走 adoptCurrentVersion，不新建版本
    if (candidate.draft.baseVersion.contentHash === hash) return baseVersionId;
    const successor = await this.prisma.designVersion.findFirst({
      where: { documentId, baseVersionId, contentHash: hash },
      orderBy: { versionNumber: 'desc' },
      select: { id: true },
    });
    return successor?.id ?? null;
  }

  /**
   * 把主题的当前正式版本钉进内容。
   *
   * 这一步存在的意义是让外行不必知道"依赖要钉版本"：向导只说"用哪套配色"，
   * 由服务端把 documentId + versionId 补上。内容自带依赖时以内容为准。
   */
  private async attachThemeDependency(
    content: JsonRecord,
    themeDocumentId?: string,
  ): Promise<JsonRecord> {
    if (!themeDocumentId) return content;
    if (Array.isArray(content.dependencies) && content.dependencies.length > 0) return content;
    const theme = await this.prisma.designDocument.findUnique({
      where: { id: themeDocumentId, status: 'published' },
      include: { currentPublishedVersion: true },
    });
    if (!theme?.currentPublishedVersion)
      throw new NotFoundException('主题文档不存在或尚未发布，无法钉住配色版本');
    return {
      ...content,
      dependencies: [{ documentId: theme.id, versionId: theme.currentPublishedVersion.id }],
    };
  }

  /**
   * 从效果配方起手，直接编译出可预览、可保存的内容。
   *
   * 这是创建向导里**唯一不花 AI 调用**的路径，而且成品质量是预先保证的（配方由
   * design-recipes.spec.ts 逐个对着每套配色验过门禁）。所以只要用户愿意从现成
   * 效果里挑一个，就完全不必等模型，也不可能拿到一个存不了的方案。
   *
   * 走的是和 AI 产出完全相同的编译与门禁——"配方里看到的样子"就是"发布出去的样子"。
   */
  async composeRecipe(input: { recipeId: string; themeDocumentId?: string }) {
    const recipe = findRecipe(input.recipeId);
    if (!recipe) throw new BadRequestException(`效果配方 ${input.recipeId} 不存在`);
    const tokens = input.themeDocumentId
      ? await this.themeTokens(input.themeDocumentId)
      : new Map<string, ResolvedToken>();
    const preview = await this.composePreview({
      kind: recipe.kind,
      content: recipe.sample(tokens),
      // 配色配方本身就是主题，钉依赖对它没有意义
      themeDocumentId: recipe.kind === 'theme' ? undefined : input.themeDocumentId,
    });
    return { ...preview, kind: recipe.kind };
  }

  /**
   * 让 AI 出几个方案（创建向导的"描述生成"入口）。
   *
   * 走任务队列而不是同步返回（方案 §15.3）：一次 LLM 调用要十几到几十秒，放进请求
   * 线程会把连接占死，而且没法重试或取消。
   *
   * 生成结果**不落库**：它是提案，不是资产——所以不占候选名额、不建任何文档。
   * 用户选中的那一份再经 `composeAndPublish` 走完整的
   * 草稿 → 候选 → 渲染校验 → 选择 → 发布链，审计记录落在真正发布的那一版上。
   */
  async composeGenerate(input: {
    kind: DesignKind;
    themeDocumentId?: string;
    intent: string;
    count?: number;
    recipeId?: string;
    reference?: JsonRecord;
  }) {
    if (input.intent.trim().length < 2) throw new BadRequestException('请多描述一点你想要的效果');
    const recipe = input.recipeId ? findRecipe(input.recipeId) : undefined;
    if (input.recipeId && !recipe)
      throw new BadRequestException(`效果配方 ${input.recipeId} 不存在`);
    const tokens = input.themeDocumentId
      ? await this.themeTokens(input.themeDocumentId)
      : new Map<string, ResolvedToken>();
    // 基底给模型一个强起点：有配方就用配方，否则用最小合法骨架
    const base = validateDesignContent(
      input.kind,
      await this.attachThemeDependency(
        recipe ? recipe.sample(tokens) : minimalComposeBase(input.kind),
        input.themeDocumentId,
      ),
    );
    const task = await this.prisma.designTask.create({
      data: {
        taskType: 'ai_compose',
        status: 'pending',
        input: canonicalJson({
          kind: input.kind,
          intent: input.intent.trim(),
          count: Math.min(Math.max(input.count ?? 3, 1), 3),
          baseContent: base,
          reference: input.reference,
        }),
      },
    });
    return { taskId: task.id };
  }

  /**
   * 一句话生成：只收意图，类别、配色、命名全由服务端与模型决定。
   *
   * 与 `composeGenerate` 的差别是**没有 kind**：调用方不必先教用户区分"配色/
   * 组件/动效"。服务端把三种基底一起交给模型，由它挑最贴合意图的那一种。
   *
   * 配色基底固定用内置靛蓝：主题类没有"最小骨架"（少一个 token 就不成体系），
   * 而随便选一套已有主题会让模型以为那是用户的选择。
   */
  async composeAuto(input: {
    intent: string;
    count?: number;
    reference?: JsonRecord;
    mediaResourceId?: string;
  }) {
    if (input.intent.trim().length < 2) throw new BadRequestException('请多描述一点你想要的效果');
    if (input.intent.length > 2_000)
      throw new BadRequestException('设计意图长度必须在 2 到 2000 个字符之间');
    const theme = await this.prisma.designDocument.findFirst({
      where: { kind: 'theme', status: 'published', currentPublishedVersionId: { not: null } },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, currentPublishedVersionId: true },
    });
    if (!theme)
      throw new BadRequestException(
        '还没有可用的配色方案。先在高级模式里装一套内置配色，再回来一句话生成。',
      );

    // 配色基底必须就是这套默认主题本身：三份基底共享同一套 token 词表，模型
    // 在组件里引用 {color.muted} 这类别名时才一定能解析到。此前用内置靛蓝当
    // 配色基底，模型照着它编别名，一旦默认主题缺同名 token，方案就会在门禁里
    // 反复失败。
    const themeVersionId = theme.currentPublishedVersionId;
    if (!themeVersionId)
      throw new BadRequestException('默认配色还没有正式版本，请先重新发布一套配色');
    const themeVersion = await this.prisma.designVersion.findUnique({
      where: { id: themeVersionId },
    });
    if (!themeVersion) throw new BadRequestException('默认配色的正式版本缺失，请重新发布一套配色');
    // 带素材时只给 component 基底：素材只能作为组件的媒体区，模型不该再选配色/动效。
    const mediaDescriptor = input.mediaResourceId
      ? await this.media.describe(input.mediaResourceId)
      : null;
    const bases: JsonRecord = mediaDescriptor
      ? {
          component: await this.attachThemeDependency(
            minimalMediaComposeBase(mediaDescriptor),
            theme.id,
          ),
        }
      : {
          theme: parseContent(themeVersion.content),
          component: await this.attachThemeDependency(minimalComposeBase('component'), theme.id),
          animation: await this.attachThemeDependency(minimalComposeBase('animation'), theme.id),
        };
    // 基底本身必须合法：否则模型会照着非法骨架抄，修复轮次全花在替它擦屁股上。
    for (const [baseKind, base] of Object.entries(bases)) {
      validateDesignContent(baseKind as DesignKind, base);
    }

    const task = await this.prisma.designTask.create({
      data: {
        taskType: 'ai_compose',
        status: 'pending',
        input: canonicalJson({
          mode: 'auto',
          intent: input.intent.trim(),
          count: Math.min(Math.max(input.count ?? 3, 1), 3),
          bases,
          themeDocumentId: theme.id,
          reference: input.reference,
        }),
      },
    });
    return { taskId: task.id, themeDocumentId: theme.id };
  }

  async getTask(taskId: string) {
    const task = await this.prisma.designTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException(`设计任务 ${taskId} 不存在`);
    return task;
  }

  private async processAiComposeTask(task: {
    id: string;
    input: string | null;
    leaseToken: string;
  }) {
    const input = parseContent(task.input ?? '{}');
    if (input.mode === 'auto') {
      if (!isAiAutoComposeInput(input)) throw new BadRequestException('AI 生成任务输入损坏');
      return this.processAutoComposeTask(task, input);
    }
    if (!isAiComposeInput(input)) throw new BadRequestException('AI 生成任务输入损坏');

    const candidates = await this.designAgent.generateCandidates({
      kind: input.kind,
      baseContent: input.baseContent,
      intent: input.intent,
      count: input.count,
      reference: isRecord(input.reference) ? input.reference : undefined,
    });

    const accepted: JsonRecord[] = [];
    const failures: Array<{ label: string; error: string }> = [];
    for (const [index, candidate] of candidates.entries()) {
      await this.assertTaskLease(task.id, task.leaseToken);
      const label = candidate.label || `方案 ${index + 1}`;
      const outcome = await this.composeCandidateWithRepair(
        input.kind,
        input.baseContent,
        candidate,
        { taskId: task.id, leaseToken: task.leaseToken },
      );
      if ('error' in outcome) {
        failures.push({ label, error: outcome.error });
        continue;
      }
      accepted.push({ label, rationale: candidate.rationale, content: outcome.content });
    }

    // 一个都没过才算失败。部分成功时用户仍然有可选的方案，失败的标签与原因
    // 摆在结果里——把整批判死会让一次格式失误吃掉全部产出。
    if (accepted.length === 0) {
      throw new BadRequestException(
        `设计 AI 未能生成任何合规方案：${failures
          .map((item) => `${item.label}（${item.error}）`)
          .join('；')}`,
      );
    }

    const completed = await this.prisma.designTask.updateMany({
      where: { id: task.id, status: 'running', leaseToken: task.leaseToken },
      data: {
        status: 'succeeded',
        result: canonicalJson({ candidates: accepted, failures }),
        finishedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (completed.count !== 1) return null;
    return this.prisma.designTask.findUnique({ where: { id: task.id } });
  }

  /**
   * 一句话生成的落地：模型给什么类别就按什么类别校验，一个都没过才算失败。
   *
   * 候选的 `kind` 必须随结果回传——发布时要用它选 schema，用户也不需要知道。
   */
  private async processAutoComposeTask(
    task: { id: string; input: string | null; leaseToken: string },
    input: AiAutoComposeInput,
  ) {
    const bases = input.bases as Record<string, JsonRecord | undefined>;
    const candidates = await this.designAgent.generateAutoCandidates({
      intent: input.intent,
      bases: {
        theme: bases.theme,
        component: bases.component,
        animation: bases.animation,
      },
      count: input.count,
      reference: isRecord(input.reference) ? input.reference : undefined,
    });

    const accepted: JsonRecord[] = [];
    const failures: Array<{ label: string; error: string }> = [];
    for (const [index, candidate] of candidates.entries()) {
      await this.assertTaskLease(task.id, task.leaseToken);
      const label = candidate.label || `方案 ${index + 1}`;
      const baseContent = bases[candidate.kind];
      if (!isRecord(baseContent)) {
        failures.push({ label, error: `不支持的类别：${candidate.kind}` });
        continue;
      }
      // 依赖一律钉成基底里的那一份。不能只依赖 `attachThemeDependency`
      // （它只在内容没有 dependencies 时才补）：模型抄错或编造 documentId 是真实
      // 存在的失败模式，而一句话生成只有一套默认配色，直接覆盖比让它在修复轮次
      // 里猜对更可靠。主题基底不带依赖时保持原样。
      const baseDependencies = baseContent.dependencies;
      let content: JsonRecord =
        Array.isArray(baseDependencies) && baseDependencies.length > 0
          ? { ...candidate.content, dependencies: baseDependencies }
          : candidate.kind === 'theme'
            ? candidate.content
            : await this.attachThemeDependency(candidate.content, input.themeDocumentId);
      // 素材是服务端锁定的结构：模型可以改声明，但不能改素材、骨架类型或 schema。
      // 修复轮返回的新内容也要重新锁，否则“删掉可选 media 字段”会静默通过校验。
      const lockContent =
        baseContent.media !== undefined
          ? (next: JsonRecord): JsonRecord => ({
              ...next,
              schemaVersion: 'aurum.component.v2',
              appliesTo: 'container',
              media: baseContent.media,
              // 依赖同样不能让修复轮改：编造的 versionId 会在 resolveFixtureContent
              // 里直接抛错，连修复机会都没有。
              ...(Array.isArray(baseDependencies) && baseDependencies.length > 0
                ? { dependencies: baseDependencies }
                : {}),
            })
          : undefined;
      if (lockContent) content = lockContent(content);
      const outcome = await this.composeCandidateWithRepair(
        candidate.kind,
        baseContent,
        { ...candidate, content },
        { taskId: task.id, leaseToken: task.leaseToken },
        lockContent,
      );
      if ('error' in outcome) {
        failures.push({ label, error: outcome.error });
        continue;
      }
      accepted.push({
        kind: candidate.kind,
        name: candidate.name,
        label,
        rationale: candidate.rationale,
        content: outcome.content,
      });
    }

    if (accepted.length === 0) {
      throw new BadRequestException(
        `设计 AI 未能生成任何合规方案：${failures
          .map((item) => `${item.label}（${item.error}）`)
          .join('；')}`,
      );
    }

    const completed = await this.prisma.designTask.updateMany({
      where: { id: task.id, status: 'running', leaseToken: task.leaseToken },
      data: {
        status: 'succeeded',
        result: canonicalJson({ candidates: accepted, failures }),
        finishedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (completed.count !== 1) return null;
    return this.prisma.designTask.findUnique({ where: { id: task.id } });
  }

  async cancelTask(taskId: string) {
    const task = await this.prisma.designTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException(`设计任务 ${taskId} 不存在`);
    if (!['pending', 'running'].includes(task.status))
      throw new BadRequestException('只有 pending 或 running 任务可以取消');
    const canceledPending = await this.prisma.designTask.updateMany({
      where: { id: taskId, status: 'pending' },
      data: {
        status: 'canceled',
        finishedAt: new Date(),
        errorCode: 'CANCELED_BY_OPERATOR',
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (canceledPending.count === 1) {
      if (task.taskType === 'ai_generate') {
        await this.cleanupCanceledAiCandidates(task.id, parseContent(task.input ?? '{}'));
      }
      return this.prisma.designTask.findUniqueOrThrow({ where: { id: taskId } });
    }
    const canceledRunning = await this.prisma.designTask.updateMany({
      where: { id: taskId, status: 'running' },
      data: {
        status: 'canceled',
        finishedAt: new Date(),
        errorCode: 'CANCELED_BY_OPERATOR',
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (canceledRunning.count !== 1) throw new ConflictException('任务状态已变化，无法取消');
    if (task.taskType === 'ai_generate') {
      await this.cleanupCanceledAiCandidates(task.id, parseContent(task.input ?? '{}'));
    }
    return this.prisma.designTask.findUniqueOrThrow({ where: { id: taskId } });
  }

  async retryTask(taskId: string) {
    const task = await this.prisma.designTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException(`设计任务 ${taskId} 不存在`);
    if (task.status !== 'failed') throw new BadRequestException('只有 failed 任务可以重试');
    if (task.retryCount >= 3) throw new BadRequestException('单个设计任务最多重试 3 次');
    return this.prisma.$transaction(async (tx) => {
      if (task.taskType === 'ai_generate') {
        const input = parseContent(task.input ?? '{}');
        if (!isAiTaskInput(input)) {
          throw new BadRequestException('AI 任务输入损坏');
        }
        await this.releaseUnusedAiTaskSlotsInTransaction(tx, task.id, input);
        const createdCount = await tx.candidateProposal.count({
          where: { generationKey: { startsWith: `${task.id}:` } },
        });
        await this.reserveCandidateSlots(
          tx,
          input.draftId,
          Math.max(0, input.count - createdCount),
        );
      }
      const retried = await tx.designTask.updateMany({
        where: { id: taskId, status: 'failed' },
        data: {
          status: 'pending',
          retryCount: { increment: 1 },
          errorCode: null,
          errorMessage: null,
          finishedAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
          candidateSlotsReleasedAt: null,
        },
      });
      if (retried.count !== 1) throw new ConflictException('任务状态已变化，无法重试');
      return tx.designTask.findUniqueOrThrow({ where: { id: taskId } });
    });
  }

  /**
   * 任务列表。审核台每 3 秒轮询一次，所以这里刻意只返回界面需要的字段：
   * `input` / `result` 是整行里最大的两列（AI 任务产物、预览键、门禁结论），
   * 跟着每次轮询整批返回纯属浪费。
   *
   * `draftId` 过滤：候选任务走关系；AI 生成任务的 candidateId 为空，
   * draftId 写在 input JSON 里（queueAiCandidates 的 canonicalJson），
   * 因此按 `"draftId":"<uuid>"` 精确匹配。UUID 足够独特，不会误伤其他草稿。
   */
  async listTasks(options: { status?: string; draftId?: string } = {}) {
    const where: Prisma.DesignTaskWhereInput = {};
    if (options.status) where.status = options.status;
    if (options.draftId) {
      where.OR = [
        { candidate: { draftId: options.draftId } },
        {
          candidateId: null,
          input: { contains: `"draftId":${JSON.stringify(options.draftId)}` },
        },
      ];
    }
    return this.prisma.designTask.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        taskType: true,
        status: true,
        candidateId: true,
        errorMessage: true,
        retryCount: true,
        createdAt: true,
      },
    });
  }

  async listCandidatePreviews(candidateId: string) {
    const candidate = await this.prisma.candidateProposal.findUnique({
      where: { id: candidateId },
      select: { id: true, previewSnapshots: { select: { viewport: true, createdAt: true } } },
    });
    if (!candidate) throw new NotFoundException(`Candidate ${candidateId} does not exist`);
    const task = await this.prisma.designTask.findFirst({
      where: { candidateId, taskType: 'render_validate', status: 'succeeded' },
      orderBy: { finishedAt: 'desc' },
      select: { result: true },
    });
    const result = parseContent(task?.result ?? '{}');
    const diffs = Array.isArray(result.previews) ? result.previews : [];
    // 按视口的规范顺序返回：关系行的默认顺序由 DB 决定，界面上会显得随机
    const ordered = [...candidate.previewSnapshots].sort(
      (left, right) =>
        VIEWPORT_ORDER.indexOf(left.viewport) - VIEWPORT_ORDER.indexOf(right.viewport),
    );
    return ordered.map((snapshot) => {
      const diff = diffs.find(
        (item): item is JsonRecord =>
          typeof item === 'object' &&
          item !== null &&
          !Array.isArray(item) &&
          item.viewport === snapshot.viewport,
      );
      return {
        viewport: snapshot.viewport,
        createdAt: snapshot.createdAt,
        changedPixels: typeof diff?.changedPixels === 'number' ? diff.changedPixels : null,
        snapshotUrl: `/api/design/candidates/${candidateId}/previews/${snapshot.viewport}?kind=snapshot`,
        diffUrl: diff
          ? `/api/design/candidates/${candidateId}/previews/${snapshot.viewport}?kind=diff`
          : null,
      };
    });
  }

  async getCandidatePreviewStoragePath(
    candidateId: string,
    viewport: string,
    kind: 'snapshot' | 'diff',
  ) {
    if (!['desktop', 'tablet', 'mobile'].includes(viewport))
      throw new BadRequestException('Unsupported preview viewport');
    const preview = await this.prisma.previewSnapshot.findFirst({
      where: { candidateId, viewport },
      select: { storagePath: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!preview?.storagePath) throw new NotFoundException('Preview image does not exist');
    if (kind === 'snapshot') return preview.storagePath;
    const task = await this.prisma.designTask.findFirst({
      where: { candidateId, taskType: 'render_validate', status: 'succeeded' },
      orderBy: { finishedAt: 'desc' },
      select: { result: true },
    });
    const result = parseContent(task?.result ?? '{}');
    const previews = Array.isArray(result.previews) ? result.previews : [];
    const diff = previews.find(
      (item): item is JsonRecord =>
        typeof item === 'object' &&
        item !== null &&
        !Array.isArray(item) &&
        item.viewport === viewport,
    );
    if (typeof diff?.diffKey !== 'string')
      throw new NotFoundException('Preview diff does not exist');
    return diff.diffKey;
  }

  async listReadyDrafts() {
    return this.prisma.designDraft.findMany({
      where: { status: 'ready' },
      include: {
        document: { select: { id: true, name: true, kind: true, currentPublishedVersionId: true } },
        candidates: {
          where: { status: 'selected' },
          select: { id: true, label: true, status: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
  }

  private async processAiGenerationTask(task: {
    id: string;
    input: string | null;
    leaseToken: string;
  }) {
    const input = parseContent(task.input ?? '{}');
    if (!isAiTaskInput(input)) {
      throw new BadRequestException('AI 任务输入损坏');
    }
    const aiInput = input;
    const draft = await this.getEditableDraft(aiInput.draftId);
    const kind = draft.document.kind as DesignKind;
    const baseContent = parseContent(draft.baseVersion.content);
    const candidates = await this.designAgent.generateCandidates({
      kind,
      baseContent,
      intent: aiInput.intent,
      count: aiInput.count,
      // 参考档案此前从未进入模型，所以"粘贴图片生成"对结果零影响。
      reference: await this.loadReferenceProfile(draft.sessionId),
    });
    await this.assertTaskLease(task.id, task.leaseToken);
    const createdIds: string[] = [];
    const failures: Array<{ label: string; error: string }> = [];
    for (const [index, candidate] of candidates.entries()) {
      await this.assertTaskLease(task.id, task.leaseToken);
      const label = candidate.label || `AI 方案 ${index + 1}`;
      const outcome = await this.createCandidateWithRepair({
        draftId: draft.id,
        taskId: task.id,
        leaseToken: task.leaseToken,
        kind,
        baseContent,
        label,
        rationale: candidate.rationale,
        content: candidate.content,
        generationKey: `${task.id}:${index}`,
      });
      if ('error' in outcome) {
        failures.push({ label, error: outcome.error });
        continue;
      }
      createdIds.push(outcome.id);
      await this.assertTaskLease(task.id, task.leaseToken);
      await this.renderAndValidateCandidate(outcome.id);
    }
    // 一个候选都没建起来才算任务失败。部分成功时运营仍能看到可用的方案，
    // 失败的标签与原因摆在任务结果里——把整批判死会让一次格式错误吃掉全部结果。
    if (createdIds.length === 0) {
      throw new BadRequestException(
        `设计 AI 未能生成任何合规候选：${failures
          .map((item) => `${item.label}（${item.error}）`)
          .join('；')}`,
      );
    }
    const completed = await this.prisma.$transaction(async (tx) => {
      const update = await tx.designTask.updateMany({
        where: { id: task.id, status: 'running', leaseToken: task.leaseToken },
        data: {
          status: 'succeeded',
          result: canonicalJson({ candidateIds: createdIds, failures }),
          finishedAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
          candidateSlotsReleasedAt: new Date(),
        },
      });
      if (update.count !== 1) return false;
      const createdCount = await tx.candidateProposal.count({
        where: { generationKey: { startsWith: `${task.id}:` } },
      });
      await this.releaseCandidateSlots(tx, draft.id, Math.max(0, aiInput.count - createdCount));
      return true;
    });
    if (!completed) {
      const current = await this.prisma.designTask.findUnique({
        where: { id: task.id },
        select: { status: true },
      });
      if (current?.status === 'canceled') await this.cleanupCanceledAiCandidates(task.id, aiInput);
      return null;
    }
    return this.prisma.designTask.findUnique({ where: { id: task.id } });
  }

  async createReferenceDraft(
    documentId: string,
    profile: JsonRecord,
    source: string,
    retentionUntil?: Date,
    requiresApproval = false,
  ) {
    const serializedProfile = canonicalJson(profile);
    if (
      serializedProfile.length > 100_000 ||
      /<\s*script|javascript\s*:/i.test(serializedProfile) ||
      source.length > 2_048
    ) {
      throw new BadRequestException('参考档案不符合安全或大小限制');
    }
    const document = await this.prisma.designDocument.findUnique({
      where: { id: documentId, status: 'published' },
      include: { currentPublishedVersion: true },
    });
    if (!document?.currentPublishedVersion)
      throw new NotFoundException('目标设计文档不存在或尚未发布');
    if (document.kind !== 'theme' && document.kind !== 'foundation') {
      throw new BadRequestException('参考样式只能用于创建主题或基础规范草稿');
    }
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.changeSession.create({
        data: {
          request: '从样式参考创建草稿',
          status: requiresApproval ? 'pending_reference_review' : 'open',
          contextSnapshot: canonicalJson({ source, profileHash: contentHash(serializedProfile) }),
        },
      });
      await tx.referenceSnapshot.create({
        data: {
          sessionId: session.id,
          sourceUrl: source,
          contentHash: contentHash(serializedProfile),
          policy: 'inspiration_only',
          retentionUntil,
          metadata: serializedProfile,
        },
      });
      const draft = await tx.designDraft.create({
        data: {
          sessionId: session.id,
          documentId,
          baseVersionId: document.currentPublishedVersionId!,
          status: requiresApproval ? 'pending_reference_review' : 'editing',
        },
      });
      await tx.designDraftVersion.create({
        data: { draftId: draft.id, versionId: document.currentPublishedVersionId! },
      });
      return {
        sessionId: session.id,
        draftId: draft.id,
        referencePolicy: 'inspiration_only',
        requiresApproval,
      };
    });
  }

  async approveReferenceDraft(draftId: string) {
    const draft = await this.prisma.designDraft.findUnique({
      where: { id: draftId },
      include: { session: true },
    });
    if (
      !draft ||
      draft.status !== 'pending_reference_review' ||
      draft.session?.status !== 'pending_reference_review'
    ) {
      throw new BadRequestException('该草稿不处于待参考审核状态');
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.changeSession.update({ where: { id: draft.sessionId! }, data: { status: 'open' } });
      return tx.designDraft.update({
        where: { id: draftId },
        data: { status: 'editing', lockVersion: { increment: 1 } },
      });
    });
  }

  async cleanupExpiredReferenceSnapshots() {
    return this.prisma.$transaction(async (tx) => {
      const expired = await tx.referenceSnapshot.findMany({
        where: { retentionUntil: { not: null, lte: new Date() } },
        select: { id: true, sessionId: true },
      });
      if (!expired.length) return { count: 0 };
      await tx.referenceSnapshot.deleteMany({
        where: { id: { in: expired.map((item) => item.id) } },
      });
      const sessionIds = [
        ...new Set(expired.map((item) => item.sessionId).filter(Boolean)),
      ] as string[];
      if (sessionIds.length) {
        await tx.changeSession.updateMany({
          where: { id: { in: sessionIds } },
          data: { contextSnapshot: null },
        });
      }
      return { count: expired.length };
    });
  }

  getReadonlyToolManifest() {
    return {
      protocol: 'aurum.design.readonly.v1',
      policy: 'published_assets_only',
      tools: [
        {
          name: 'search_design_assets',
          method: 'GET',
          path: '/api/design/published/search?q={query}&kind={kind}',
          description: '检索已发布设计资产摘要',
        },
        {
          name: 'get_design_asset',
          method: 'GET',
          path: '/api/design/published/{idOrSlug}',
          description: '读取一个已发布版本及其固定依赖',
        },
      ],
      excluded: ['drafts', 'candidates', 'change_sets', 'reference_snapshots', 'write_operations'],
    };
  }

  async handleMcpRequest(request: {
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
    id?: string | number | null;
  }) {
    const id = request.id ?? null;
    if (request.method === 'initialize')
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'aurum-design', version: '1.0.0' },
        },
      };
    if (request.method === 'tools/list')
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'search_design_assets',
              description: 'Search published Aurum design assets.',
              inputSchema: {
                type: 'object',
                properties: { query: { type: 'string' }, kind: { type: 'string' } },
              },
            },
            {
              name: 'get_design_asset',
              description: 'Get a published Aurum design asset and pinned dependencies.',
              inputSchema: {
                type: 'object',
                properties: { idOrSlug: { type: 'string' } },
                required: ['idOrSlug'],
              },
            },
          ],
        },
      };
    if (request.method === 'tools/call') {
      const name = request.params?.name;
      const args = request.params?.arguments ?? {};
      if (name === 'search_design_assets') {
        const result = await this.searchPublished(
          typeof args.query === 'string' ? args.query : undefined,
          typeof args.kind === 'string' ? args.kind : undefined,
        );
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
        };
      }
      if (name === 'get_design_asset' && typeof args.idOrSlug === 'string') {
        const result = await this.getPublishedAsset(args.idOrSlug);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
        };
      }
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Unknown tool or invalid arguments' },
      };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  }

  /**
   * 「校验 → 失败就把错误回喂模型修」的公共循环。
   *
   * 两处用它：写候选（结构校验 + 依赖检查）与对话生成提案（结构校验 + 发布门禁）。
   * 抽出来是因为这个循环的边界条件很容易写错——重试预算、哪类错误该冒泡、修复调用
   * 自己失败怎么办——错一次不是"整批任务判死"就是"白烧一次 AI 调用"。
   */
  private async repairUntilValid<T>(args: {
    kind: DesignKind;
    baseContent: JsonRecord;
    content: JsonRecord;
    taskId: string;
    leaseToken: string;
    /** 返回 `{ value }` 表示通过；返回 `{ error }` 表示是模型能自己修的内容问题 */
    attempt: (content: JsonRecord) => Promise<{ value: T } | { error: string }>;
    /**
     * 结构性锁定：服务端权威字段（素材、schema、骨架类型、依赖）在首轮与每轮修复后
     * 都要重新覆盖。不能只锁首轮——模型在修复时返回完整内容，顺手删掉 media 是
     * 真实存在的失败模式，而 media 是可选字段，删掉后校验仍会通过。
     */
    lockContent?: (content: JsonRecord) => JsonRecord;
  }): Promise<{ value: T; content: JsonRecord } | { error: string }> {
    // 模型输出先做结构归位：把 hover/active 之类的同级 variant 折进 states，
    // 再做媒体/依赖锁定。放在这里是因为只有 AI 输出会走这个循环。
    const lock = (value: JsonRecord) => {
      const normalized = args.kind === 'component' ? normalizeAiComponentContent(value) : value;
      return args.lockContent ? args.lockContent(normalized) : normalized;
    };
    let content = lock(args.content);
    let lastError = '模型返回的方案不符合规范';
    for (let round = 0; round <= AI_REPAIR_ATTEMPTS; round += 1) {
      const outcome = await args.attempt(content);
      if ('value' in outcome) return { value: outcome.value, content };
      lastError = outcome.error;
      if (round === AI_REPAIR_ATTEMPTS) break;
      await this.assertTaskLease(args.taskId, args.leaseToken);
      // 修复调用本身失败（AI 未配置、网络错误）不该让候选判死，只是没有下一次机会。
      const repaired = await this.designAgent
        .repairCandidate({
          kind: args.kind,
          baseContent: args.baseContent,
          content,
          error: lastError,
        })
        .catch(() => null);
      if (!repaired) break;
      content = lock(repaired);
    }
    return { error: lastError };
  }

  /**
   * 建候选，内容被校验拒绝时交给模型修。
   *
   * 只有"内容不合规"值得重试：`validateDesignContent` 与依赖校验抛的都是
   * `BadRequestException`，那是模型能自己修的；租约、数据库、并发冲突重试也是
   * 白花一次 AI 调用，直接冒泡。
   */
  private async createCandidateWithRepair(args: {
    draftId: string;
    taskId: string;
    leaseToken: string;
    kind: DesignKind;
    baseContent: JsonRecord;
    label: string;
    rationale: string;
    content: JsonRecord;
    generationKey: string;
  }): Promise<{ id: string } | { error: string }> {
    const outcome = await this.repairUntilValid<string>({
      kind: args.kind,
      baseContent: args.baseContent,
      content: args.content,
      taskId: args.taskId,
      leaseToken: args.leaseToken,
      attempt: async (content) => {
        try {
          const created = await this.createCandidate(
            args.draftId,
            {
              label: args.label,
              rationale: args.rationale,
              content,
              generationKey: args.generationKey,
            },
            { slotAlreadyReserved: true, taskId: args.taskId, leaseToken: args.leaseToken },
          );
          return { value: created.id };
        } catch (error) {
          if (!(error instanceof BadRequestException)) throw error;
          return { error: error.message };
        }
      },
    });
    return 'value' in outcome ? { id: outcome.value } : { error: outcome.error };
  }

  /**
   * 对话生成的提案：结构校验 + 发布门禁都过才算可用。
   *
   * 门禁也纳入重试：给出一组对比度不足的配色是模型的常见失误，而它完全能自己修好。
   * 不纳入的话，用户会在画布上看到三个"好看但存不了"的方案。
   */
  private async composeCandidateWithRepair(
    kind: DesignKind,
    baseContent: JsonRecord,
    candidate: GeneratedDesignCandidate,
    context: { taskId: string; leaseToken: string },
    lockContent?: (content: JsonRecord) => JsonRecord,
  ): Promise<{ content: JsonRecord } | { error: string }> {
    const outcome = await this.repairUntilValid<JsonRecord>({
      kind,
      baseContent,
      content: candidate.content,
      taskId: context.taskId,
      leaseToken: context.leaseToken,
      lockContent,
      attempt: async (content) => {
        let validated: JsonRecord;
        try {
          validated = validateDesignContent(kind, content);
        } catch (error) {
          if (!(error instanceof BadRequestException)) throw error;
          return { error: error.message };
        }
        let validation: AssetValidation;
        try {
          ({ validation } = await this.resolveAndEvaluate(kind, validated));
        } catch (error) {
          // 依赖版本不存在/循环同样是模型能自己修的内容问题；不能让它直接
          // 冒泡成整个生成任务失败，否则一个编造的 versionId 会吃掉整批方案。
          if (!(error instanceof BadRequestException)) throw error;
          return { error: error.message };
        }
        if (validation.errors.length > 0) return { error: validation.errors.join('; ') };
        return { value: validated };
      },
    });
    return 'value' in outcome ? { content: outcome.value } : { error: outcome.error };
  }

  /** 解析依赖 + 跑发布门禁。预览、一键发布、对话生成三处共用。 */
  private async resolveAndEvaluate(kind: DesignKind, content: JsonRecord) {
    const resolved = await resolveFixtureContent(this.prisma, content);
    const tokens = collectWithFixtureDependencies(resolved);
    const validation = validateAssetAgainstTokens(kind, resolved, tokens, evaluateContrast);
    return { resolved, tokens, validation };
  }

  /** 读取主题当前正式版本的 token 表，供配方解析别名。 */
  private async themeTokens(themeDocumentId: string): Promise<TokenTable> {
    const theme = await this.prisma.designDocument.findUnique({
      where: { id: themeDocumentId, status: 'published' },
      include: { currentPublishedVersion: true },
    });
    if (!theme?.currentPublishedVersion)
      throw new NotFoundException('主题文档不存在或尚未发布，无法解析配色');
    return collectTokenTable([parseContent(theme.currentPublishedVersion.content)]);
  }

  /**
   * 取出草稿关联的参考档案，供提示词使用。
   *
   * `createReferenceDraft` 只写 ChangeSession + ReferenceSnapshot + 空草稿，
   * 参考内容此前**从未**进入模型——所以"粘贴图片生成"对结果零影响。档案是
   * 不可信数据，进提示词前只作视觉意图（方案 §15.8）。
   */
  private async loadReferenceProfile(sessionId: string | null): Promise<JsonRecord | undefined> {
    if (!sessionId) return undefined;
    const snapshot = await this.prisma.referenceSnapshot.findFirst({
      where: { sessionId },
      orderBy: { capturedAt: 'desc' },
      select: { metadata: true },
    });
    if (!snapshot?.metadata) return undefined;
    try {
      const parsed: unknown = JSON.parse(snapshot.metadata);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async getEditableDraft(draftId: string) {
    const draft = await this.prisma.designDraft.findUnique({
      where: { id: draftId },
      include: { document: true, baseVersion: true },
    });
    if (!draft) throw new NotFoundException(`草稿 ${draftId} 不存在`);
    if (draft.status !== 'editing')
      throw new BadRequestException('草稿已锁定或已发布，不能新增候选方案');
    if (draft.expiresAt && draft.expiresAt <= new Date())
      throw new BadRequestException('草稿已过期，请重新创建');
    assertDraftCurrent(draft, draft.document);
    return draft;
  }

  private async assertTaskLease(taskId: string, leaseToken: string) {
    const task = await this.prisma.designTask.findFirst({
      where: { id: taskId, status: 'running', leaseToken, leaseExpiresAt: { gt: new Date() } },
      select: { id: true },
    });
    if (!task) throw new ConflictException('任务已取消、超时或被其他工作进程接管');
  }

  private async extendTaskLease(taskId: string, leaseToken: string) {
    await this.prisma.designTask.updateMany({
      where: { id: taskId, status: 'running', leaseToken },
      data: { leaseExpiresAt: new Date(Date.now() + TASK_LEASE_MS) },
    });
  }

  private async recoverExpiredTasks() {
    const expired = { status: 'running', leaseExpiresAt: { not: null, lte: new Date() } } as const;
    const terminalAiTasks = await this.prisma.designTask.findMany({
      where: { ...expired, taskType: 'ai_generate', retryCount: { gte: 3 } },
      select: { id: true, input: true },
    });
    await this.prisma.designTask.updateMany({
      where: { ...expired, retryCount: { lt: 3 } },
      data: {
        status: 'pending',
        retryCount: { increment: 1 },
        errorCode: 'LEASE_EXPIRED',
        errorMessage: 'Worker lease expired; queued for retry',
        startedAt: null,
        finishedAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    await this.prisma.designTask.updateMany({
      where: { ...expired, retryCount: { gte: 3 } },
      data: {
        status: 'failed',
        errorCode: 'LEASE_EXPIRED',
        errorMessage: 'Worker lease expired after maximum retries',
        finishedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    for (const task of terminalAiTasks) {
      await this.releaseUnusedAiTaskSlots(task.id, parseContent(task.input ?? '{}'));
    }
  }

  private async reserveCandidateSlots(
    tx: Prisma.TransactionClient,
    draftId: string,
    count: number,
  ) {
    if (count === 0) return;
    const reserved = await tx.designDraft.updateMany({
      where: {
        id: draftId,
        status: 'editing',
        candidateSlotsUsed: { lte: ACTIVE_CANDIDATE_LIMIT - count },
      },
      data: { candidateSlotsUsed: { increment: count } },
    });
    if (reserved.count !== 1) {
      throw new BadRequestException(`草稿最多保留 ${ACTIVE_CANDIDATE_LIMIT} 个候选方案`);
    }
  }

  private async releaseCandidateSlots(
    tx: Prisma.TransactionClient,
    draftId: string,
    count: number,
  ) {
    if (count === 0) return;
    const released = await tx.designDraft.updateMany({
      where: { id: draftId, candidateSlotsUsed: { gte: count } },
      data: { candidateSlotsUsed: { decrement: count } },
    });
    if (released.count !== 1) throw new ConflictException('候选名额状态不一致');
  }

  private async releaseUnusedAiTaskSlots(taskId: string, input: JsonRecord) {
    if (!isAiTaskInput(input)) return;
    await this.prisma.$transaction(async (tx) => {
      await this.releaseUnusedAiTaskSlotsInTransaction(tx, taskId, input);
    });
  }

  private async releaseUnusedAiTaskSlotsInTransaction(
    tx: Prisma.TransactionClient,
    taskId: string,
    input: AiTaskInput,
  ) {
    const claimed = await tx.designTask.updateMany({
      where: {
        id: taskId,
        candidateSlotsReleasedAt: null,
        status: { in: ['failed', 'succeeded'] },
      },
      data: { candidateSlotsReleasedAt: new Date() },
    });
    if (claimed.count !== 1) return;
    const createdCount = await tx.candidateProposal.count({
      where: { generationKey: { startsWith: `${taskId}:` } },
    });
    await this.releaseCandidateSlots(tx, input.draftId, Math.max(0, input.count - createdCount));
  }

  private async cleanupCanceledAiCandidates(taskId: string, input: JsonRecord) {
    if (!isAiTaskInput(input)) return;
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.designTask.updateMany({
        where: { id: taskId, status: 'canceled', candidateSlotsReleasedAt: null },
        data: { candidateSlotsReleasedAt: new Date() },
      });
      if (claimed.count !== 1) return;
      const retained = await tx.candidateProposal.count({
        where: {
          generationKey: { startsWith: `${taskId}:` },
          status: { in: ['selected', 'published'] },
        },
      });
      await tx.candidateProposal.deleteMany({
        where: {
          generationKey: { startsWith: `${taskId}:` },
          status: { in: ['generated', 'rendered', 'validated'] },
        },
      });
      await this.releaseCandidateSlots(tx, input.draftId, Math.max(0, input.count - retained));
    });
  }
}

function buildStructuredDiff(before: JsonRecord, after: JsonRecord) {
  const changes: Array<{
    path: string;
    type: 'add' | 'remove' | 'replace';
    before?: unknown;
    after?: unknown;
  }> = [];
  compare(before, after, '', changes);
  if (changes.length > 500) throw new BadRequestException('候选方案改动过大，请拆分为更小的变更');
  return changes;
}

function compare(
  before: unknown,
  after: unknown,
  path: string,
  changes: Array<{
    path: string;
    type: 'add' | 'remove' | 'replace';
    before?: unknown;
    after?: unknown;
  }>,
) {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  if (isJsonRecord(before) && isJsonRecord(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const childPath = `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      if (!(key in before)) changes.push({ path: childPath, type: 'add', after: after[key] });
      else if (!(key in after))
        changes.push({ path: childPath, type: 'remove', before: before[key] });
      else compare(before[key], after[key], childPath, changes);
    }
    return;
  }
  changes.push({ path: path || '/', type: 'replace', before, after });
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAiTaskInput(value: JsonRecord): value is AiTaskInput {
  return (
    typeof value.draftId === 'string' &&
    typeof value.intent === 'string' &&
    typeof value.count === 'number' &&
    Number.isInteger(value.count) &&
    value.count > 0
  );
}

function isAiComposeInput(value: JsonRecord): value is AiComposeInput {
  return (
    typeof value.kind === 'string' &&
    typeof value.intent === 'string' &&
    typeof value.count === 'number' &&
    Number.isInteger(value.count) &&
    value.count > 0 &&
    isRecord(value.baseContent)
  );
}
function isAiAutoComposeInput(value: JsonRecord): value is AiAutoComposeInput {
  return (
    value.mode === 'auto' &&
    typeof value.intent === 'string' &&
    typeof value.count === 'number' &&
    Number.isInteger(value.count) &&
    value.count > 0 &&
    isRecord(value.bases) &&
    typeof value.themeDocumentId === 'string'
  );
}

/**
 * 素材组件的基底。
 *
 * 媒体区由服务端骨架渲染（figure + 封面 + 文案），模型负责画框的圆角、阴影、
 * 比例、滤镜等声明；media 字段本身在任务处理阶段会被强制覆盖回这份基底。
 */
function minimalMediaComposeBase(media: MediaDescriptor): JsonRecord {
  // 按目标画框高度反推最大宽度：竖图如果直接按 560px 宽出图会高到 700px+，
  // 预览和卡片都会把底部文案裁掉。极端比例再夹到 0.5–2，避免出现 40px 宽的卡片。
  const rawRatio =
    media.width && media.height && media.width > 0 && media.height > 0
      ? media.width / media.height
      : 1.6;
  const ratio = Number(Math.min(2, Math.max(0.5, rawRatio)).toFixed(3));
  const maxWidth = Math.min(560, Math.round(400 * ratio));
  return {
    schemaVersion: 'aurum.component.v2',
    componentType: 'media-showcase',
    appliesTo: 'container',
    media,
    variants: {
      default: {
        declarations: {
          'aspect-ratio': ratio,
          'max-width': `${maxWidth}px`,
          'border-radius': '16px',
          'background-color': '#0f172a',
          color: '#ffffff',
          'box-shadow': '0 18px 50px rgba(15, 23, 42, 0.35)',
        },
      },
    },
  };
}

/**
 * 没有指定效果配方时的最小合法骨架。
 *
 * 配色类**刻意不给兜底**：随便挑一套配色当基底，会让模型以为那是用户选的方案，
 * 结果生成一堆基于错误配色的效果。要求调用方显式给配方，比猜一个更诚实。
 */
function minimalComposeBase(kind: DesignKind): JsonRecord {
  if (kind === 'component') {
    return {
      schemaVersion: 'aurum.component.v2',
      componentType: 'custom-component',
      appliesTo: 'container',
      variants: {
        default: {
          declarations: {
            'background-color': '#ffffff',
            color: '#0f172a',
            'border-radius': '8px',
            padding: '12px',
          },
        },
      },
    };
  }
  if (kind === 'animation') {
    return {
      schemaVersion: 'aurum.animation.v1',
      animationType: 'custom-motion',
      trigger: 'on-enter',
      keyframes: [
        { at: 'from', declarations: { opacity: '0' } },
        { at: 'to', declarations: { opacity: '1' } },
      ],
      timing: { duration: '300ms', easing: 'ease-out', fillMode: 'both' },
      reducedMotion: { declarations: { opacity: '1' } },
    };
  }
  throw new BadRequestException(
    kind === 'theme' || kind === 'foundation'
      ? '配色类资产需要先选一套配色方案'
      : `${kind} 暂不支持对话生成`,
  );
}
function isUniqueError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * 渲染期注入的依赖内容，供 Tailwind 导出的 token 展平使用。
 */
function getFixtureDependencyContents(content: JsonRecord): JsonRecord[] {
  const injected = content.__aurumFixtureDependencies;
  if (!Array.isArray(injected)) return [];
  return injected.flatMap((dependency) =>
    isJsonRecord(dependency) && isJsonRecord(dependency.content) ? [dependency.content] : [],
  );
}

function buildTailwindExport(content: JsonRecord): string {
  // 用 flattenTokenLeaves 而不是旧的 flattenTokens：旧版只返回 $value、丢掉
  // $type，因此无法判断复合类型该如何序列化，只能把非标量整个 JSON.stringify 出去。
  const leaves = [
    ...flattenTokenLeaves(content.tokens),
    ...getFixtureDependencyContents(content).flatMap((dependency) =>
      flattenTokenLeaves(dependency.tokens),
    ),
  ];
  const values = Object.fromEntries(
    leaves.map((leaf) => [leaf.path.replaceAll('.', '-'), `var(${toVarName(leaf.path)})`]),
  );
  return `export default {\n  theme: { extend: { aurum: ${JSON.stringify(values, null, 2)} } },\n};\n`;
}

function buildMarkdownExport(asset: {
  document: { name: string; slug: string; kind: string };
  version: { number: number; contentHash: string };
  content: JsonRecord;
  dependencies: unknown[];
}): string {
  return `# ${asset.document.name}\n\n- Kind: ${asset.document.kind}\n- Slug: ${asset.document.slug}\n- Version: v${asset.version.number}\n- Content hash: ${asset.version.contentHash}\n- Fixed dependencies: ${asset.dependencies.length}\n\n## Specification\n\n\`\`\`json\n${JSON.stringify(asset.content, null, 2)}\n\`\`\`\n`;
}
