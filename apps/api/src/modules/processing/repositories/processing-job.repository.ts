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
   * 先原子更新一条 pending → processing，再查询返回完整记录。
   * updateMany 在 SQLite 下串行化写入，天然安全；
   * PG 下 update + where 条件在单条语句内原子执行。
   */
  async claimNext(jobType?: string): Promise<ProcessingJob | null> {
    // 先找到最旧的 pending 任务
    const where: Prisma.ProcessingJobWhereInput = {
      status: JobStatus.pending,
    };
    if (jobType) where.jobType = jobType;

    const job = await this.prisma.processingJob.findFirst({
      where,
      orderBy: { createdAt: 'asc' },
    });
    if (!job) return null;

    // 原子更新：只有 status 仍是 pending 时才更新
    const updated = await this.prisma.processingJob.updateMany({
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

    return this.findById(job.id);
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
}
