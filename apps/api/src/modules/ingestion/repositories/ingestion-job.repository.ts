import { Injectable } from '@nestjs/common';
import { IngestionJob, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { IngestionJobStatus, IngestionJobType } from '../../../common/constants/enums';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class IngestionJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string) {
    return this.prisma.ingestionJob.findUnique({
      where: { id },
      include: {
        resource: { select: { id: true, title: true } },
        source: { select: { id: true, name: true } },
      },
    });
  }

  findActiveByIdempotencyKey(idempotencyKey: string) {
    return this.prisma.ingestionJob.findFirst({
      where: {
        idempotencyKey,
        status: { in: [IngestionJobStatus.pending, IngestionJobStatus.processing] },
      },
    });
  }

  create(data: {
    sourceId?: string;
    resourceId?: string;
    jobType: IngestionJobType;
    request: string;
    idempotencyKey: string;
  }) {
    return this.prisma.ingestionJob.create({
      data: {
        sourceId: data.sourceId,
        resourceId: data.resourceId,
        jobType: data.jobType,
        request: data.request,
        idempotencyKey: data.idempotencyKey,
        status: IngestionJobStatus.pending,
      },
    });
  }

  /**
   * 原子认领下一个待处理任务
   *
   * 在交互式事务中完成 findFirst + updateMany，确保整个认领过程原子化。
   * leaseToken 用于防止任务被多个 worker 同时认领。
   */
  async claimNext(): Promise<IngestionJob | null> {
    return this.prisma.$transaction(async (tx) => {
      const job = await tx.ingestionJob.findFirst({
        where: {
          status: IngestionJobStatus.pending,
          OR: [{ nextRunAt: null }, { nextRunAt: { lte: new Date() } }],
        },
        orderBy: { createdAt: 'asc' },
      });
      if (!job) return null;
      const leaseToken = randomUUID();
      const result = await tx.ingestionJob.updateMany({
        where: { id: job.id, status: IngestionJobStatus.pending },
        data: {
          status: IngestionJobStatus.processing,
          startedAt: new Date(),
          leaseToken,
          errorCode: null,
          errorMessage: null,
        },
      });
      if (result.count !== 1) return null;
      const claimed = await tx.ingestionJob.findUnique({ where: { id: job.id } });
      return claimed?.leaseToken ? claimed : null;
    });
  }

  async complete(
    id: string,
    leaseToken: string,
    resourceId: string | null,
    result: string,
  ): Promise<boolean> {
    const update = await this.prisma.ingestionJob.updateMany({
      where: { id, status: IngestionJobStatus.processing, leaseToken },
      data: {
        status: IngestionJobStatus.completed,
        leaseToken: null,
        resourceId: resourceId ?? undefined,
        result,
        finishedAt: new Date(),
      },
    });
    return update.count === 1;
  }

  async updateProgress(id: string, leaseToken: string, result: string): Promise<boolean> {
    const update = await this.prisma.ingestionJob.updateMany({
      where: { id, status: IngestionJobStatus.processing, leaseToken },
      data: { result },
    });
    return update.count === 1;
  }

  async cancel(id: string): Promise<boolean> {
    const update = await this.prisma.ingestionJob.updateMany({
      where: {
        id,
        status: { in: [IngestionJobStatus.pending, IngestionJobStatus.processing] },
      },
      data: {
        status: IngestionJobStatus.canceled,
        leaseToken: null,
        finishedAt: new Date(),
      },
    });
    return update.count === 1;
  }

  async isProcessing(id: string, leaseToken: string): Promise<boolean> {
    const job = await this.prisma.ingestionJob.findUnique({
      where: { id },
      select: { status: true, leaseToken: true },
    });
    return job?.status === IngestionJobStatus.processing && job.leaseToken === leaseToken;
  }

  async fail(
    id: string,
    leaseToken: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<boolean> {
    const update = await this.prisma.ingestionJob.updateMany({
      where: { id, status: IngestionJobStatus.processing, leaseToken },
      data: {
        status: IngestionJobStatus.failed,
        leaseToken: null,
        errorCode,
        errorMessage,
        finishedAt: new Date(),
      },
    });
    return update.count === 1;
  }

  /**
   * 释放已认领的任务回 pending（用于后台单飞场景：已有同类任务在执行时，
   * 把新认领的任务退回队列，等下次轮询再处理）。
   *
   * @param backoffMs 退避时间：>0 时设置 nextRunAt 延迟重新可认领，避免单飞期间
   *   该任务被反复「认领→释放」而饿死排在它后面的其它任务（claimNext 按 createdAt
   *   升序取最旧，若不加退避，每次轮询都会重新认领这个最新释放的任务）。
   */
  async release(id: string, leaseToken: string, backoffMs = 0): Promise<boolean> {
    const update = await this.prisma.ingestionJob.updateMany({
      where: { id, status: IngestionJobStatus.processing, leaseToken },
      data: {
        status: IngestionJobStatus.pending,
        leaseToken: null,
        startedAt: null,
        errorCode: null,
        errorMessage: null,
        nextRunAt: backoffMs > 0 ? new Date(Date.now() + backoffMs) : null,
      },
    });
    return update.count === 1;
  }

  async retryIfRetryable(id: string, maxRetry = 3) {
    const job = await this.prisma.ingestionJob.findUnique({
      where: { id },
      select: { retryCount: true, status: true },
    });
    if (!job) return null;
    if (job.status !== IngestionJobStatus.failed && job.status !== IngestionJobStatus.canceled)
      return null;
    if (job.retryCount >= maxRetry) return null;
    const update = await this.prisma.ingestionJob.updateMany({
      where: {
        id,
        status: { in: [IngestionJobStatus.failed, IngestionJobStatus.canceled] },
        retryCount: { lt: maxRetry },
      },
      data: {
        status: IngestionJobStatus.pending,
        leaseToken: null,
        retryCount: { increment: 1 },
        nextRunAt: null,
        startedAt: null,
        finishedAt: null,
        errorCode: null,
        errorMessage: null,
      },
    });
    return update.count === 1 ? this.prisma.ingestionJob.findUnique({ where: { id } }) : null;
  }

  resetStaleProcessing(staleBefore: Date) {
    return this.prisma.ingestionJob.updateMany({
      where: {
        status: IngestionJobStatus.processing,
        OR: [{ startedAt: null }, { startedAt: { lte: staleBefore } }],
      },
      data: { status: IngestionJobStatus.pending, startedAt: null, leaseToken: null },
    });
  }

  /** 删除一条已结束（terminal）的任务记录；活跃任务（pending/processing）不可删除，返回 false */
  async deleteTerminal(id: string): Promise<boolean> {
    const result = await this.prisma.ingestionJob.deleteMany({
      where: {
        id,
        status: {
          in: [
            IngestionJobStatus.completed,
            IngestionJobStatus.failed,
            IngestionJobStatus.canceled,
          ],
        },
      },
    });
    return result.count === 1;
  }

  /** 清空所有已结束（terminal）的任务记录，返回删除数量 */
  async clearTerminal(): Promise<number> {
    const result = await this.prisma.ingestionJob.deleteMany({
      where: {
        status: {
          in: [
            IngestionJobStatus.completed,
            IngestionJobStatus.failed,
            IngestionJobStatus.canceled,
          ],
        },
      },
    });
    return result.count;
  }

  /** 统计各状态摄入任务数量 */
  async stats(): Promise<Record<string, number>> {
    const jobs = await this.prisma.ingestionJob.groupBy({
      by: ['status'],
      _count: { status: true },
    });
    const result: Record<string, number> = {
      [IngestionJobStatus.pending]: 0,
      [IngestionJobStatus.processing]: 0,
      [IngestionJobStatus.completed]: 0,
      [IngestionJobStatus.failed]: 0,
      [IngestionJobStatus.canceled]: 0,
    };
    for (const group of jobs) {
      result[group.status] = group._count.status;
    }
    return result;
  }

  async findMany(params: {
    status?: string;
    jobType?: string;
    sourceId?: string;
    resourceId?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    const where: Prisma.IngestionJobWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.jobType) where.jobType = params.jobType;
    if (params.sourceId) where.sourceId = params.sourceId;
    if (params.resourceId) where.resourceId = params.resourceId;
    const [items, total] = await Promise.all([
      this.prisma.ingestionJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          resource: { select: { id: true, title: true } },
          source: { select: { id: true, name: true } },
        },
      }),
      this.prisma.ingestionJob.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  /**
   * 查询需要健康检查的 ResourceLocator
   *
   * 条件：lastCheckedAt IS NULL（从未检查）或 lastCheckedAt 早于阈值
   * 排除：已有活跃 check_locator 任务的 locator（通过 idempotencyKey 判断）
   * 按优先级排序：从未检查的优先，然后按 lastCheckedAt 升序
   */
  async findLocatorsNeedingCheck(staleBefore: Date, limit: number) {
    // 先找出所有活跃的 check_locator 任务的 idempotencyKey
    // idempotencyKey 格式：check_locator:{locatorId}
    const activeCheckJobs = await this.prisma.ingestionJob.findMany({
      where: {
        jobType: IngestionJobType.check_locator,
        status: { in: [IngestionJobStatus.pending, IngestionJobStatus.processing] },
      },
      select: { idempotencyKey: true },
    });
    const activeLocatorIds = new Set(
      activeCheckJobs
        .map((j) => {
          // 从 idempotencyKey 提取 locatorId
          // 格式：check_locator:{locatorId}（自动调度）或 check_locator:{locatorId}:{timestamp}（手动触发）
          const prefix = 'check_locator:';
          if (!j.idempotencyKey.startsWith(prefix)) return null;
          const remainder = j.idempotencyKey.slice(prefix.length);
          // 取第一个冒号之前的部分作为 locatorId（手动触发的 key 含时间戳后缀）
          const colonIdx = remainder.indexOf(':');
          return colonIdx >= 0 ? remainder.slice(0, colonIdx) : remainder;
        })
        .filter(Boolean),
    );

    const candidates = await this.prisma.resourceLocator.findMany({
      where: {
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: staleBefore } }],
      },
      orderBy: [{ lastCheckedAt: 'asc' }, { createdAt: 'asc' }],
      take: limit * 2, // 多取一些，过滤掉已有活跃任务的
      select: {
        id: true,
        url: true,
        sourceId: true,
        resourceId: true,
        lastCheckedAt: true,
        httpStatus: true,
        lastError: true,
      },
    });

    // 过滤掉已有活跃 check_locator 任务的
    return candidates.filter((l) => !activeLocatorIds.has(l.id)).slice(0, limit);
  }
}
