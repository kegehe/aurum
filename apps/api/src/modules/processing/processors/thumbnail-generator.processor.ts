import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { IJobProcessor } from '../interfaces/job-processor.interface';
import { ResourceRepository } from '../../resource/repositories/resource.repository';
import { ResourceFileRepository } from '../../file/repositories/resource-file.repository';
import {
  IStorageService,
  STORAGE_SERVICE,
} from '../../storage/interfaces/storage-service.interface';
import { FileRole, JobType } from '../../../common/constants/enums';

/**
 * 缩略图生成处理器
 *
 * 使用 Sharp 将图片缩放至配置的最大宽高内（保持比例），输出 WebP 格式。
 * 缩略图作为派生文件（ResourceFile, fileRole=thumbnail）存入 storage。
 */
@Injectable()
export class ThumbnailGenerator implements IJobProcessor {
  readonly jobType = JobType.generate_thumbnail;
  private readonly logger = new Logger(ThumbnailGenerator.name);

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: IStorageService,
    private readonly resourceRepo: ResourceRepository,
    private readonly fileRepo: ResourceFileRepository,
    private readonly config: ConfigService,
  ) {}

  async process(resourceId: string, _jobId: string): Promise<void> {
    const resource = await this.resourceRepo.findById(resourceId);
    if (!resource) {
      throw new Error(`Resource ${resourceId} not found`);
    }

    const originalFile = await this.fileRepo.findByResourceAndRole(
      resourceId,
      FileRole.original,
    );
    if (!originalFile) {
      throw new Error(`No original file for ${resourceId}`);
    }

    const maxW = this.config.get<number>('thumbnail.maxWidth')!;
    const maxH = this.config.get<number>('thumbnail.maxHeight')!;

    // 下载到临时文件（使用 UUID 避免并发/重试碰撞）
    const tmpIn = path.join(os.tmpdir(), `thumb-in-${randomUUID()}`);
    const tmpOut = path.join(os.tmpdir(), `thumb-out-${randomUUID()}.webp`);
    const buf = await this.storage.get(originalFile.storagePath);
    await fs.writeFile(tmpIn, buf);

    try {
      // Sharp 缩放并输出 WebP
      await sharp(tmpIn)
        .resize(maxW, maxH, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(tmpOut);

      const stats = await fs.stat(tmpOut);

      // 生成 storage key 并写入正式存储
      const hash = resource.sha256!;
      const storageKey = this.storage.generateKey(
        FileRole.thumbnail,
        hash,
        undefined,
        'webp',
      );

      const stream = createReadStream(tmpOut);
      await this.storage.put(storageKey, stream);

      // 创建派生文件记录（幂等：已存在则跳过）
      const existing = await this.fileRepo.findByResourceAndRole(
        resourceId,
        FileRole.thumbnail,
      );
      if (!existing) {
        await this.fileRepo.create({
          resource: { connect: { id: resourceId } },
          fileRole: FileRole.thumbnail,
          variant: '',
          storagePath: storageKey,
          mimeType: 'image/webp',
          extension: 'webp',
          sizeBytes: BigInt(stats.size),
        });
      }

      this.logger.log(
        `Thumbnail generated for resource ${resourceId} (${stats.size} bytes)`,
      );
    } finally {
      await fs.unlink(tmpIn).catch(() => {});
      await fs.unlink(tmpOut).catch(() => {});
    }
  }
}
