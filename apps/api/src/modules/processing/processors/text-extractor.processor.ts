import { Injectable, Inject, Logger } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import pdfParse from 'pdf-parse';
import { IJobProcessor } from '../interfaces/job-processor.interface';
import { streamStorageToTemp, readTextCapped } from '../temp-file.util';
import { ResourceRepository } from '../../resource/repositories/resource.repository';
import { ResourceFileRepository } from '../../file/repositories/resource-file.repository';
import {
  IStorageService,
  STORAGE_SERVICE,
} from '../../storage/interfaces/storage-service.interface';
import { FileRole, JobType } from '../../../common/constants/enums';

/** 提取文本最大长度（1MB 字符） */
const MAX_TEXT = 1_000_000;

/**
 * 读取上限对应的字节数：UTF-8 单字符最多 4 字节，
 * 按此上限流式截读可保证在文件足够大时拿到完整的 MAX_TEXT 字符。
 */
const MAX_TEXT_BYTES = MAX_TEXT * 4;

/** searchVector 最大长度 */
const MAX_SEARCH_VECTOR = 10_000;

/**
 * 文本提取处理器
 *
 * - PDF：使用 pdf-parse 提取文本
 * - 纯文本文件：直接读取 UTF-8 内容
 * - Office 文档（docx/pptx/xlsx）：第一版不提取，只记录文件元数据
 *
 * 提取的文本作为派生文件（ResourceFile, fileRole=extracted_text）存入 storage，
 * 同时写入 resources.searchVector 用于全文搜索。
 */
@Injectable()
export class TextExtractor implements IJobProcessor {
  readonly jobType = JobType.extract_text;
  private readonly logger = new Logger(TextExtractor.name);

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

    let extractedText = '';

    if (resource.mimeType === 'application/pdf') {
      // PDF：pdf-parse 需要完整 Buffer，先流式落盘再从临时文件读取
      const tmpPath = await streamStorageToTemp(this.storage, originalFile.storagePath, 'text-in');
      try {
        const buf = await fs.readFile(tmpPath);
        extractedText = await this.extractPdf(buf);
      } finally {
        await fs.unlink(tmpPath).catch(() => {});
      }
    } else {
      // 纯文本：只读取需要保留的前缀，避免把整个大文本文件读入内存
      const stream = await this.storage.getStream(originalFile.storagePath);
      extractedText = await readTextCapped(stream, MAX_TEXT_BYTES);
    }

    // 截断至合理大小
    if (extractedText.length > MAX_TEXT) {
      extractedText = extractedText.slice(0, MAX_TEXT);
    }

    if (extractedText.length === 0) {
      this.logger.warn(`No text extracted for resource ${resourceId}`);
      return;
    }

    // 存储提取文本
    if (!resource.sha256) {
      throw new Error(`Resource ${resourceId} has no sha256 hash; cannot generate storage key`);
    }
    const hash = resource.sha256;
    const storageKey = this.storage.generateKey(FileRole.extracted_text, hash, undefined, 'txt');
    const textBuffer = Buffer.from(extractedText, 'utf-8');
    await this.storage.put(storageKey, textBuffer);

    // 创建派生文件记录（幂等）
    const existing = await this.fileRepo.findByResourceAndRole(resourceId, FileRole.extracted_text);
    if (!existing) {
      await this.fileRepo.create({
        resource: { connect: { id: resourceId } },
        fileRole: FileRole.extracted_text,
        variant: '',
        storagePath: storageKey,
        mimeType: 'text/plain',
        extension: 'txt',
        sizeBytes: BigInt(textBuffer.length),
      });
    }

    // 更新 searchVector（SQLite 存纯文本，PG 后用 to_tsvector）
    await this.resourceRepo.update(resourceId, {
      searchVector: extractedText.slice(0, MAX_SEARCH_VECTOR),
    });

    this.logger.log(`Text extracted for resource ${resourceId} (${extractedText.length} chars)`);
  }

  /**
   * 使用 pdf-parse 提取 PDF 文本
   * 解析失败时抛出错误，由调度器决定重试或标记失败
   */
  private async extractPdf(buffer: Buffer): Promise<string> {
    const data = await pdfParse(buffer);
    return data.text || '';
  }
}
