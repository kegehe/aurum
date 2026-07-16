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
      include: { resource: { select: { id: true, title: true } }, source: { select: { id: true, name: true } } },
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

  create(data: { sourceId?: string; jobType: IngestionJobType; request: string; idempotencyKey: string }) {
    return this.prisma.ingestionJob.create({
      data: {
        sourceId: data.sourceId,
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

  async complete(id: string, leaseToken: string, resourceId: string, result: string): Promise<boolean> {
    const update = await this.prisma.ingestionJob.updateMany({
      where: { id, status: IngestionJobStatus.processing, leaseToken },
      data: {
        status: IngestionJobStatus.completed,
        leaseToken: null,
        resourceId,
        result,
        finishedAt: new Date(),
      },
    });
    return update.count === 1;
  }

  async fail(id: string, leaseToken: string, errorCode: string, errorMessage: string): Promise<boolean> {
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

  async retryIfRetryable(id: string) {
    const update = await this.prisma.ingestionJob.updateMany({
      where: { id, status: { in: [IngestionJobStatus.failed, IngestionJobStatus.canceled] } },
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

  async findMany(params: { status?: string; sourceId?: string; resourceId?: string; page?: number; pageSize?: number }) {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    const where: Prisma.IngestionJobWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.sourceId) where.sourceId = params.sourceId;
    if (params.resourceId) where.resourceId = params.resourceId;
    const [items, total] = await Promise.all([
      this.prisma.ingestionJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { resource: { select: { id: true, title: true } }, source: { select: { id: true, name: true } } },
      }),
      this.prisma.ingestionJob.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }
}
