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
import {
  AcquisitionMode,
  FileRole,
  JobStatus,
  JobType,
  ProcessingStatus,
} from '../../common/constants/enums';
import { inferResourceType } from './resource-type.util';
import { UploadResourceDto } from './dto/upload-resource.dto';
import {
  assertCategoryExists,
  categoryDoesNotExistError,
  isCategoryConnectError,
} from '../../common/utils/category.validation';

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

    // 校验分类存在（分类可能已被并发删除）。
    // 放在文件写入存储之前：若分类无效，既避免事务中 connect 抛数据库外键错误变成 500，
    // 也避免在存储里留下孤儿文件。
    if (body.categoryId) {
      try {
        await assertCategoryExists(
          (categoryId) => this.prisma.category.findUnique({ where: { id: categoryId } }),
          body.categoryId,
        );
      } catch (error) {
        // 分类无效：清理 multer 临时文件，避免残留磁盘
        await this.cleanupTemp(file.path);
        throw error;
      }
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
    let result: UploadResult;
    try {
      result = await this.prisma.$transaction(async (tx) => {
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
            acquisitionMode: AcquisitionMode.local_upload,
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
    } catch (error) {
      // 文件在事务之前就已移入正式存储，所以任何事务失败（SQLite busy、约束/外键错误
      // 等）都会留下没有 resource_files 引用的孤儿对象，必须统一兜底回收。
      // 内容寻址 key 可能被其它资源共用，清理前做引用检查（见 deleteStorageKeyIfUnreferenced）。
      await this.deleteStorageKeyIfUnreferenced(storageKey);

      // 分类在"校验"与"写入"之间被并发删除时，把 connect 的 P2025 转成可读的 400。
      // 这里只用 isCategoryConnectError：上传事务里 category 通过 connect 写入（P2025），
      // 避免把极罕见的 duplicateOf 外键 P2003 误判为分类问题。
      if (isCategoryConnectError(error)) {
        throw categoryDoesNotExistError(body.categoryId ?? null);
      }
      throw error;
    }

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
   * 事务失败后的兜底清理。
   *
   * storage key 按内容哈希生成：上传的是一份已存在的重复文件时，这个 key
   * 正被已有资源引用，无条件删除会连带清掉对方的原文件。只在没有任何
   * 资源文件引用时才删。
   */
  private async deleteStorageKeyIfUnreferenced(storageKey: string): Promise<void> {
    try {
      const references = await this.fileRepo.findStoragePathReferences([storageKey]);
      const resourceIds = references.get(storageKey);
      if (resourceIds && resourceIds.size > 0) {
        this.logger.warn(
          `Keep uploaded file ${storageKey}: still referenced by ${resourceIds.size} resource(s)`,
        );
        return;
      }
      await this.storage.delete(storageKey);
    } catch (cleanupError) {
      // 清理失败不应掩盖原始错误（数据库不可用时引用检查也会失败，此时保守保留）；
      // 残留文件可通过一致性检查列出并处理
      this.logger.warn(
        `Failed to clean up unreferenced upload ${storageKey}: ${
          cleanupError instanceof Error ? cleanupError.message : cleanupError
        }`,
      );
    }
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
      // put 成功后才删除临时文件
      await this.cleanupTemp(tempPath);
    } catch (err) {
      // put 失败时确保 stream 被销毁，释放文件句柄
      // 不删除临时文件，保留数据以支持重试
      stream.destroy();
      throw err;
    }
  }

  private async cleanupTemp(tempPath: string): Promise<void> {
    return new Promise<void>((resolve) => {
      unlink(tempPath, () => resolve());
    });
  }
}
