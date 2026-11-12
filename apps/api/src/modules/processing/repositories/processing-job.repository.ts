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

  /**
   * 入队：仅当同资源同类型没有活跃任务时创建
   *
   * 幂等判断和插入放在同一个事务里：SQLite（WAL，写事务串行）下可以完全避免
   * 两个消费者同时入队时各插入一条 pending（随后被两边各跑一遍）；切到 PostgreSQL
   * 后 READ COMMITTED 仍可能双插，届时需要补「活跃任务」唯一索引才能彻底兜住。
   * 返回 null 表示已有活跃任务，调用方应跳过。
   */
  async createIfNoActive(jobType: string, resourceId: string): Promise<ProcessingJob | null> {
    return this.prisma.$transaction(async (tx) => {
      const active = await tx.processingJob.findFirst({
        where: {
          resourceId,
          jobType,
          status: { in: [JobStatus.pending, JobStatus.processing] },
        },
        select: { id: true },
      });
      if (active) return null;
      return tx.processingJob.create({
        data: {
          resource: { connect: { id: resourceId } },
          jobType,
          status: JobStatus.pending,
        },
      });
    });
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
   * 列出卡死的 processing 任务（启动 + 定期回收共用）
   *
   * 两个判定条件取并集：
   * - updatedAt 早于 noHeartbeatBefore：执行中的任务会周期性续租，停止续租即视为进程已死；
   * - startedAt 早于 startedBefore：兜底处理器 Promise 永久挂起的情况——此时事件循环
   *   仍在跑、心跳照常刷新，只能靠单次执行时长上限识别。
   * 按 id 稳定排序，并用「id > afterId」做键集分页：历史任务再多也只取一页。
   * 不用 Prisma 的 cursor/skip：本页处理会把游标行改出 processing 集合，
   * 依赖「游标行仍命中过滤条件」的翻页语义不够稳；纯条件比较没有这个前提。
   */
  findStaleProcessing(
    noHeartbeatBefore: Date,
    startedBefore: Date,
    options: { take?: number; afterId?: string } = {},
  ): Promise<ProcessingJob[]> {
    return this.prisma.processingJob.findMany({
      where: {
        status: JobStatus.processing,
        ...(options.afterId ? { id: { gt: options.afterId } } : {}),
        OR: [
          { updatedAt: { lte: noHeartbeatBefore } },
          { startedAt: { lte: startedBefore } },
        ],
      },
      orderBy: { id: 'asc' },
      take: options.take,
    });
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
          // 心跳租约从认领这一刻开始：显式续租而不是依赖 @updatedAt 隐式更新。
          // 否则一个排队超过 staleTimeoutMs 才被认领的任务，认领后仍带着旧的
          // updatedAt，另一个进程启动扫描时会立刻把它当成卡死任务重置，导致同一
          // 任务被两个进程同时执行。
          updatedAt: new Date(),
          finishedAt: null,
        },
      });

      if (updated.count === 0) return null; // 被抢走了

      return tx.processingJob.findUnique({ where: { id: job.id } });
    });
  }

  /**
   * 手动重试：仅允许 failed/canceled → pending
   *
   * 单条 updateMany 完成状态检查与更新，避免「读到 failed 后任务已被认领/完成」
   * 的竞态把正在执行的任务强行改回 pending。
   * 手动重试是用户的明确决定，重置 retryCount 给一次完整的自动重试预算。
   */
  async requeueTerminal(id: string): Promise<boolean> {
    const result = await this.prisma.processingJob.updateMany({
      where: {
        id,
        status: { in: [JobStatus.failed, JobStatus.canceled] },
      },
      data: {
        status: JobStatus.pending,
        retryCount: 0,
        startedAt: null,
        finishedAt: null,
        errorMessage: null,
      },
    });
    return result.count === 1;
  }

  /**
   * 条件状态流转的 where 条件
   *
   * startedAt 是本次认领的「租约」：只更新仍处于 processing 且 startedAt 未变的任务。
   * 这样任务被取消、或被 stale 回收后重新认领时，旧执行结果不会覆盖新状态。
   * startedAt 为 null 时显式匹配 null（历史数据），不能退化成「只按 status 匹配」，
   * 否则会误伤期间被重新认领的任务。
   */
  private processingWhere(
    id: string,
    startedAt: Date | null,
  ): Prisma.ProcessingJobWhereInput {
    return { id, status: JobStatus.processing, startedAt };
  }

  /** 仅当任务仍是本次认领的 processing 时标记完成，返回是否真的更新 */
  async completeIfProcessing(id: string, startedAt: Date | null): Promise<boolean> {
    const result = await this.prisma.processingJob.updateMany({
      where: this.processingWhere(id, startedAt),
      data: {
        status: JobStatus.completed,
        finishedAt: new Date(),
        errorMessage: null,
      },
    });
    return result.count === 1;
  }

  /** 仅当任务仍是本次认领的 processing 时标记失败，返回是否真的更新 */
  async failIfProcessing(
    id: string,
    errorMessage: string,
    startedAt: Date | null,
  ): Promise<boolean> {
    const result = await this.prisma.processingJob.updateMany({
      where: this.processingWhere(id, startedAt),
      data: {
        status: JobStatus.failed,
        finishedAt: new Date(),
        errorMessage,
      },
    });
    return result.count === 1;
  }

  /** 增加重试次数并重置为 pending；任务已被取消/重新认领时不再改动，返回是否更新 */
  async retryIfProcessing(id: string, startedAt: Date | null): Promise<boolean> {
    const result = await this.prisma.processingJob.updateMany({
      where: this.processingWhere(id, startedAt),
      data: {
        retryCount: { increment: 1 },
        status: JobStatus.pending,
        startedAt: null,
        finishedAt: null,
        errorMessage: null,
      },
    });
    return result.count === 1;
  }

  /**
   * 正常退出时释放租约：processing → pending，不消耗重试次数
   *
   * 进程退出不是任务失败，不能走 retryIfProcessing（那样会吃掉重试预算）。
   * 仍然用 startedAt 栅栏：期间被取消/重新认领的任务不会被改回去。
   */
  async releaseIfProcessing(id: string, startedAt: Date | null): Promise<boolean> {
    const result = await this.prisma.processingJob.updateMany({
      where: this.processingWhere(id, startedAt),
      data: {
        status: JobStatus.pending,
        startedAt: null,
        finishedAt: null,
        errorMessage: null,
      },
    });
    return result.count === 1;
  }

  /**
   * 续租：刷新 updatedAt，向其它进程证明任务仍在执行
   *
   * 只有仍处于 processing 且 startedAt 未变（没有丢失租约）时才算续租成功。
   * 用显式 updatedAt 而不是依赖 @updatedAt 隐式更新，避免空 update 不生效。
   */
  async heartbeat(id: string, startedAt: Date | null): Promise<boolean> {
    const result = await this.prisma.processingJob.updateMany({
      where: this.processingWhere(id, startedAt),
      data: { updatedAt: new Date() },
    });
    return result.count === 1;
  }

  /**
   * 取消活跃任务（pending/processing → canceled）
   * 终态任务不会被改动，返回 false。
   */
  async cancelActive(id: string, errorMessage?: string | null): Promise<boolean> {
    const result = await this.prisma.processingJob.updateMany({
      where: {
        id,
        status: { in: [JobStatus.pending, JobStatus.processing] },
      },
      data: {
        status: JobStatus.canceled,
        finishedAt: new Date(),
        ...(errorMessage !== undefined ? { errorMessage } : {}),
      },
    });
    return result.count === 1;
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
