import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { canonicalJson } from './design-content';
import { DesignAgentService, type AssetPatch } from './design-agent.service';
import { DesignAssetService, type AssetDetailDto, type AssetFileDto } from './design-asset.service';
import {
  PreviewCompileService,
  type PreviewFile,
} from './preview/preview-compiler.service';

/**
 * 历史越长，单次会话读取越慢（每条消息上限 2000 字符）。
 * 只保留最近 N 条：AI 只消费最近 8 条，界面也不需要无限回溯。
 */
const MESSAGE_HISTORY_LIMIT = 200;
/** 会话 / 快照列表都是「最近优先」的视图，加硬上限避免随时间无限增长 */
const SESSION_LIST_LIMIT = 50;
const SNAPSHOT_LIST_LIMIT = 50;

interface RawSession {
  session: {
    id: string;
    title: string | null;
    status: string;
    documentId: string | null;
    createdAt: Date;
    updatedAt: Date;
    messages: Array<{
      id: string;
      role: string;
      content: string;
      candidateId: string | null;
      status: string;
      createdAt: Date;
    }>;
    drafts: Array<{
      id: string;
      status: string;
      baseVersionId: string;
      draftRevision: number;
      files: Array<{
        id: string;
        path: string;
        target: string | null;
        type: string;
        language: string;
        content: string;
      }>;
      candidates: Array<{
        id: string;
        label: string;
        rationale: string | null;
        status: string;
        patch: string;
        structuredDiff: string | null;
        createdAt: Date;
      }>;
    }>;
  };
  draft: RawSession['session']['drafts'][number];
}

