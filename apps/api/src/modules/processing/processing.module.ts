import { Module } from '@nestjs/common';
import { ProcessingJobRepository } from './repositories/processing-job.repository';

/**
 * 处理任务模块
 * 职责：创建任务、调度 Worker、更新处理状态
 * 阶段1-5：ProcessingJobRepository 仅创建 pending 记录
 */
@Module({
  providers: [ProcessingJobRepository],
  exports: [ProcessingJobRepository],
})
export class ProcessingModule {}
