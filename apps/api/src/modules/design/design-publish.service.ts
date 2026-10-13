import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DesignDocumentService } from './design-document.service';
import {
  assertDependenciesPublished,
  assertDraftCurrent,
  canonicalJson,
  contentHash,
  createDependencies,
  getCandidateContent,
  parseContent,
} from './design-content';
import type { DesignKind } from './design.types';

/**
 * 版本生命周期与发布。
 *
 * 单独成服务的理由：这是设计运营台唯一会**改写正式版本指针**的地方。
 * 三条不变量必须在一个事务里同时成立，出错会留下"版本已建但文档未指向它"
 * 或"多文档只发布了一半"这类需要人工介入的状态：
 *   1. 版本号取 `max(versionNumber) + 1`
 *   2. 用条件更新（`where.currentPublishedVersionId = 草稿基准`）认领版本指针，
 *      `count !== 1` 说明有人并发发布过，整笔回滚
 *   3. 跨文档变更必须走 ChangeSet 一起发布，否则主题变了而组件还是旧的
 *
 * 发布前的依赖门禁与内容规范化在 `design-content.ts`；这里只负责流程编排。
 */
@Injectable()
export class DesignPublishService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DesignDocumentService,
  ) {}

  /**
   * 组装跨文档变更集合。
   *
   * 草稿一旦进入多文档 ChangeSet，就不能再走单文档发布接口——否则会出现
   * "主题发布了、组件还是旧版"的中间态，而样式包依赖主题版本，历史比较和回退都会失去意义。
   */
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

  /**
   * 原子发布整个 ChangeSet。
   *
   * 先为每个文档建版本，再逐个认领正式版本指针；任一文档的指针在发布期间被别人改动，
   * 就整体回滚——因为"部分发布"的状态无法自动收敛。
   */
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
        await createDependencies(tx, content, draft.documentId, version.id);
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

  /**
   * 发布单个草稿。
   *
   * 已发布的草稿走幂等分支返回文档（前端重复点发布会拿到当前状态而不是报错），
   * 未发布的返回新建的版本——两种返回形状不同，是历史行为，改动会破坏前端，暂保持不变。
   */
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
    if (draft.status === 'published') return this.documents.getDocument(draft.documentId);
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
    assertDraftCurrent(draft, draft.document);
    const content = getCandidateContent(candidate.patch, draft.document.kind as DesignKind);
    await assertDependenciesPublished(this.prisma, content, draft.documentId);

    return this.prisma.$transaction(async (tx) => {
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
      await createDependencies(tx, content, draft.documentId, version.id);
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
  }

  /**
   * 恢复到某个历史版本。
   *
   * 产生**新版本**而不是把指针拨回去：历史版本必须不可变，否则基于"v3 的内容"
   * 做的评审和导出会在 v3 被改写后失去依据。内容原样复制，不重新生成。
   */
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
      await createDependencies(tx, parseContent(restored.content), documentId, version.id);
      const updated = await tx.designDocument.updateMany({
        where: { id: documentId, currentPublishedVersionId: document.currentPublishedVersionId },
        data: { currentPublishedVersionId: version.id },
      });
      if (updated.count !== 1)
        throw new ConflictException('正式版本已变化，无法恢复；请刷新后重试');
      return version;
    });
  }
}
