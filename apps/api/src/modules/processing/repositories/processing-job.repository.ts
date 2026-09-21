import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, ProcessingJob } from '@prisma/client';
import { JobStatus } from '../../../common/constants/enums';

/**
 * 处理任务仓储
 * 阶段 6：完整实现，支持任务状态流转、原子认领、分页查询、统计
 */
@Injectable()
export class ProcessingJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    data: Prisma.ProcessingJobCreateInput,
    tx?: Prisma.TransactionClient,
  ): Promise<ProcessingJob> {
    const client = tx ?? this.prisma;
    return client.processingJob.create({ data });
  }

  findByResourceId(resourceId: string): Promise<ProcessingJob[]> {
    return this.prisma.processingJob.findMany({
      where: { resourceId },
      orderBy: { createdAt: 'asc' },
    });
  }

  findById(id: string): Promise<ProcessingJob | null> {
    return this.prisma.processingJob.findUnique({ where: { id } });
  }

  /**
   * 原子认领下一个待处理任务
   *
   * 在交互式事务中完成 findFirst + updateMany，确保整个认领过程原子化：
   * - SQLite：WAL 模式下串行化写入，天然安全
   * - PostgreSQL：事务隔离级别保证原子性，无竞态窗口
   *
   * 即使多个 worker 同时调用，updateMany 的 WHERE status=pending 条件
   * 确保只有第一个提交的 worker 能成功认领。
   */
  async claimNext(jobType?: string): Promise<ProcessingJob | null> {
    return this.prisma.$transaction(async (tx) => {
      const where: Prisma.ProcessingJobWhereInput = {
        status: JobStatus.pending,
      };
      if (jobType) where.jobType = jobType;

      const job = await tx.processingJob.findFirst({
        where,
        orderBy: { createdAt: 'asc' },
      });
      if (!job) return null;

      // 原子更新：只有 status 仍是 pending 时才更新
      const updated = await tx.processingJob.updateMany({
        where: {
          id: job.id,
          status: JobStatus.pending, // 二次确认：防止被其他 worker 抢先
        },
        data: {
          status: JobStatus.processing,
          startedAt: new Date(),
          finishedAt: null,
        },
      });

      if (updated.count === 0) return null; // 被抢走了

      return tx.processingJob.findUnique({ where: { id: job.id } });
    });
  }

  /** 更新任务状态，completed/failed 时自动设 finishedAt */
  async updateStatus(
    id: string,
    status: string,
    errorMessage?: string | null,
  ): Promise<ProcessingJob> {
    const data: Prisma.ProcessingJobUpdateInput = { status };
    if (status === JobStatus.pending) {
      data.startedAt = null;
      data.finishedAt = null;
      data.errorMessage = errorMessage ?? null;
    } else if (status === JobStatus.completed || status === JobStatus.failed) {
      data.finishedAt = new Date();
      if (errorMessage !== undefined) {
        data.errorMessage = errorMessage;
      }
    }
    return this.prisma.processingJob.update({ where: { id }, data });
  }

  /** 增加重试次数并重置为 pending */
  async incrementRetry(id: string): Promise<ProcessingJob> {
    return this.prisma.processingJob.update({
      where: { id },
      data: {
        retryCount: { increment: 1 },
        status: JobStatus.pending,
        startedAt: null,
        finishedAt: null,
        errorMessage: null,
      },
    });
  }

  /** 分页查询任务列表 */
  async findMany(params: {
    status?: string;
    jobType?: string;
    resourceId?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ items: ProcessingJob[]; total: number }> {
    const where: Prisma.ProcessingJobWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.jobType) where.jobType = params.jobType;
    if (params.resourceId) where.resourceId = params.resourceId;

    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;

    const [items, total] = await Promise.all([
      this.prisma.processingJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          resource: { select: { id: true, title: true } },
        },
      }),
      this.prisma.processingJob.count({ where }),
    ]);
    return { items, total };
  }

  /** 统计各状态任务数量 */
  async stats(): Promise<Record<string, number>> {
    const jobs = await this.prisma.processingJob.groupBy({
      by: ['status'],
      _count: { status: true },
    });
    const result: Record<string, number> = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      canceled: 0,
    };
    for (const g of jobs) {
      result[g.status] = g._count.status;
    }
    return result;
  }

  /** 删除一条已结束（terminal）的任务记录；活跃任务（pending/processing）不可删除，返回 false */
  async deleteTerminal(id: string): Promise<boolean> {
    const result = await this.prisma.processingJob.deleteMany({
      where: {
        id,
        status: { in: [JobStatus.completed, JobStatus.failed, JobStatus.canceled] },
      },
    });
    return result.count === 1;
  }

  /** 清空所有已结束（terminal）的任务记录，返回删除数量 */
  async clearTerminal(): Promise<number> {
    const result = await this.prisma.processingJob.deleteMany({
      where: {
        status: { in: [JobStatus.completed, JobStatus.failed, JobStatus.canceled] },
      },
    });
    return result.count;
  }
}
