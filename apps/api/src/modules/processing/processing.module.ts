import { Module, forwardRef } from '@nestjs/common';
import { ProcessingJobRepository } from './repositories/processing-job.repository';
import { PollingJobScheduler } from './polling-job-scheduler';
import { JOB_SCHEDULER } from './interfaces/job-scheduler.interface';
import { ProcessingController } from './processing.controller';
import { ProcessingService } from './processing.service';
import { MetadataDetector } from './processors/metadata-detector.processor';
import { ThumbnailGenerator } from './processors/thumbnail-generator.processor';
import { VideoCoverGenerator } from './processors/video-cover-generator.processor';
import { TextExtractor } from './processors/text-extractor.processor';
import { ProcessorRegistry } from './processor-registry';
import { TempCleanupCron } from './temp-cleanup-cron';
import { ResourceModule } from '../resource/resource.module';
import { FileModule } from '../file/file.module';
import { StorageModule } from '../storage/storage.module';

/**
 * 处理任务模块（阶段 6：Worker 与异步处理）
 *
 * 职责：
 * - 任务调度（PollingJobScheduler）— 轮询 processing_jobs 表，分发到处理器
 * - 任务管理 API — 列表、统计、重试
 * - 处理器注册 — MetadataDetector / ThumbnailGenerator / VideoCoverGenerator / TextExtractor
 * - 临时文件清理 — TempCleanupCron（每小时）
 *
 * 架构：通过 JOB_SCHEDULER token 注入 IJobScheduler 实现。
 * 当前为进程内轮询（PollingJobScheduler），未来切换 Redis+BullMQ 只需改 useClass。
 */
@Module({
  imports: [forwardRef(() => ResourceModule), FileModule, StorageModule],
  controllers: [ProcessingController],
  providers: [
    ProcessingJobRepository,
    ProcessingService,
    // IJobScheduler 实现：切换 Redis 时改为 BullMQJobScheduler
    {
      provide: JOB_SCHEDULER,
      useClass: PollingJobScheduler,
    },
    // 处理器
    MetadataDetector,
    ThumbnailGenerator,
    VideoCoverGenerator,
    TextExtractor,
    // 注册 + 定时清理
    ProcessorRegistry,
    TempCleanupCron,
  ],
  exports: [JOB_SCHEDULER, ProcessingJobRepository],
})
export class ProcessingModule {}
