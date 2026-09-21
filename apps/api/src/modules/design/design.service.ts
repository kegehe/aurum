import { createHash, randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getStylePackDependencies, validateDesignContent } from './design-schema';
import { CreateCandidateDto } from './dto/create-candidate.dto';
import { CreateDesignDocumentDto } from './dto/create-design-document.dto';
import type { DesignKind, DomainPatch, JsonRecord } from './design.types';
import { DesignAgentService } from './design-agent.service';
import { GenerateAiCandidatesDto } from './dto/generate-ai-candidates.dto';
import { ControlledRendererService } from './controlled-renderer.service';

const ACTIVE_CANDIDATE_LIMIT = 3;
const POLICY_VERSION = 'aurum.publish.v1';
const TASK_LEASE_MS = 5 * 60 * 1000;
type AiTaskInput = JsonRecord & { draftId: string; intent: string; count: number };

@Injectable()
export class DesignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly designAgent: DesignAgentService,
    private readonly renderer: ControlledRendererService,
  ) {}

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

  async exportPublishedAsset(idOrSlug: string, format: 'json' | 'css' | 'tailwind' | 'markdown') {
    const asset = await this.getPublishedAsset(idOrSlug);
    if (format === 'json') return { format, content: asset.content };
    if (format === 'css') return { format, content: buildCssExport(asset.content) };
    if (format === 'tailwind') return { format, content: buildTailwindExport(asset.content) };
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
    const document = await this.prisma.designDocument.findUnique({
      where: { id },
      include: {
        currentPublishedVersion: true,
        versions: { orderBy: { versionNumber: 'desc' }, take: 30 },
        dependenciesFrom: { include: { toDocument: true, toVersion: true } },
      },
    });
    if (!document) throw new NotFoundException(`设计文档 ${id} 不存在`);
    return document;
  }

  async createDocument(dto: CreateDesignDocumentDto) {
    const content = validateDesignContent(dto.kind, dto.content);
    const encoded = canonicalJson(content);
    const hash = contentHash(encoded);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const document = await tx.designDocument.create({
          data: {
            slug: dto.slug,
            name: dto.name.trim(),
            kind: dto.kind,
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
        await this.createDependencies(tx, dto.kind, content, document.id, version.id);
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
    await this.assertDependenciesPublished(
      draft.document.kind as DesignKind,
      content,
      draft.documentId,
    );
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
              dependencyChange: draft.document.kind === 'style_pack',
            }),
            status: 'generated',
            generationKey: dto.generationKey,
          },
        });
        await tx.validationRun.create({
          data: {
            candidateId: candidate.id,
            status: 'succeeded',
            policyVersion: POLICY_VERSION,
            result: canonicalJson({
              schema: 'passed',
              dependencies: 'passed',
              note: '第一阶段仅执行结构化规范与依赖校验',
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
    await this.ensureDraftExists(draftId);
    return this.prisma.candidateProposal.findMany({
      where: { draftId },
      include: { validationRuns: { orderBy: { createdAt: 'desc' } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async selectCandidate(candidateId: string) {
    const candidate = await this.prisma.candidateProposal.findUnique({
      where: { id: candidateId },
      include: { draft: { include: { document: true } }, validationRuns: true },
    });
    if (!candidate) throw new NotFoundException(`候选方案 ${candidateId} 不存在`);
    if (candidate.status !== 'validated')
      throw new BadRequestException('只有通过校验的候选方案可以被选择');
    if (!candidate.validationRuns.some((run) => run.status === 'succeeded')) {
      throw new BadRequestException('候选方案缺少成功的校验记录');
    }
    this.assertDraftCurrent(candidate.draft, candidate.draft.document);

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

  async createChangeSet(draftIds: string[]) {
    const ids = [...new Set(draftIds)].filter(Boolean);
    if (ids.length < 2) throw new BadRequestException('跨文档发布至少需要两个草稿');
    const drafts = await this.prisma.designDraft.findMany({
      where: { id: { in: ids } },
      include: {
        document: true,
        candidates: { where: { status: 'selected' }, include: { validationRuns: true } },
      },
    });
    if (drafts.length !== ids.length) throw new NotFoundException('至少一个草稿不存在');
    if (new Set(drafts.map((draft) => draft.documentId)).size !== drafts.length) {
      throw new BadRequestException('一个 ChangeSet 不能包含同一设计文档的多个草稿');
    }
    for (const draft of drafts) {
      if (
        draft.status !== 'ready' ||
        draft.document.currentPublishedVersionId !== draft.baseVersionId
      ) {
        throw new ConflictException(`草稿 ${draft.id} 尚未准备好或基准版本已过期`);
      }
      if (!draft.candidates[0]?.validationRuns.some((run) => run.status === 'succeeded')) {
        throw new BadRequestException(`草稿 ${draft.id} 没有已校验且被选择的候选方案`);
      }
    }
    const anchor = drafts[0];
    const memberships = await this.prisma.changeSetDraft.findMany({
      where: { draftId: { in: ids } },
      include: { changeSet: { select: { draftId: true, status: true } } },
    });
    if (
      memberships.some(
        (membership) =>
          membership.changeSet.draftId !== anchor.id || membership.changeSet.status === 'published',
      )
    ) {
      throw new ConflictException('至少一个草稿已经属于其他 ChangeSet，不能重复组装发布事务');
    }
    return this.prisma.$transaction(async (tx) => {
      const changeSet = await tx.changeSet.upsert({
        where: { draftId: anchor.id },
        update: { status: 'ready' },
        create: { draftId: anchor.id, status: 'ready' },
      });
      await tx.changeSetDraft.deleteMany({ where: { changeSetId: changeSet.id } });
      await tx.changeSetItem.deleteMany({ where: { changeSetId: changeSet.id } });
      for (const draft of drafts) {
        const candidate = draft.candidates[0];
        await tx.changeSetDraft.create({ data: { changeSetId: changeSet.id, draftId: draft.id } });
        await tx.changeSetItem.create({
          data: {
            changeSetId: changeSet.id,
            documentId: draft.documentId,
            baseVersionId: draft.baseVersionId,
            candidateId: candidate.id,
            selectedPatch: candidate.patch,
            status: 'selected',
          },
        });
      }
      return tx.changeSet.findUniqueOrThrow({
        where: { id: changeSet.id },
        include: { drafts: true, items: true },
      });
    });
  }

  async publishChangeSet(changeSetId: string) {
    const changeSet = await this.prisma.changeSet.findUnique({
      where: { id: changeSetId },
      include: {
        drafts: {
          include: {
            draft: {
              include: {
                document: true,
              },
            },
          },
        },
        items: { include: { candidate: { include: { validationRuns: true } } } },
      },
    });
    if (!changeSet) throw new NotFoundException(`ChangeSet ${changeSetId} 不存在`);
    if (changeSet.status === 'published') return changeSet;
    if (changeSet.drafts.length < 2) throw new BadRequestException('单文档草稿请使用草稿发布接口');
    const members = changeSet.drafts.map((member) => member.draft);
    if (changeSet.items.length !== members.length) {
      throw new ConflictException('ChangeSet 条目不完整，无法发布');
    }
    for (const draft of members) {
      const item = changeSet.items.find((entry) => entry.documentId === draft.documentId);
      const candidate = item?.candidate;
      if (
        draft.status !== 'ready' ||
        draft.document.currentPublishedVersionId !== draft.baseVersionId ||
        candidate?.status !== 'selected' ||
        !candidate.validationRuns.some((run) => run.status === 'succeeded')
      ) {
        throw new ConflictException(`ChangeSet 中的草稿 ${draft.id} 已过期或未校验`);
      }
    }
    return this.prisma.$transaction(async (tx) => {
      const versions: Array<{ documentId: string; versionId: string }> = [];
      for (const draft of members) {
        const item = changeSet.items.find((entry) => entry.documentId === draft.documentId)!;
        const candidate = item.candidate!;
        if (!item.selectedPatch) {
          throw new ConflictException('ChangeSet is missing its frozen candidate patch');
        }
        const content = getCandidateContent(item.selectedPatch, draft.document.kind as DesignKind);
        const max = await tx.designVersion.aggregate({
          where: { documentId: draft.documentId },
          _max: { versionNumber: true },
        });
        const version = await tx.designVersion.create({
          data: {
            documentId: draft.documentId,
            versionNumber: (max._max.versionNumber ?? 0) + 1,
            baseVersionId: draft.baseVersionId,
            content: canonicalJson(content),
            contentHash: contentHash(canonicalJson(content)),
            summary: candidate.rationale || `采用候选方案 ${candidate.label}`,
            changeKind: 'update',
            publishedAt: new Date(),
          },
        });
        await this.createDependencies(
          tx,
          draft.document.kind as DesignKind,
          content,
          draft.documentId,
          version.id,
        );
        versions.push({ documentId: draft.documentId, versionId: version.id });
      }
      for (const draft of members) {
        const item = changeSet.items.find((entry) => entry.documentId === draft.documentId)!;
        const version = versions.find((item) => item.documentId === draft.documentId)!;
        const updated = await tx.designDocument.updateMany({
          where: { id: draft.documentId, currentPublishedVersionId: draft.baseVersionId },
          data: { currentPublishedVersionId: version.versionId, status: 'published' },
        });
        if (updated.count !== 1)
          throw new ConflictException('发布期间正式版本发生变化，ChangeSet 已整体取消');
        await tx.candidateProposal.update({
          where: { id: item.candidateId! },
          data: { status: 'published' },
        });
        await tx.designDraft.update({
          where: { id: draft.id },
          data: { status: 'published', lockVersion: { increment: 1 } },
        });
      }
      await tx.changeSetItem.updateMany({ where: { changeSetId }, data: { status: 'published' } });
      return tx.changeSet.update({
        where: { id: changeSetId },
        data: { status: 'published', publishTransactionId: randomUUID() },
        include: { items: true, drafts: true },
      });
    });
  }

  async renderAndValidateCandidate(candidateId: string) {
    const candidate = await this.prisma.candidateProposal.findUnique({
      where: { id: candidateId },
      include: { draft: { include: { document: true } } },
    });
    if (!candidate) throw new NotFoundException(`候选方案 ${candidateId} 不存在`);
    if (!['generated', 'rendered', 'validated'].includes(candidate.status))
      throw new BadRequestException('当前候选状态不能执行渲染和校验');
    const key = contentHash(candidate.patch);
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
          fixtureVersion: 'aurum.fixture.v1',
          viewports: ['desktop', 'tablet', 'mobile'],
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
        void this.extendTaskLease(pending.id, leaseToken);
      },
      Math.floor(TASK_LEASE_MS / 3),
    );
    try {
      if (pending.taskType === 'ai_generate')
        return this.processAiGenerationTask({ ...pending, leaseToken });
      if (pending.taskType !== 'render_validate' || !pending.candidateId)
        throw new BadRequestException('不支持的设计任务');
      const candidate = await this.prisma.candidateProposal.findUniqueOrThrow({
        where: { id: pending.candidateId },
        include: { draft: { include: { document: true, baseVersion: true } } },
      });
      const content = getCandidateContent(
        candidate.patch,
        candidate.draft.document.kind as DesignKind,
      );
      const baseContent = parseContent(candidate.draft.baseVersion.content);
      const [fixtureContent, fixtureBaseContent] = await Promise.all([
        this.resolveFixtureContent(content),
        this.resolveFixtureContent(baseContent),
      ]);
      const screenshots = await this.renderer.render(fixtureContent, fixtureBaseContent, candidate.id);
      return await this.prisma.$transaction(async (tx) => {
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
              validation: 'passed',
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
            browser: 'playwright-chromium/134.0.6998.35',
            fixtureVersion: 'aurum.fixture.v1',
            artifactHash: snapshot.artifactHash,
            storagePath: snapshot.snapshotKey,
          })),
        });
        await tx.validationRun.create({
          data: {
            candidateId: candidate.id,
            status: 'succeeded',
            policyVersion: POLICY_VERSION,
            result: canonicalJson({
              schema: 'passed',
              dependencies: 'passed',
              renderer: 'playwright-controlled-fixture/v1',
              viewports: ['desktop', 'tablet', 'mobile'],
            }),
            finishedAt: new Date(),
          },
        });
        await tx.candidateProposal.updateMany({
          where: { id: candidate.id, status: { in: ['generated', 'rendered', 'validated'] } },
          data: { status: 'validated' },
        });
        return tx.designTask.findUnique({ where: { id: pending.id } });
      });
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
        await this.reserveCandidateSlots(tx, input.draftId, Math.max(0, input.count - createdCount));
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

  async listTasks(status?: string) {
    return this.prisma.designTask.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 100,
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
    return candidate.previewSnapshots.map((snapshot) => {
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
    const candidates = await this.designAgent.generateCandidates({
      kind: draft.document.kind as DesignKind,
      baseContent: parseContent(draft.baseVersion.content),
      intent: aiInput.intent,
      count: aiInput.count,
    });
    await this.assertTaskLease(task.id, task.leaseToken);
    const createdIds: string[] = [];
    for (const [index, candidate] of candidates.entries()) {
      await this.assertTaskLease(task.id, task.leaseToken);
      const created = await this.createCandidate(draft.id, {
        label: candidate.label || `AI 方案 ${index + 1}`,
        rationale: candidate.rationale,
        content: candidate.content,
        generationKey: `${task.id}:${index}`,
      }, { slotAlreadyReserved: true, taskId: task.id, leaseToken: task.leaseToken });
      createdIds.push(created.id);
      await this.assertTaskLease(task.id, task.leaseToken);
      await this.renderAndValidateCandidate(created.id);
    }
    const completed = await this.prisma.$transaction(async (tx) => {
      const update = await tx.designTask.updateMany({
        where: { id: task.id, status: 'running', leaseToken: task.leaseToken },
        data: {
          status: 'succeeded',
          result: canonicalJson({ candidateIds: createdIds }),
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
      await tx.referenceSnapshot.deleteMany({ where: { id: { in: expired.map((item) => item.id) } } });
      const sessionIds = [...new Set(expired.map((item) => item.sessionId).filter(Boolean))] as string[];
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

  async publishDraft(draftId: string) {
    const draft = await this.prisma.designDraft.findUnique({
      where: { id: draftId },
      include: {
        document: true,
        baseVersion: true,
        candidates: { where: { status: 'selected' }, include: { validationRuns: true } },
        changeSet: { include: { drafts: true } },
        changeSetMemberships: { include: { changeSet: { include: { drafts: true } } } },
      },
    });
    if (!draft) throw new NotFoundException(`草稿 ${draftId} 不存在`);
    if (draft.status === 'published') return this.getDocument(draft.documentId);
    if (draft.status !== 'ready') throw new BadRequestException('请先选择一个通过校验的候选方案');
    if (
      draft.changeSetMemberships.some(
        (membership) =>
          membership.changeSet.drafts.length > 1 && membership.changeSet.status !== 'published',
      )
    ) {
      throw new ConflictException('草稿已加入多文档 ChangeSet，必须通过 ChangeSet 原子发布');
    }
    const candidate = draft.candidates[0];
    if (!candidate || !candidate.validationRuns.some((run) => run.status === 'succeeded')) {
      throw new BadRequestException('没有可发布的已校验候选方案');
    }
    this.assertDraftCurrent(draft, draft.document);
    const content = getCandidateContent(candidate.patch, draft.document.kind as DesignKind);
    await this.assertDependenciesPublished(
      draft.document.kind as DesignKind,
      content,
      draft.documentId,
    );

    const result = await this.prisma.$transaction(async (tx) => {
      const versionNumber =
        (
          await tx.designVersion.aggregate({
            where: { documentId: draft.documentId },
            _max: { versionNumber: true },
          })
        )._max.versionNumber! + 1;
      const version = await tx.designVersion.create({
        data: {
          documentId: draft.documentId,
          versionNumber,
          baseVersionId: draft.baseVersionId,
          content: canonicalJson(content),
          contentHash: contentHash(canonicalJson(content)),
          summary: candidate.rationale || `采用候选方案 ${candidate.label}`,
          changeKind: 'update',
          publishedAt: new Date(),
        },
      });
      await this.createDependencies(
        tx,
        draft.document.kind as DesignKind,
        content,
        draft.documentId,
        version.id,
      );
      const updated = await tx.designDocument.updateMany({
        where: { id: draft.documentId, currentPublishedVersionId: draft.baseVersionId },
        data: { currentPublishedVersionId: version.id, status: 'published' },
      });
      if (updated.count !== 1)
        throw new ConflictException('正式版本已变化，草稿已过期；请基于新版本重新生成候选方案');
      await tx.candidateProposal.update({
        where: { id: candidate.id },
        data: { status: 'published' },
      });
      await tx.designDraft.update({
        where: { id: draft.id },
        data: { status: 'published', lockVersion: { increment: 1 } },
      });
      if (draft.changeSet && draft.changeSet.drafts.length <= 1) {
        await tx.changeSet.update({
          where: { id: draft.changeSet.id },
          data: { status: 'published', publishTransactionId: randomUUID() },
        });
        await tx.changeSetItem.updateMany({
          where: { changeSetId: draft.changeSet.id },
          data: { status: 'published' },
        });
      }
      return version;
    });
    return result;
  }

  async restoreVersion(documentId: string, restoredVersionId: string) {
    const document = await this.prisma.designDocument.findUnique({ where: { id: documentId } });
    if (!document || !document.currentPublishedVersionId)
      throw new NotFoundException(`设计文档 ${documentId} 不存在或尚未发布`);
    const restored = await this.prisma.designVersion.findFirst({
      where: { id: restoredVersionId, documentId, publishedAt: { not: null } },
    });
    if (!restored) throw new NotFoundException('待恢复版本不存在或不是该文档的正式版本');
    if (restored.id === document.currentPublishedVersionId)
      throw new BadRequestException('当前已经是该版本，无需恢复');

    return this.prisma.$transaction(async (tx) => {
      const versionNumber =
        (await tx.designVersion.aggregate({ where: { documentId }, _max: { versionNumber: true } }))
          ._max.versionNumber! + 1;
      const version = await tx.designVersion.create({
        data: {
          documentId,
          versionNumber,
          baseVersionId: document.currentPublishedVersionId,
          restoredFromVersionId: restored.id,
          content: restored.content,
          contentHash: restored.contentHash,
          summary: `恢复正式版本 v${restored.versionNumber}`,
          changeKind: 'restore',
          publishedAt: new Date(),
        },
      });
      await this.createDependencies(
        tx,
        document.kind as DesignKind,
        parseContent(restored.content),
        documentId,
        version.id,
      );
      const updated = await tx.designDocument.updateMany({
        where: { id: documentId, currentPublishedVersionId: document.currentPublishedVersionId },
        data: { currentPublishedVersionId: version.id },
      });
      if (updated.count !== 1)
        throw new ConflictException('正式版本已变化，无法恢复；请刷新后重试');
      return version;
    });
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
    this.assertDraftCurrent(draft, draft.document);
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
      where: { id: taskId, candidateSlotsReleasedAt: null, status: { in: ['failed', 'succeeded'] } },
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

  private assertDraftCurrent(
    draft: { baseVersionId: string },
    document: { currentPublishedVersionId: string | null },
  ) {
    if (document.currentPublishedVersionId !== draft.baseVersionId) {
      throw new ConflictException('草稿基准版本已过期，请基于当前正式版本创建新草稿');
    }
  }

  private async ensureDraftExists(id: string) {
    const count = await this.prisma.designDraft.count({ where: { id } });
    if (count === 0) throw new NotFoundException(`草稿 ${id} 不存在`);
  }

  private async assertDependenciesPublished(
    kind: DesignKind,
    content: JsonRecord,
    currentDocumentId: string,
  ) {
    if (kind !== 'style_pack') return;
    const dependencies = getStylePackDependencies(content);
    if (dependencies.some((item) => item.documentId === currentDocumentId)) {
      throw new BadRequestException('样式包不能依赖自身');
    }
    for (const dependency of dependencies) {
      const version = await this.prisma.designVersion.findFirst({
        where: {
          id: dependency.versionId,
          documentId: dependency.documentId,
          publishedAt: { not: null },
        },
      });
      if (!version)
        throw new BadRequestException(`样式包依赖版本 ${dependency.versionId} 不存在或未发布`);
    }
  }

  private async resolveFixtureContent(
    content: JsonRecord,
    visitedVersionIds = new Set<string>(),
  ): Promise<JsonRecord> {
    if (content.schemaVersion !== 'aurum.style-pack.v1' || !Array.isArray(content.dependencies)) {
      return content;
    }
    const dependencies = getStylePackDependencies(content);
    if (!dependencies.length) return content;
    for (const dependency of dependencies) {
      if (visitedVersionIds.has(dependency.versionId)) {
        throw new BadRequestException('Style pack dependencies contain a circular version reference');
      }
    }
    const versions = await this.prisma.designVersion.findMany({
      where: { id: { in: dependencies.map((dependency) => dependency.versionId) } },
      select: { id: true, documentId: true, content: true },
    });
    const versionById = new Map(versions.map((version) => [version.id, version]));
    const resolvedDependencies: FixtureDependency[] = [];
    for (const dependency of dependencies) {
      const version = versionById.get(dependency.versionId);
      if (!version || version.documentId !== dependency.documentId) {
        throw new BadRequestException('Style pack dependency version is missing or does not match its document');
      }
      const nextVisited = new Set(visitedVersionIds);
      nextVisited.add(dependency.versionId);
      const resolved = await this.resolveFixtureContent(parseContent(version.content), nextVisited);
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

  private async createDependencies(
    tx: Prisma.TransactionClient,
    kind: DesignKind,
    content: JsonRecord,
    fromDocumentId: string,
    fromVersionId: string,
  ) {
    if (kind !== 'style_pack') return;
    const dependencies = getStylePackDependencies(content);
    for (const dependency of dependencies) {
      if (dependency.documentId === fromDocumentId) {
        throw new BadRequestException('样式包不能依赖自身');
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
          `样式包依赖版本 ${dependency.versionId} 不存在、未发布或不属于指定文档`,
        );
      }
    }
    if (dependencies.length) {
      await tx.designDependency.createMany({
        data: dependencies.map((dependency) => ({
          fromDocumentId,
          fromVersionId,
          toDocumentId: dependency.documentId,
          toVersionId: dependency.versionId,
        })),
      });
    }
  }
}

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

function getCandidateContent(serializedPatch: string, expectedKind: DesignKind): JsonRecord {
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
  return validateDesignContent(operation.documentKind, operation.value);
}

function parseContent(content: string): JsonRecord {
  try {
    return JSON.parse(content) as JsonRecord;
  } catch {
    throw new BadRequestException('已发布设计版本内容损坏');
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonRecord)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
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
function isUniqueError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function flattenTokens(value: unknown, prefix = ''): Array<[string, unknown]> {
  if (!isJsonRecord(value)) return [];
  if ('$value' in value && '$type' in value) return [[prefix, value.$value]];
  return Object.entries(value).flatMap(([key, child]) =>
    flattenTokens(child, prefix ? `${prefix}-${key}` : key),
  );
}

function buildCssExport(content: JsonRecord): string {
  const entries = flattenTokens(content.tokens);
  if (!entries.length) return '/* This published asset does not define design tokens. */\n';
  const scalarEntries = entries.filter(
    (entry): entry is [string, string | number] =>
      typeof entry[1] === 'string' || typeof entry[1] === 'number',
  );
  if (!scalarEntries.length)
    return '/* This published asset does not define exportable scalar design tokens. */\n';
  return `:root {\n${scalarEntries.map(([name, value]) => `  --${name}: ${formatCssTokenValue(value)};`).join('\n')}\n}\n`;
}

function formatCssTokenValue(value: string | number) {
  if (typeof value !== 'string') return value;
  const alias = /^\{([a-zA-Z0-9_.-]+)\}$/.exec(value);
  return alias ? `var(--${alias[1].replaceAll('.', '-')})` : value;
}

function buildTailwindExport(content: JsonRecord): string {
  const entries = flattenTokens(content.tokens);
  const values = Object.fromEntries(
    entries.map(([name, value]) => [
      name,
      typeof value === 'string' || typeof value === 'number'
        ? `var(--${name})`
        : JSON.stringify(value),
    ]),
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