@Injectable()
export class DesignStudioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assets: DesignAssetService,
    private readonly agent: DesignAgentService,
    private readonly preview: PreviewCompileService,
  ) {}

  async createSession(assetId: string) {
    const asset = await this.assets.get(assetId);
    if (asset.format !== 'package' || !asset.manifest || !asset.version) {
      throw new BadRequestException('只有资产包格式支持 AI 对话草稿');
    }
    const manifest = asset.manifest;
    const baseVersionId = asset.version.id;
    const existing = await this.prisma.changeSession.findFirst({
      where: { documentId: asset.id, status: 'open' },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });
    if (existing) return this.getSession(existing.id);

    const session = await this.prisma.$transaction(async (tx) => {
      const created = await tx.changeSession.create({
        data: {
          request: '工作台会话',
          status: 'open',
          documentId: asset.id,
          title: asset.name,
        },
      });
      const draft = await tx.designDraft.create({
        data: {
          sessionId: created.id,
          documentId: asset.id,
          baseVersionId,
          status: 'editing',
          draftRevision: 1,
        },
      });
      await tx.designDraftFile.createMany({
        data: asset.files.map((file) => ({
          draftId: draft.id,
          path: file.path,
          target: file.target ?? null,
          type: file.type,
          language: file.language,
          content: file.content,
        })),
      });
      await tx.designDraftSnapshot.create({
        data: {
          draftId: draft.id,
          revision: 1,
          manifest: canonicalJson(manifest),
          files: canonicalJson(asset.files),
        },
      });
      return created;
    });

    return this.getSession(session.id);
  }

  async listSessions(assetId: string) {
    const asset = await this.assets.get(assetId);
    const sessions = await this.prisma.changeSession.findMany({
      where: { documentId: asset.id },
      orderBy: { updatedAt: 'desc' },
      take: SESSION_LIST_LIMIT,
      include: {
        _count: { select: { messages: true } },
        drafts: { select: { id: true, status: true, draftRevision: true } },
      },
    });
    return {
      items: sessions.map((session) => ({
        id: session.id,
        title: session.title,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session._count.messages,
        draft: session.drafts[0]
          ? {
              id: session.drafts[0].id,
              status: session.drafts[0].status,
              revision: session.drafts[0].draftRevision,
            }
          : null,
      })),
    };
  }

  async closeSession(id: string) {
    const session = await this.prisma.changeSession.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!session) throw new NotFoundException(`工作台会话 ${id} 不存在`);
    await this.prisma.$transaction(async (tx) => {
      await tx.changeSession.update({
        where: { id },
        data: { status: 'closed' },
      });
      await tx.designDraft.updateMany({
        where: { sessionId: id },
        data: { status: 'closed' },
      });
    });
    return this.getSession(id);
  }

  async listSnapshots(id: string) {
    const raw = await this.loadRawSession(id);
    const snapshots = await this.prisma.designDraftSnapshot.findMany({
      where: { draftId: raw.draft.id },
      orderBy: { revision: 'desc' },
      take: SNAPSHOT_LIST_LIMIT,
    });
    return {
      items: snapshots.map((snapshot) => {
        let fileCount = 0;
        try {
          const files = JSON.parse(snapshot.files) as unknown;
          if (Array.isArray(files)) fileCount = files.length;
        } catch {
          // ignore malformed snapshot
        }
        return {
          id: snapshot.id,
          revision: snapshot.revision,
          fileCount,
          createdAt: snapshot.createdAt,
        };
      }),
    };
  }

  async restoreSnapshot(sessionId: string, revision: number) {
    if (!Number.isInteger(revision)) {
      throw new BadRequestException('草稿版本号必须是整数');
    }
    const raw = await this.loadRawSession(sessionId);
    const asset = await this.assets.get(raw.session.documentId!);
    if (!asset.manifest) throw new BadRequestException('资产缺少 manifest');
    const snapshot = await this.prisma.designDraftSnapshot.findFirst({
      where: { draftId: raw.draft.id, revision },
    });
    if (!snapshot) throw new NotFoundException(`草稿版本 ${revision} 不存在`);
    let restored: AssetFileDto[];
    try {
      const parsed = JSON.parse(snapshot.files) as AssetFileDto[];
      if (!Array.isArray(parsed)) throw new Error('files');
      restored = parsed.filter(
        (file) =>
          file &&
          typeof file.path === 'string' &&
          typeof file.content === 'string' &&
          typeof file.type === 'string' &&
          typeof file.language === 'string',
      );
    } catch {
      throw new BadRequestException('草稿快照无法解析');
    }
    if (!restored.length) throw new BadRequestException('草稿快照没有文件');
    const previewFiles = restored.map((file) => ({
      path: file.path,
      content: file.content,
      target: file.target ?? undefined,
      type: file.type,
      language: file.language,
    }));
    const compiled = await this.preview.compile({
      manifest: asset.manifest,
      files: previewFiles,
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.designDraftFile.deleteMany({ where: { draftId: raw.draft.id } });
      await tx.designDraftFile.createMany({
        data: restored.map((file) => ({
          draftId: raw.draft.id,
          path: file.path,
          target: file.target ?? null,
          type: file.type,
          language: file.language,
          content: file.content,
        })),
      });
      // 在事务内、拿到写锁之后再读版本号：并发保存不会算出同一个 revision。
      const current = await tx.designDraft.findUniqueOrThrow({
        where: { id: raw.draft.id },
        select: { draftRevision: true },
      });
      const nextRevision = current.draftRevision + 1;
      await tx.designDraft.update({
        where: { id: raw.draft.id },
        data: { draftRevision: nextRevision, lockVersion: { increment: 1 } },
      });
      await tx.designDraftSnapshot.create({
        data: {
          draftId: raw.draft.id,
          revision: nextRevision,
          manifest: snapshot.manifest,
          files: snapshot.files,
        },
      });
      await tx.candidateProposal.updateMany({
        where: { draftId: raw.draft.id, status: 'applied' },
        data: { status: 'undone' },
      });
    });
    return { session: await this.getSession(sessionId), preview: compiled };
  }

  async getSession(id: string) {
    const raw = await this.loadRawSession(id);
    const asset = await this.assets.get(raw.session.documentId!);
    return this.toSessionDto(raw, asset);
  }

  async sendMessage(sessionId: string, content: string) {
    const text = content.trim();
    if (text.length < 2 || text.length > 2_000) {
      throw new BadRequestException('消息长度必须在 2 到 2000 个字符之间');
    }
    const raw = await this.loadRawSession(sessionId);
    const asset = await this.assets.get(raw.session.documentId!);
    if (!asset.manifest) throw new BadRequestException('资产缺少 manifest');

    await this.prisma.studioMessage.create({
      data: { sessionId, role: 'user', content: text },
    });

    let patch: AssetPatch;
    try {
      patch = await this.agent.generateAssetPatch({
        manifest: asset.manifest,
        files: raw.draft.files.map((file) => ({ path: file.path, content: file.content })),
        request: text,
        history: raw.session.messages
          .slice(-8)
          .map((message) => `${message.role}: ${message.content}`)
          .join('\n'),
      });
    } catch (error) {
      await this.prisma.studioMessage.create({
        data: {
          sessionId,
          role: 'assistant',
          content: `AI 调用失败：${error instanceof Error ? error.message : String(error)}`,
          status: 'error',
        },
      });
      throw error;
    }

    let nextFiles: PreviewFile[];
    try {
      nextFiles = this.applyPatchToFiles(raw.draft.files, patch.operations);
      await this.preview.compile({ manifest: asset.manifest, files: nextFiles });
    } catch (error) {
      await this.prisma.studioMessage.create({
        data: {
          sessionId,
          role: 'assistant',
          content: `AI 补丁无法应用：${error instanceof Error ? error.message : String(error)}`,
          status: 'error',
        },
      });
      throw new BadRequestException(
        `AI 补丁无法应用：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const changedPaths = patch.operations.map((operation) => operation.path);
    const diff = this.buildDiff(patch.operations, raw.draft.files);
    await this.prisma.candidateProposal.updateMany({
      where: { draftId: raw.draft.id, status: 'planned' },
      data: { status: 'superseded' },
    });
    const candidate = await this.prisma.candidateProposal.create({
      data: {
        draftId: raw.draft.id,
        baseVersionId: raw.draft.baseVersionId,
        label: patch.summary,
        rationale: patch.rationale,
        patch: JSON.stringify(patch),
        structuredDiff: JSON.stringify({ paths: changedPaths, files: diff }),
        status: 'planned',
      },
    });
    await this.prisma.studioMessage.create({
      data: {
        sessionId,
        role: 'assistant',
        content: patch.rationale || patch.summary,
        candidateId: candidate.id,
        status: 'proposed',
      },
    });

    return {
      session: await this.getSession(sessionId),
      candidate: this.toCandidate(candidate),
      changedPaths,
    };
  }

  async streamMessage(
    sessionId: string,
    content: string,
    send: (event: string, data: unknown) => void,
    signal?: AbortSignal,
  ) {
    const text = content.trim();
    if (text.length < 2 || text.length > 2_000) {
      send('error', { message: '消息长度必须在 2 到 2000 个字符之间' });
      return;
    }
    await this.prisma.studioMessage.create({
      data: { sessionId, role: 'user', content: text },
    });
    await this.runStream(sessionId, text, send, signal);
  }

  async retryMessage(
    sessionId: string,
    send: (event: string, data: unknown) => void,
    signal?: AbortSignal,
  ) {
    const raw = await this.loadRawSession(sessionId);
    const lastUser = [...raw.session.messages].reverse().find((message) => message.role === 'user');
    if (!lastUser) {
      send('error', { message: '还没有可重试的用户消息' });
      return;
    }
    await this.runStream(sessionId, lastUser.content, send, signal);
  }

  private async runStream(
    sessionId: string,
    text: string,
    send: (event: string, data: unknown) => void,
    signal?: AbortSignal,
  ) {
    const raw = await this.loadRawSession(sessionId);
    const asset = await this.assets.get(raw.session.documentId!);
    if (!asset.manifest) {
      send('error', { message: '资产缺少 manifest' });
      return;
    }
    send('status', { stage: 'thinking' });

    let patch: AssetPatch;
    try {
      patch = await this.agent.streamAssetPatch(
        {
          manifest: asset.manifest,
          files: raw.draft.files.map((file) => ({
            path: file.path,
            content: file.content,
          })),
          request: text,
          history: raw.session.messages
            .slice(-8)
            .map((message) => `${message.role}: ${message.content}`)
            .join('\n'),
        },
        (delta) => send('delta', { text: delta }),
        signal,
      );
    } catch (error) {
      if (signal?.aborted) {
        await this.prisma.studioMessage.create({
          data: {
            sessionId,
            role: 'assistant',
            content: '生成已停止',
            status: 'cancelled',
          },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.studioMessage.create({
        data: {
          sessionId,
          role: 'assistant',
          content: `AI 调用失败：${message}`,
          status: 'error',
        },
      });
      send('error', { message });
      return;
    }

    let nextFiles: PreviewFile[];
    try {
      nextFiles = this.applyPatchToFiles(raw.draft.files, patch.operations);
      await this.preview.compile({ manifest: asset.manifest, files: nextFiles });
    } catch (error) {
      const message = `AI 补丁无法应用：${error instanceof Error ? error.message : String(error)}`;
      await this.prisma.studioMessage.create({
        data: { sessionId, role: 'assistant', content: message, status: 'error' },
      });
      send('error', { message });
      return;
    }

    if (signal?.aborted) {
      await this.prisma.studioMessage.create({
        data: {
          sessionId,
          role: 'assistant',
          content: '生成已停止',
          status: 'cancelled',
        },
      });
      return;
    }
    const changedPaths = patch.operations.map((operation) => operation.path);
    const diff = this.buildDiff(patch.operations, raw.draft.files);
    await this.prisma.candidateProposal.updateMany({
      where: { draftId: raw.draft.id, status: 'planned' },
      data: { status: 'superseded' },
    });
    const candidate = await this.prisma.candidateProposal.create({
      data: {
        draftId: raw.draft.id,
        baseVersionId: raw.draft.baseVersionId,
        label: patch.summary,
        rationale: patch.rationale,
        patch: JSON.stringify(patch),
        structuredDiff: JSON.stringify({ paths: changedPaths, files: diff }),
        status: 'planned',
      },
    });
    await this.prisma.studioMessage.create({
      data: {
        sessionId,
        role: 'assistant',
        content: patch.rationale || patch.summary,
        candidateId: candidate.id,
        status: 'proposed',
      },
    });

    send('candidate', {
      candidate: this.toCandidate(candidate),
      changedPaths,
    });
    send('done', {});
  }

  async discardSession(sessionId: string) {
    const raw = await this.loadRawSession(sessionId);
    const asset = await this.assets.get(raw.session.documentId!);
    if (!asset.manifest) throw new BadRequestException('资产缺少 manifest');
    const restored = asset.files.map((file) => ({
      path: file.path,
      content: file.content,
      target: file.target ?? undefined,
      type: file.type,
      language: file.language,
    }));
    const compiled = await this.preview.compile({
      manifest: asset.manifest,
      files: restored,
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.designDraftFile.deleteMany({ where: { draftId: raw.draft.id } });
      await tx.designDraftFile.createMany({
        data: restored.map((file) => ({
          draftId: raw.draft.id,
          path: file.path,
          target: file.target ?? null,
          type: file.type,
          language: file.language,
          content: file.content,
        })),
      });
      const current = await tx.designDraft.findUniqueOrThrow({
        where: { id: raw.draft.id },
        select: { draftRevision: true },
      });
      const nextRevision = current.draftRevision + 1;
      await tx.designDraft.update({
        where: { id: raw.draft.id },
        data: {
          baseVersionId: asset.version?.id ?? raw.draft.baseVersionId,
          draftRevision: nextRevision,
          lockVersion: { increment: 1 },
        },
      });
      await tx.designDraftSnapshot.create({
        data: {
          draftId: raw.draft.id,
          revision: nextRevision,
          manifest: canonicalJson(asset.manifest),
          files: canonicalJson(restored),
        },
      });
      await tx.candidateProposal.updateMany({
        where: {
          draftId: raw.draft.id,
          status: { in: ['planned', 'applied'] },
        },
        data: { status: 'discarded' },
      });
      await tx.studioMessage.updateMany({
        where: {
          sessionId,
          status: { in: ['proposed', 'applied'] },
        },
        data: { status: 'discarded' },
      });
    });
    return { session: await this.getSession(sessionId), preview: compiled };
  }

  async rejectCandidate(candidateId: string) {
    const candidate = await this.prisma.candidateProposal.findUnique({
      where: { id: candidateId },
      include: { draft: { select: { sessionId: true } } },
    });
    if (!candidate) throw new NotFoundException(`候选补丁 ${candidateId} 不存在`);
    if (candidate.status === 'applied') {
      throw new ConflictException('已应用的补丁不能拒绝，请先撤销');
    }
    if (!candidate.draft.sessionId) throw new BadRequestException('草稿缺少会话');
    await this.prisma.$transaction(async (tx) => {
      await tx.candidateProposal.update({
        where: { id: candidate.id },
        data: { status: 'rejected' },
      });
      await tx.studioMessage.updateMany({
        where: { candidateId: candidate.id, status: 'proposed' },
        data: { status: 'rejected' },
      });
    });
    return this.getSession(candidate.draft.sessionId);
  }

  async undoSession(sessionId: string) {
    const raw = await this.loadRawSession(sessionId);
    const asset = await this.assets.get(raw.session.documentId!);
    if (!asset.manifest) throw new BadRequestException('资产缺少 manifest');
    const snapshots = await this.prisma.designDraftSnapshot.findMany({
      where: { draftId: raw.draft.id },
      orderBy: { revision: 'desc' },
      take: 2,
    });
    if (snapshots.length < 2) {
      throw new BadRequestException('没有可撤销的草稿版本');
    }
    const previous = snapshots[1];
    const latest = snapshots[0];
    let restored: AssetFileDto[];
    try {
      const parsed = JSON.parse(previous.files) as AssetFileDto[];
      if (!Array.isArray(parsed)) throw new Error('files');
      restored = parsed.filter(
        (file) =>
          file &&
          typeof file.path === 'string' &&
          typeof file.content === 'string' &&
          typeof file.type === 'string' &&
          typeof file.language === 'string',
      );
    } catch {
      throw new BadRequestException('草稿快照无法解析');
    }
    if (!restored.length) throw new BadRequestException('草稿快照没有文件');
    const previewFiles = restored.map((file) => ({
      path: file.path,
      content: file.content,
      target: file.target ?? undefined,
      type: file.type,
      language: file.language,
    }));
    const compiled = await this.preview.compile({
      manifest: asset.manifest,
      files: previewFiles,
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.designDraftFile.deleteMany({ where: { draftId: raw.draft.id } });
      await tx.designDraftFile.createMany({
        data: restored.map((file) => ({
          draftId: raw.draft.id,
          path: file.path,
          target: file.target ?? null,
          type: file.type,
          language: file.language,
          content: file.content,
        })),
      });
      // 撤销采用「弹出」语义：删掉被撤销的那一版快照，并把 draftRevision 退回上一版。
      // 若像普通修改那样再写一版同内容快照，序列会变成 A/B/A，下一次撤销取第二新
      // 就永远在 A、B 之间来回跳，无法连续回退。
      // 快照是在事务外读的：用 draftRevision 做乐观守卫，确认期间没有新的修改落库。
      // 若已有更新（draftRevision 不再等于最新快照的 revision），删除/回退都会破坏
      // 「最新快照 == 当前草稿」的不变量，直接让用户刷新重试。
      const moved = await tx.designDraft.updateMany({
        where: { id: raw.draft.id, draftRevision: latest.revision },
        data: { draftRevision: previous.revision, lockVersion: { increment: 1 } },
      });
      if (moved.count !== 1) {
        throw new ConflictException('草稿已发生变化，请刷新后重试');
      }
      const removed = await tx.designDraftSnapshot.deleteMany({
        where: { draftId: raw.draft.id, revision: latest.revision },
      });
      if (removed.count !== 1) {
        throw new ConflictException('草稿已发生变化，请刷新后重试');
      }
      const latestApplied = await tx.candidateProposal.findFirst({
        where: { draftId: raw.draft.id, status: 'applied' },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (latestApplied) {
        await tx.candidateProposal.update({
          where: { id: latestApplied.id },
          data: { status: 'undone' },
        });
        await tx.studioMessage.updateMany({
          where: { candidateId: latestApplied.id, status: 'applied' },
          data: { status: 'undone' },
        });
      }
    });
    return { session: await this.getSession(sessionId), preview: compiled };
  }

  async applyCandidate(candidateId: string) {
    const candidate = await this.prisma.candidateProposal.findUnique({
      where: { id: candidateId },
      include: { draft: { include: { files: true } } },
    });
    if (!candidate) throw new NotFoundException(`候选补丁 ${candidateId} 不存在`);
    if (candidate.status !== 'planned') {
      throw new ConflictException('只有待应用的补丁可以应用');
    }
    const latestSnapshot = await this.prisma.designDraftSnapshot.findFirst({
      where: { draftId: candidate.draftId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (latestSnapshot && latestSnapshot.createdAt > candidate.createdAt) {
      throw new ConflictException('草稿已经变化，请重新生成补丁');
    }
    if (!candidate.draft.sessionId) throw new BadRequestException('草稿缺少会话');
    const patch = this.parsePatch(candidate.patch);
    const asset = await this.assets.get(candidate.draft.documentId);
    if (!asset.manifest) throw new BadRequestException('资产缺少 manifest');
    const nextFiles = this.applyPatchToFiles(candidate.draft.files, patch.operations);
    const compiled = await this.preview.compile({ manifest: asset.manifest, files: nextFiles });

    await this.prisma.$transaction(async (tx) => {
      for (const operation of patch.operations) {
        const result = await tx.designDraftFile.updateMany({
          where: { draftId: candidate.draftId, path: operation.path },
          data: { content: operation.content },
        });
        if (result.count === 0) {
          throw new BadRequestException(`补丁引用了不存在的文件：${operation.path}`);
        }
      }
      const current = await tx.designDraft.findUniqueOrThrow({
        where: { id: candidate.draftId },
        select: { draftRevision: true },
      });
      const nextRevision = current.draftRevision + 1;
      await tx.designDraft.update({
        where: { id: candidate.draftId },
        data: { draftRevision: nextRevision, lockVersion: { increment: 1 } },
      });
      await tx.designDraftSnapshot.create({
        data: {
          draftId: candidate.draftId,
          revision: nextRevision,
          manifest: canonicalJson(asset.manifest),
          files: canonicalJson(nextFiles),
        },
      });
      await tx.candidateProposal.update({
        where: { id: candidate.id },
        data: { status: 'applied' },
      });
      await tx.studioMessage.updateMany({
        where: { candidateId: candidate.id, status: 'proposed' },
        data: { status: 'applied' },
      });
    });

    return {
      session: await this.getSession(candidate.draft.sessionId),
      preview: compiled,
    };
  }

  async previewSession(sessionId: string) {
    const raw = await this.loadRawSession(sessionId);
    const asset = await this.assets.get(raw.session.documentId!);
    if (!asset.manifest) throw new BadRequestException('资产缺少 manifest');
    return this.preview.compile({
      manifest: asset.manifest,
      files: this.toPreviewFiles(raw.draft.files),
    });
  }

  async saveSession(
    sessionId: string,
    summary = 'AI 对话保存',
    files?: PreviewFile[],
  ) {
    const raw = await this.loadRawSession(sessionId);
    const asset = await this.assets.get(raw.session.documentId!);
    if (asset.format !== 'package' || !asset.manifest) {
      throw new BadRequestException('只有资产包格式支持保存草稿');
    }
    const saveFiles =
      files && files.length
        ? files.map((file) => ({
            path: file.path,
            content: file.content,
            target: file.target ?? undefined,
            type: file.type ?? 'registry:ui',
            language: file.language ?? 'text',
          }))
        : this.toPreviewFiles(raw.draft.files);
    const updated = await this.assets.saveVersion(asset.id, {
      files: saveFiles,
      summary: summary.trim() || 'AI 对话保存',
      // 草稿基于哪个正式版本，就以它为并发基准：期间有人发布过新版本时保存会 409，
      // 而不是用旧草稿内容静默覆盖对方。
      expectedBaseVersionId: raw.draft.baseVersionId,
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.designDraftFile.deleteMany({ where: { draftId: raw.draft.id } });
      await tx.designDraftFile.createMany({
        data: saveFiles.map((file) => ({
          draftId: raw.draft.id,
          path: file.path,
          target: file.target ?? null,
          type: file.type ?? 'registry:ui',
          language: file.language ?? 'text',
          content: file.content,
        })),
      });
      const current = await tx.designDraft.findUniqueOrThrow({
        where: { id: raw.draft.id },
        select: { draftRevision: true },
      });
      const nextRevision = current.draftRevision + 1;
      await tx.designDraft.update({
        where: { id: raw.draft.id },
        data: {
          baseVersionId: updated.version?.id ?? raw.draft.baseVersionId,
          draftRevision: nextRevision,
          lockVersion: { increment: 1 },
        },
      });
      await tx.designDraftSnapshot.create({
        data: {
          draftId: raw.draft.id,
          revision: nextRevision,
          manifest: canonicalJson(asset.manifest),
          files: canonicalJson(saveFiles),
        },
      });
    });
    return { session: await this.getSession(sessionId), asset: updated };
  }

  private async loadRawSession(id: string): Promise<RawSession> {
    const session = await this.prisma.changeSession.findUnique({
      where: { id },
      include: {
        // 降序取最近 N 条，下面反转成时间正序；不能直接 asc + take，那会留住最旧的
        messages: { orderBy: { createdAt: 'desc' }, take: MESSAGE_HISTORY_LIMIT },
        drafts: {
          include: {
            files: true,
            candidates: { orderBy: { createdAt: 'desc' }, take: 10 },
          },
        },
      },
    });
    if (!session) throw new NotFoundException(`工作台会话 ${id} 不存在`);
    session.messages.reverse();
    const draft = session.drafts[0];
    if (!draft) throw new NotFoundException('工作台会话没有草稿');
    if (!session.documentId) throw new BadRequestException('工作台会话缺少资产');
    return { session, draft } as RawSession;
  }

  private toSessionDto(raw: RawSession, asset: AssetDetailDto) {
    return {
      id: raw.session.id,
      title: raw.session.title,
      status: raw.session.status,
      createdAt: raw.session.createdAt,
      updatedAt: raw.session.updatedAt,
      asset,
      draft: {
        id: raw.draft.id,
        status: raw.draft.status,
        baseVersionId: raw.draft.baseVersionId,
        revision: raw.draft.draftRevision,
        files: raw.draft.files.map((file) => ({
          path: file.path,
          target: file.target,
          type: file.type,
          language: file.language,
          content: file.content,
        })),
      },
      messages: raw.session.messages,
      candidates: raw.draft.candidates.map((candidate) => this.toCandidate(candidate)),
    };
  }

  private buildDiff(
    operations: AssetPatch['operations'],
    files: Array<{ path: string; content: string }> | AssetFileDto[],
  ) {
    const byPath = new Map(files.map((file) => [file.path, file.content]));
    return operations.map((operation) => ({
      path: operation.path,
      before: byPath.get(operation.path) ?? '',
      after: operation.content,
    }));
  }

  private toCandidate(candidate: {
    id: string;
    label: string;
    rationale: string | null;
    status: string;
    structuredDiff: string | null;
    createdAt: Date;
  }) {
    let changedPaths: string[] = [];
    let diff: Array<{ path: string; before: string; after: string }> = [];
    try {
      const parsed = JSON.parse(candidate.structuredDiff ?? '{}') as {
        paths?: unknown;
        files?: unknown;
      };
      if (Array.isArray(parsed.paths)) {
        changedPaths = parsed.paths.filter((item): item is string => typeof item === 'string');
      }
      if (Array.isArray(parsed.files)) {
        diff = parsed.files
          .filter(
            (item): item is { path: string; before: string; after: string } =>
              !!item &&
              typeof item === 'object' &&
              typeof (item as { path?: unknown }).path === 'string' &&
              typeof (item as { before?: unknown }).before === 'string' &&
              typeof (item as { after?: unknown }).after === 'string',
          )
          .map((item) => ({ path: item.path, before: item.before, after: item.after }));
      }
    } catch {
      // ignore malformed structured diff
    }
    return {
      id: candidate.id,
      label: candidate.label,
      rationale: candidate.rationale,
      status: candidate.status,
      changedPaths,
      diff,
      createdAt: candidate.createdAt,
    };
  }

  private applyPatchToFiles(
    files: Array<{ path: string; content: string }> | AssetFileDto[],
    operations: AssetPatch['operations'],
  ): PreviewFile[] {
    const map = new Map(files.map((file) => [file.path, file]));
    for (const operation of operations) {
      const current = map.get(operation.path);
      if (!current) {
        throw new BadRequestException(`补丁引用了不存在的文件：${operation.path}`);
      }
      map.set(operation.path, { ...current, content: operation.content });
    }
    return [...map.values()].map((file) => ({
      path: file.path,
      content: file.content,
      target: 'target' in file ? file.target ?? undefined : undefined,
      type: 'type' in file ? file.type : undefined,
      language: 'language' in file ? file.language : undefined,
    }));
  }

  private toPreviewFiles(files: RawSession['draft']['files']): PreviewFile[] {
    return files.map((file) => ({
      path: file.path,
      content: file.content,
      target: file.target ?? undefined,
      type: file.type,
      language: file.language,
    }));
  }

  private parsePatch(value: string): AssetPatch {
    try {
      const parsed = JSON.parse(value) as AssetPatch;
      if (!Array.isArray(parsed.operations)) throw new Error('missing operations');
      return parsed;
    } catch {
      throw new BadRequestException('候选补丁内容无法解析');
    }
  }
}
