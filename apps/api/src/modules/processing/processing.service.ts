import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ProcessingJobRepository } from './repositories/processing-job.repository';
import { ResourceRepository } from '../resource/repositories/resource.repository';
import { JobStatus, ProcessingStatus } from '../../common/constants/enums';
import { QueryProcessingJobsDto } from './dto/query-processing-jobs.dto';

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

  /** 重试失败任务：重置为 pending */
  async retryJob(jobId: string) {
    const job = await this.jobRepo.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    if (job.status === JobStatus.completed) {
      throw new BadRequestException('Cannot retry a completed job');
    }
    if (job.status === JobStatus.processing) {
      throw new BadRequestException('Job is currently processing');
    }
    await this.jobRepo.updateStatus(jobId, JobStatus.pending, null);
    await this.resourceRepo.updateProcessingStatus(job.resourceId, ProcessingStatus.processing);
    return { id: jobId, status: JobStatus.pending };
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
