import { Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ProcessingService } from './processing.service';
import { QueryProcessingJobsDto } from './dto/query-processing-jobs.dto';

/**
 * 处理任务控制器
 *
 * 提供任务列表、统计和重试接口。
 * 任务由 Worker（PollingJobScheduler）自动消费，此控制器仅做查询和管理。
 */
@Controller('processing')
export class ProcessingController {
  constructor(private readonly processingService: ProcessingService) {}

  /** 分页查询处理任务列表 */
  @Get('jobs')
  listJobs(@Query() query: QueryProcessingJobsDto) {
    return this.processingService.listJobs(query);
  }

  /** 获取处理任务统计 */
  @Get('stats')
  stats() {
    return this.processingService.getStats();
  }

  /** 重试失败任务 */
  @Post('jobs/:jobId/retry')
  retryJob(@Param('jobId') jobId: string) {
    return this.processingService.retryJob(jobId);
  }

  /** 删除指定已结束（terminal）的任务记录 */
  @Delete('jobs/:jobId')
  deleteJob(@Param('jobId') jobId: string) {
    return this.processingService.deleteJob(jobId);
  }

  /** 清空所有已结束（terminal）的任务记录 */
  @Delete('jobs')
  clearJobs() {
    return this.processingService.clearJobs();
  }
}
