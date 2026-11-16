import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const DEFAULT_VIEWPORT = 'desktop';
const DEFAULT_STATE = 'default';
const DEFAULT_KIND = 'full';
const LEASE_MS = 2 * 60_000;

export interface SnapshotJobOptions {
  viewport?: string;
  state?: string;
  kind?: string;
}

@Injectable()
export class PreviewSnapshotJobService {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(
    tx: Prisma.TransactionClient,
    versionId: string,
    options: SnapshotJobOptions = {},
  ) {
    const viewport = options.viewport ?? DEFAULT_VIEWPORT;
    const state = options.state ?? DEFAULT_STATE;
    const kind = options.kind ?? DEFAULT_KIND;
    // 正在渲染的任务不能重置：它完成后会把这次 pending 覆盖成 succeeded，
    // 重渲染请求就被吞掉了。租约过期的任务由 reclaimExpired 负责回收。
    const updated = await tx.previewSnapshotJob.updateMany({
      where: { versionId, viewport, state, kind, status: { not: 'running' } },
      data: {
        status: 'pending',
        attempts: 0,
        availableAt: new Date(),
        leaseUntil: null,
        workerId: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      },
    });
    if (updated.count > 0) return;
    // 走到这里只有两种可能：不存在（创建），或已存在但正在渲染（保持原样）。
    // update 分支绝不能碰 status：并发入队时对方可能刚创建了一条 pending，
    // 写 running 会让它既不会被认领、也不会被租约回收，永久卡死。
    return tx.previewSnapshotJob.upsert({
      where: {
        versionId_viewport_state_kind: { versionId, viewport, state, kind },
      },
      update: { error: null },
      create: { versionId, viewport, state, kind },
    });
  }

  async enqueueForVersion(versionId: string, options: SnapshotJobOptions = {}) {
    return this.enqueue(this.prisma as unknown as Prisma.TransactionClient, versionId, options);
  }

  async claim(workerId: string) {
    const now = new Date();
    const pending = await this.prisma.previewSnapshotJob.findFirst({
      where: { status: 'pending', availableAt: { lte: now } },
      orderBy: { createdAt: 'asc' },
    });
    if (!pending) return null;
    const claimed = await this.prisma.previewSnapshotJob.updateMany({
      where: { id: pending.id, status: 'pending' },
      data: {
        status: 'running',
        attempts: { increment: 1 },
        workerId,
        startedAt: now,
        error: null,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
      },
    });
    if (claimed.count === 0) return null;
    return this.prisma.previewSnapshotJob.findUnique({ where: { id: pending.id } });
  }

  /**
   * 完成一次执行
   *
   * 带 workerId 栅栏：租约过期后任务可能已被别的 worker 重新认领，
   * 旧执行的结果不能覆盖新一次认领。返回 false 表示租约已失效。
   */
  async complete(
    jobId: string,
    workerId: string,
    result: { storagePath: string; artifactHash: string },
  ): Promise<boolean> {
    const updated = await this.prisma.previewSnapshotJob.updateMany({
      where: { id: jobId, status: 'running', workerId },
      data: {
        status: 'succeeded',
        storagePath: result.storagePath,
        artifactHash: result.artifactHash,
        error: null,
        finishedAt: new Date(),
        leaseUntil: null,
        workerId: null,
      },
    });
    return updated.count === 1;
  }

  /** 标记失败：同样按 workerId 栅栏，租约失效时返回 false 且不改状态 */
  async fail(jobId: string, workerId: string, error: string): Promise<boolean> {
    const job = await this.prisma.previewSnapshotJob.findFirst({
      where: { id: jobId, status: 'running', workerId },
      select: { attempts: true, maxAttempts: true },
    });
    if (!job) return false;

    const message = error.slice(0, 2_000);
    const data =
      job.attempts >= job.maxAttempts
        ? {
            status: 'failed',
            error: message,
            finishedAt: new Date(),
            leaseUntil: null,
            workerId: null,
          }
        : {
            status: 'pending',
            error: message,
            availableAt: new Date(Date.now() + this.retryDelayMs(job.attempts)),
            leaseUntil: null,
            workerId: null,
          };
    const updated = await this.prisma.previewSnapshotJob.updateMany({
      where: { id: jobId, status: 'running', workerId },
      data,
    });
    return updated.count === 1;
  }

  /** 指数退避：5s 起，上限 60s */
  private retryDelayMs(attempts: number): number {
    return Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 60_000);
  }

  /**
   * 回收租约过期的任务
   *
   * 写回时重新校验「仍在 running 且租约确实过期」：扫描到写回之间任务可能已经
   * 被完成（succeeded）或被另一个 worker 重新认领（leaseUntil 已刷新），
   * 无条件按 id 写回会把它们错误地打回队列。
   */
  async reclaimExpired() {
    const now = new Date();
    const expired = await this.prisma.previewSnapshotJob.findMany({
      where: { status: 'running', leaseUntil: { lt: now } },
      select: { id: true, attempts: true, maxAttempts: true },
    });

    let reclaimed = 0;
    for (const job of expired) {
      const data =
        job.attempts >= job.maxAttempts
          ? {
              status: 'failed',
              error: '生成超时，任务租约已过期',
              finishedAt: now,
              leaseUntil: null,
              workerId: null,
            }
          : { status: 'pending', availableAt: now, leaseUntil: null, workerId: null };
      const updated = await this.prisma.previewSnapshotJob.updateMany({
        where: { id: job.id, status: 'running', leaseUntil: { lt: now } },
        data,
      });
      if (updated.count === 1) reclaimed += 1;
    }
    return reclaimed;
  }

  async retryForVersion(versionId: string) {
    // 不重置 running：正在渲染的任务由租约和 reclaimExpired 管理，
    // 强行改回 pending 会让完成写回与新一次认领互相覆盖。
    // pending 仍要重置，用来清掉退避等待（用户点重试就是要求立刻重跑）。
    await this.prisma.previewSnapshotJob.updateMany({
      where: { versionId, status: { in: ['failed', 'succeeded', 'pending'] } },
      data: {
        status: 'pending',
        attempts: 0,
        availableAt: new Date(),
        leaseUntil: null,
        workerId: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      },
    });
  }

  async statusForVersion(versionId: string) {
    return this.prisma.previewSnapshotJob.findFirst({
      where: { versionId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        attempts: true,
        error: true,
        createdAt: true,
      },
    });
  }
}
