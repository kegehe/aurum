import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs/promises';
import pdfParse from 'pdf-parse/lib/pdf-parse';
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
 * PDF 文本提取的内存上限（MB）默认值，可由 MAX_PDF_PARSE_SIZE_MB 覆盖。
 *
 * pdf-parse 只接受完整 Buffer，解析期间文件需整份常驻内存；上限 100MB 实测单任务
 * 峰值约 150MB，非 ASCII 长文本（UTF-16 双字节）会更高，按并发数叠加后仍可承受。
 */
const DEFAULT_MAX_PDF_PARSE_MB = 100;

/**
 * 文本提取处理器
 *
 * - PDF：使用 pdf-parse 提取文本，超过内存上限的 PDF 跳过（只记录警告）
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
    private readonly config: ConfigService,
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
      const limitBytes = this.maxPdfParseBytes();
      // 先用已记录的体积预判：超限的 PDF 连临时文件都不用写，1GB 级文件落盘纯属浪费磁盘
      if (originalFile.sizeBytes > BigInt(limitBytes)) {
        this.warnSkipPdf(resourceId, originalFile.sizeBytes, limitBytes);
        return;
      }
      // PDF：pdf-parse 需要完整 Buffer，先流式落盘，再按大小上限决定是否解析
      const tmpPath = await streamStorageToTemp(this.storage, originalFile.storagePath, 'text-in');
      try {
        const { size } = await fs.stat(tmpPath);
        if (size > limitBytes) {
          // 记录值与实际文件可能不一致（历史数据、外部直接换文件），落盘后再按真实大小复核
          this.warnSkipPdf(resourceId, size, limitBytes);
          return;
        }
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
   * 跳过超大 PDF 的日志：pdf-parse 解析时整份文件常驻内存，超限只能放弃。
   * 这类文件多为扫描件，本就没有文本层，提取意义有限。
   */
  private warnSkipPdf(resourceId: string, sizeBytes: number | bigint, limitBytes: number): void {
    this.logger.warn(
      `Skip PDF text extraction for resource ${resourceId}: ${sizeBytes} bytes exceeds ${limitBytes} byte limit (MAX_PDF_PARSE_SIZE_MB)`,
    );
  }

  /** PDF 解析上限字节数（MAX_PDF_PARSE_SIZE_MB，默认 100MB） */
  private maxPdfParseBytes(): number {
    const mb = this.config.get<number>('processing.maxPdfParseMB') ?? DEFAULT_MAX_PDF_PARSE_MB;
    return mb * 1024 * 1024;
  }

  /**
   * 使用 pdf-parse 提取 PDF 文本
   *
   * 调用方需先用 {@link maxPdfParseBytes} 校验文件大小：该方法会把整份文件读入内存。
   * 解析失败时抛出错误，由调度器决定重试或标记失败
   */
  private async extractPdf(buffer: Buffer): Promise<string> {
    // pdf.js 1.10 对 Buffer 入参有缺陷：小 PDF（实测 2KB 以下）会解析错位并抛 bad XRef entry，
    // 传 Uint8Array 视图（同一块内存，零拷贝）时大文件小文件都正常
    const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const result = await pdfParse(data);
    return result.text || '';
  }
}
