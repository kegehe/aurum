import { Injectable, Inject, Logger } from '@nestjs/common';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import ffmpeg from 'fluent-ffmpeg';
import { IJobProcessor } from '../interfaces/job-processor.interface';
import { streamStorageToTemp } from '../temp-file.util';
import { ResourceRepository } from '../../resource/repositories/resource.repository';
import { ResourceFileRepository } from '../../file/repositories/resource-file.repository';
import {
  IStorageService,
  STORAGE_SERVICE,
} from '../../storage/interfaces/storage-service.interface';
import { FileRole, JobType } from '../../../common/constants/enums';

/**
 * 视频封面生成处理器
 *
 * 使用 FFmpeg 从视频第 1 秒截取一帧作为封面图（JPEG）。
 * 封面作为派生文件（ResourceFile, fileRole=thumbnail）存入 storage。
 */
@Injectable()
export class VideoCoverGenerator implements IJobProcessor {
  readonly jobType = JobType.generate_video_cover;
  private readonly logger = new Logger(VideoCoverGenerator.name);

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: IStorageService,
    private readonly resourceRepo: ResourceRepository,
    private readonly fileRepo: ResourceFileRepository,
  ) {}

  async process(resourceId: string, _jobId: string): Promise<void> {
    const resource = await this.resourceRepo.findById(resourceId);
    if (!resource) {
      throw new Error(`Resource ${resourceId} not found`);
    }

    const originalFile = await this.fileRepo.findByResourceAndRole(resourceId, FileRole.original);
    if (!originalFile) {
      throw new Error(`No original file for ${resourceId}`);
    }

    // 流式下载到临时文件（FFmpeg 需要文件路径，不能直接用流）
    const tmpIn = await streamStorageToTemp(this.storage, originalFile.storagePath, 'vcover-in');
    const tmpOut = path.join(os.tmpdir(), `vcover-out-${randomUUID()}.jpg`);

    try {
      // FFmpeg 截取第 1 秒的一帧
      await new Promise<void>((resolve, reject) => {
        ffmpeg(tmpIn)
          .seekInput(1)
          .frames(1)
          .output(tmpOut)
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err))
          .run();
      });

      const stats = await fs.stat(tmpOut);

      // 生成 storage key 并写入正式存储
      const hash = resource.sha256!;
      const storageKey = this.storage.generateKey(FileRole.thumbnail, hash, undefined, 'jpg');

      const stream = createReadStream(tmpOut);
      await this.storage.put(storageKey, stream);

      // 创建派生文件记录（幂等：已存在则跳过）
      const existing = await this.fileRepo.findByResourceAndRole(resourceId, FileRole.thumbnail);
      if (!existing) {
        await this.fileRepo.create({
          resource: { connect: { id: resourceId } },
          fileRole: FileRole.thumbnail,
          variant: '',
          storagePath: storageKey,
          mimeType: 'image/jpeg',
          extension: 'jpg',
          sizeBytes: BigInt(stats.size),
        });
      }

      this.logger.log(`Video cover generated for resource ${resourceId} (${stats.size} bytes)`);
    } finally {
      await fs.unlink(tmpIn).catch(() => {});
      await fs.unlink(tmpOut).catch(() => {});
    }
  }
}
