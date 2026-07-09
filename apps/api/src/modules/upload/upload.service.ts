import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { createReadStream, unlink } from 'node:fs';
import * as path from 'node:path';
// file-type@16 是 CommonJS，默认导出含 fromFile 方法（v17+ 改名为 fileTypeFromFile）
import fileType from 'file-type';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceRepository } from '../resource/repositories/resource.repository';
import { ResourceFileRepository } from '../file/repositories/resource-file.repository';
import { ProcessingJobRepository } from '../processing/repositories/processing-job.repository';
import { IStorageService, STORAGE_SERVICE } from '../storage/interfaces/storage-service.interface';
import { FileRole, JobStatus, JobType, ProcessingStatus } from '../../common/constants/enums';
import { inferResourceType } from './resource-type.util';
import { UploadResourceDto } from './dto/upload-resource.dto';

export interface UploadResult {
  resource: {
    id: string;
    title: string;
    resourceType: string;
    mimeType: string;
    sizeBytes: string;
    sha256: string | null;
    processingStatus: string;
    isDuplicate: boolean;
    duplicateOfId: string | null;
  };
}

export interface BatchUploadResult {
  results: Array<
    | { success: true; resource: UploadResult['resource'] }
    | { success: false; filename: string; error: string }
  >;
}

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: IStorageService,
    private readonly resourceRepo: ResourceRepository,
    private readonly fileRepo: ResourceFileRepository,
    private readonly jobRepo: ProcessingJobRepository,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 处理单个文件上传
   *
   * 流程：
   * 1. 校验单文件大小
   * 2. 流式计算 SHA-256
   * 3. 识别真实 MIME（file-type）+ 扩展名 -> 推断资源类型
   * 4. 生成正式 storage key 并移动文件
   * 5. 事务：查重 -> 创建 Resource + ResourceFile + ProcessingJob
   */
  async handleUpload(file: Express.Multer.File, body: UploadResourceDto): Promise<UploadResult> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // 1. 校验单文件大小
    const maxSizeMB = this.config.get<number>('upload.maxFileSizeMB')!;
    const maxSize = maxSizeMB * 1024 * 1024;
    if (file.size > maxSize) {
      await this.cleanupTemp(file.path);
      throw new BadRequestException(
        `File size ${file.size} exceeds limit ${maxSize} bytes (${maxSizeMB}MB)`,
      );
    }

    // 2. 计算 SHA-256
    const sha256 = await this.computeSha256(file.path);

    // 3. 识别 MIME + 扩展名 + 资源类型
    const detectedMime = await this.detectMimeType(file.path);
    const extension = path.extname(file.originalname).slice(1).toLowerCase();
    // file-type 可能返回空，回退到 multer 给的 mimetype
    const mimeType = detectedMime || file.mimetype || 'application/octet-stream';
    const resourceType = inferResourceType(mimeType, extension);

    // 4. 生成正式 storage key 并移动文件
    const storageKey = this.storage.generateKey(FileRole.original, sha256, undefined, extension);
    await this.moveTempToStorage(file.path, storageKey);

    // 5. 数据库事务
    const result = await this.prisma.$transaction(async (tx) => {
      // 查重：已存在相同 sha256 的资源
      const existing = await this.resourceRepo.findBySha256(sha256, tx);

      // 创建资源记录
      const resource = await this.resourceRepo.create(
        {
          title: body.title || file.originalname,
          description: body.description,
          originalFilename: file.originalname,
          resourceType,
          mimeType,
          extension,
          sizeBytes: BigInt(file.size),
          sha256,
          category: body.categoryId ? { connect: { id: body.categoryId } } : undefined,
          source: body.source,
          author: body.author,
          licenseNote: body.licenseNote,
          processingStatus: ProcessingStatus.pending,
          duplicateOf: existing ? { connect: { id: existing.id } } : undefined,
        },
        tx,
      );

      // 创建原文件记录
      await this.fileRepo.create(
        {
          resource: { connect: { id: resource.id } },
          fileRole: FileRole.original,
          variant: '',
          storagePath: storageKey,
          mimeType,
          extension,
          sizeBytes: BigInt(file.size),
        },
        tx,
      );

      // 创建处理任务（仅记录，不执行 —— 阶段6接 Worker）
      await this.jobRepo.create(
        {
          resource: { connect: { id: resource.id } },
          jobType: JobType.detect_metadata,
          status: JobStatus.pending,
        },
        tx,
      );

      return {
        resource: {
          id: resource.id,
          title: resource.title,
          resourceType: resource.resourceType,
          mimeType: resource.mimeType,
          sizeBytes: resource.sizeBytes.toString(),
          sha256: resource.sha256,
          processingStatus: resource.processingStatus,
          isDuplicate: !!existing,
          duplicateOfId: existing?.id ?? null,
        },
      };
    });

    this.logger.log(
      `Uploaded resource ${result.resource.id} (${resourceType}, ${file.size} bytes, dup=${result.resource.isDuplicate})`,
    );
    return result;
  }

  /**
   * 批量上传：每个文件独立处理，单个失败不影响其他
   */
  async handleBatchUpload(
    files: Express.Multer.File[],
    body: UploadResourceDto,
  ): Promise<BatchUploadResult> {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files provided');
    }

    // 校验批量总大小
    const maxTotalMB = this.config.get<number>('upload.maxTotalSizeMB')!;
    const maxTotal = maxTotalMB * 1024 * 1024;
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    if (totalSize > maxTotal) {
      // 清理所有临时文件
      await Promise.all(files.map((f) => this.cleanupTemp(f.path)));
      throw new BadRequestException(
        `Batch total size ${totalSize} exceeds limit ${maxTotal} bytes (${maxTotalMB}MB)`,
      );
    }

    const results: BatchUploadResult['results'] = [];
    for (const file of files) {
      try {
        const uploadResult = await this.handleUpload(file, body);
        results.push({ success: true, resource: uploadResult.resource });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        results.push({ success: false, filename: file.originalname, error });
      }
    }
    return { results };
  }

  /**
   * 流式计算文件 SHA-256（避免大文件读入内存）
   */
  private async computeSha256(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    for await (const chunk of stream) {
      hash.update(chunk);
    }
    return hash.digest('hex');
  }

  /**
   * 使用 file-type 识别真实 MIME（不信任客户端 Content-Type）
   * file-type@16 是 CommonJS，默认导出含 fromFile 方法。
   * file-type v17+ 将 fromFile 改名为 fileTypeFromFile（纯 ESM），
   * 若升级依赖需同步修改此处调用。
   */
  private async detectMimeType(filePath: string): Promise<string | null> {
    try {
      const result = await fileType.fromFile(filePath);
      return result?.mime ?? null;
    } catch (e) {
      this.logger.warn(`file-type detection failed: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /**
   * 移动临时文件到正式存储位置
   * 使用 createReadStream 流式读取，避免大文件（最大 1GB）全部读入内存
   */
  private async moveTempToStorage(tempPath: string, storageKey: string): Promise<void> {
    const stream = createReadStream(tempPath);
    try {
      await this.storage.put(storageKey, stream);
    } catch (err) {
      // put 失败时确保 stream 被销毁，释放文件句柄
      stream.destroy();
      throw err;
    } finally {
      await this.cleanupTemp(tempPath);
    }
  }

  private async cleanupTemp(tempPath: string): Promise<void> {
    return new Promise<void>((resolve) => {
      unlink(tempPath, () => resolve());
    });
  }
}
