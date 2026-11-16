import { Injectable, Inject, Logger } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import sharp from 'sharp';
import { Prisma } from '@prisma/client';
import { IJobProcessor } from '../interfaces/job-processor.interface';
import { streamStorageToTemp } from '../temp-file.util';
import { probeMedia, type MediaProbeResult } from '../ffmpeg.util';
import { IJobScheduler, JOB_SCHEDULER } from '../interfaces/job-scheduler.interface';
import { ResourceRepository } from '../../resource/repositories/resource.repository';
import { ResourceFileRepository } from '../../file/repositories/resource-file.repository';
import {
  IStorageService,
  STORAGE_SERVICE,
} from '../../storage/interfaces/storage-service.interface';
import { ProcessingJobRepository } from '../repositories/processing-job.repository';
import {
  ResourceType,
  FileRole,
  JobType,
  ProcessingStatus,
  JobStatus,
} from '../../../common/constants/enums';

/**
 * 元数据检测处理器
 *
 * - 图片：使用 Sharp 读取宽高
 * - 视频：使用 ffprobe 读取分辨率 + 时长
 * - 音频：使用 ffprobe 读取时长
 * - 其他类型：不做额外检测
 *
 * 完成后链式创建下游任务：
 *   image → generate_thumbnail
 *   video → generate_video_cover
 *   text/pdf → extract_text
 */
@Injectable()
export class MetadataDetector implements IJobProcessor {
  readonly jobType = JobType.detect_metadata;
  private readonly logger = new Logger(MetadataDetector.name);

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: IStorageService,
    @Inject(JOB_SCHEDULER) private readonly scheduler: IJobScheduler,
    private readonly resourceRepo: ResourceRepository,
    private readonly fileRepo: ResourceFileRepository,
    private readonly jobRepo: ProcessingJobRepository,
  ) {}

  async process(resourceId: string, _jobId: string): Promise<void> {
    const resource = await this.resourceRepo.findById(resourceId);
    if (!resource) {
      throw new Error(`Resource ${resourceId} not found`);
    }

    const originalFile = await this.fileRepo.findByResourceAndRole(resourceId, FileRole.original);
    if (!originalFile) {
      throw new Error(`Original file for resource ${resourceId} not found`);
    }

    // 流式下载到临时文件（Sharp/FFprobe 需要文件路径，不能直接用流）
    const tempPath = await streamStorageToTemp(this.storage, originalFile.storagePath, 'meta');

    try {
      switch (resource.resourceType) {
        case ResourceType.image:
          await this.detectImage(resourceId, tempPath);
          break;
        case ResourceType.video:
          await this.detectVideo(resourceId, tempPath);
          break;
        case ResourceType.audio:
          await this.detectAudio(resourceId, tempPath);
          break;
        default:
          this.logger.debug(`No metadata detection for resource type: ${resource.resourceType}`);
      }
    } finally {
      await fs.unlink(tempPath).catch(() => {});
    }

    // 链式创建下游任务（在下游任务创建前，保持 processing 状态）
    await this.chainDownstreamJobs(resource);

    // 只有在没有下游任务时才标记 completed（否则由调度器统一按全部任务重算）
    const allJobs = await this.jobRepo.findByResourceId(resourceId);
    const hasDownstream = allJobs.some(
      (j) =>
        j.jobType !== JobType.detect_metadata &&
        (j.status === JobStatus.pending || j.status === JobStatus.processing),
    );
    if (!hasDownstream) {
      await this.resourceRepo.updateProcessingStatus(resourceId, ProcessingStatus.completed);
    }
  }

  // ==================== 私有方法 ====================

  private async detectImage(resourceId: string, filePath: string): Promise<void> {
    try {
      const metadata = await sharp(filePath).metadata();
      await this.resourceRepo.update(resourceId, {
        width: metadata.width ?? null,
        height: metadata.height ?? null,
      });
      this.logger.log(`Image metadata: ${metadata.width}x${metadata.height} for ${resourceId}`);
    } catch (err) {
      throw new Error(
        `Sharp metadata detection failed for ${resourceId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async detectVideo(resourceId: string, filePath: string): Promise<void> {
    const probe = await this.probe(resourceId, filePath);
    const videoStream = probe.streams.find((s) => s.codecType === 'video');
    const updateData: Prisma.ResourceUpdateInput = {
      durationSeconds: probe.durationSeconds,
    };
    if (videoStream) {
      updateData.width = videoStream.width;
      updateData.height = videoStream.height;
    }
    await this.saveMetadata(resourceId, 'video', updateData);
    this.logger.log(
      `Video metadata: ${videoStream?.width ?? '?'}x${videoStream?.height ?? '?'}, ${probe.durationSeconds ?? '?'}s for ${resourceId}`,
    );
  }

  private async detectAudio(resourceId: string, filePath: string): Promise<void> {
    const probe = await this.probe(resourceId, filePath);
    await this.saveMetadata(resourceId, 'audio', {
      durationSeconds: probe.durationSeconds,
    });
    this.logger.log(`Audio metadata: duration=${probe.durationSeconds ?? '?'}s for ${resourceId}`);
  }

  /** ffprobe 带硬超时（内部会 kill 子进程），失败原因统一包装到资源上下文 */
  private async probe(resourceId: string, filePath: string): Promise<MediaProbeResult> {
    try {
      return await probeMedia(filePath);
    } catch (err) {
      throw new Error(
        `FFprobe failed for resource ${resourceId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async saveMetadata(
    resourceId: string,
    kind: 'video' | 'audio',
    data: Prisma.ResourceUpdateInput,
  ): Promise<void> {
    try {
      await this.resourceRepo.update(resourceId, data);
    } catch (err) {
      throw new Error(
        `Failed to save ${kind} metadata for ${resourceId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 根据资源类型链式创建下游处理任务
   */
  private async chainDownstreamJobs(resource: {
    id: string;
    resourceType: string;
    mimeType: string;
  }): Promise<void> {
    const { id, resourceType, mimeType } = resource;

    if (resourceType === ResourceType.image) {
      await this.scheduler.enqueue(JobType.generate_thumbnail, id);
    } else if (resourceType === ResourceType.video) {
      await this.scheduler.enqueue(JobType.generate_video_cover, id);
    } else if (resourceType === ResourceType.text || mimeType === 'application/pdf') {
      await this.scheduler.enqueue(JobType.extract_text, id);
    }
  }
}
