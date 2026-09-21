import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import { IJobScheduler, JOB_SCHEDULER } from './interfaces/job-scheduler.interface';
import { MetadataDetector } from './processors/metadata-detector.processor';
import { ThumbnailGenerator } from './processors/thumbnail-generator.processor';
import { VideoCoverGenerator } from './processors/video-cover-generator.processor';
import { TextExtractor } from './processors/text-extractor.processor';

/**
 * 处理器注册中心
 *
 * 在模块初始化时将各 IJobProcessor 注册到 IJobScheduler，
 * 实现 jobType → handler 的映射。
 *
 * 添加新 Processor 时：创建实现 IJobProcessor 的类，在此注册即可。
 */
@Injectable()
export class ProcessorRegistry implements OnModuleInit {
  private readonly logger = new Logger(ProcessorRegistry.name);

  constructor(
    @Inject(JOB_SCHEDULER) private readonly scheduler: IJobScheduler,
    private readonly metadataDetector: MetadataDetector,
    private readonly thumbnailGenerator: ThumbnailGenerator,
    private readonly videoCoverGenerator: VideoCoverGenerator,
    private readonly textExtractor: TextExtractor,
  ) {}

  onModuleInit(): void {
    // 注册元数据检测
    this.scheduler.onJobType(this.metadataDetector.jobType, async (job) => {
      await this.metadataDetector.process(job.resourceId, job.id);
    });

    // 注册缩略图生成
    this.scheduler.onJobType(this.thumbnailGenerator.jobType, async (job) => {
      await this.thumbnailGenerator.process(job.resourceId, job.id);
    });

    // 注册视频封面生成
    this.scheduler.onJobType(this.videoCoverGenerator.jobType, async (job) => {
      await this.videoCoverGenerator.process(job.resourceId, job.id);
    });

    // 注册文本提取
    this.scheduler.onJobType(this.textExtractor.jobType, async (job) => {
      await this.textExtractor.process(job.resourceId, job.id);
    });

    this.logger.log('All job processors registered');
  }
}
