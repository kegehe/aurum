import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ProcessingJobRepository } from './repositories/processing-job.repository';
import { ResourceRepository } from '../resource/repositories/resource.repository';
import { JobStatus } from '../../common/constants/enums';
import { QueryProcessingJobsDto } from './dto/query-processing-jobs.dto';
import { resolveResourceProcessingStatus } from './resource-status.util';

/**
 * 处理任务应用服务
 * 职责：任务列表查询、统计、重试
 */
@Injectable()
export class ProcessingService {
  constructor(
    private readonly jobRepo: ProcessingJobRepository,
    private readonly resourceRepo: ResourceRepository,
  ) {}

  /** 分页查询任务列表 */
  async listJobs(query: QueryProcessingJobsDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const { items, total } = await this.jobRepo.findMany({
      status: query.status,
      jobType: query.jobType,
      resourceId: query.resourceId,
      page,
      pageSize,
    });

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /** 获取各状态任务统计 */
  async getStats() {
    return this.jobRepo.stats();
  }

  /** 重试已失败/已取消的任务：原子地重置为 pending */
  async retryJob(jobId: string) {
    const job = await this.jobRepo.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    if (job.status === JobStatus.completed) {
      throw new BadRequestException('Cannot retry a completed job');
    }
    if (job.status === JobStatus.processing) {
      throw new BadRequestException('Job is currently processing; cancel it before retrying');
    }
    if (job.status === JobStatus.pending) {
      throw new BadRequestException('Job is already queued');
    }
    // 同资源同类型已有活跃任务时不再重排，否则会出现两条并行执行的同类任务
    const hasActiveSibling = (await this.jobRepo.findByResourceId(job.resourceId)).some(
      (j) =>
        j.id !== jobId &&
        j.jobType === job.jobType &&
        (j.status === JobStatus.pending || j.status === JobStatus.processing),
    );
    if (hasActiveSibling) {
      throw new BadRequestException('An active job of the same type already exists');
    }
    // 条件更新：期间被认领/完成时不会把正在执行的任务改回 pending
    if (!(await this.jobRepo.requeueTerminal(jobId))) {
      throw new BadRequestException('Job is no longer retryable');
    }
    // 按资源全部任务重算，而不是无条件写 pending：同资源可能还有别的任务在跑
    await this.refreshResourceStatus(job.resourceId);
    return { id: jobId, status: JobStatus.pending };
  }

  /**
   * 取消活跃任务（待处理 / 处理中）
   *
   * 这是卡住任务的恢复入口：取消后任务变为终态，可以重新排队或删除，
   * 同资源的「重新处理」也不会再被去重逻辑跳过。
   * 正在执行的处理器不会被强杀，但其结果会因状态流转条件而无法覆盖「已取消」。
   */
  async cancelJob(jobId: string) {
    const job = await this.jobRepo.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    if (job.status !== JobStatus.pending && job.status !== JobStatus.processing) {
      throw new BadRequestException('Job is already finished');
    }
    if (!(await this.jobRepo.cancelActive(jobId, 'Canceled by user'))) {
      throw new BadRequestException('Job is no longer active');
    }
    await this.refreshResourceStatus(job.resourceId);
    return { id: jobId, status: JobStatus.canceled };
  }

  /** 根据资源全部任务重算 processingStatus（与调度器共用同一份判定） */
  private async refreshResourceStatus(resourceId: string): Promise<void> {
    const jobs = await this.jobRepo.findByResourceId(resourceId);
    await this.resourceRepo.updateProcessingStatus(
      resourceId,
      resolveResourceProcessingStatus(jobs),
    );
  }

  /** 删除指定已结束（terminal）的任务记录；活跃任务需先取消 */
  async deleteJob(jobId: string) {
    const job = await this.jobRepo.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    if (job.status === JobStatus.pending || job.status === JobStatus.processing) {
      throw new BadRequestException('Cannot delete an active job');
    }
    if (!(await this.jobRepo.deleteTerminal(jobId))) {
      throw new BadRequestException('Job is no longer terminal');
    }
    return { id: jobId, deleted: true };
  }

  /** 清空所有已结束（terminal）的任务记录 */
  async clearJobs() {
    const deleted = await this.jobRepo.clearTerminal();
    return { deleted };
  }
}
