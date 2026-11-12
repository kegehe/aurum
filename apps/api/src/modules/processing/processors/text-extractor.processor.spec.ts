import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { TextExtractor } from './text-extractor.processor';
import { FileRole } from '../../../common/constants/enums';
import { IStorageService } from '../../storage/interfaces/storage-service.interface';

const RESOURCE_ID = 'resource-1';
const SHA256 = 'a'.repeat(64);

/** 生成一份最小可解析的单页 PDF */
function createPdf(text: string): Buffer {
  const objects: Record<number, string> = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    3: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    4: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 3 0 R >> >> >>',
  };
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  objects[5] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = body.length;
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = body.length;
  body += `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) {
    body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

function createExtractor(options: {
  content: Buffer;
  mimeType?: string;
  maxPdfParseMB?: number;
  /** resource_files 里记录的体积，默认与内容长度一致（真实上传即如此） */
  sizeBytes?: bigint;
}) {
  const storage = {
    getStream: vi.fn(async () => Readable.from([options.content])),
    generateKey: vi.fn(() => `extracted/${SHA256}.txt`),
    put: vi.fn(async () => 'extracted'),
  };
  const resourceRepo = {
    findById: vi.fn(async () => ({
      id: RESOURCE_ID,
      mimeType: options.mimeType ?? 'application/pdf',
      sha256: SHA256,
    })),
    update: vi.fn(async () => ({})),
  };
  const fileRepo = {
    findByResourceAndRole: vi.fn(async (_id: string, role: string) =>
      role === FileRole.original
        ? {
            id: 'file-1',
            storagePath: 'original/abc',
            fileRole: FileRole.original,
            sizeBytes: options.sizeBytes ?? BigInt(options.content.length),
          }
        : null,
    ),
    create: vi.fn(async () => ({})),
  };
  const config = {
    get: vi.fn((key: string) =>
      key === 'processing.maxPdfParseMB' ? (options.maxPdfParseMB ?? 100) : undefined,
    ),
  };

  const extractor = new TextExtractor(
    storage as unknown as IStorageService,
    resourceRepo as never,
    fileRepo as never,
    config as never,
  );
  return { extractor, storage, resourceRepo, fileRepo, config };
}

/** 当前 tmpdir 里的 text-in-* 临时文件（生产也用它，所以只能比对前后增量） */
async function listTextInTemp(): Promise<string[]> {
  return (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith('text-in-'));
}

/** 处理器必须在 finally 里清理临时文件：本次调用不应新增任何残留 */
async function expectNoTempLeftover(before: string[]): Promise<void> {
  expect(await listTextInTemp()).toEqual(before);
}

describe('TextExtractor', () => {
  it('extracts text from a PDF within the size limit', async () => {
    // 刻意用 2KB 以内的小 PDF：pdf.js 拿 Buffer 当入参解析这类文件会错位，
    // 这条用例同时守着「必须传 Uint8Array」这一层
    const { extractor, storage, resourceRepo, fileRepo } = createExtractor({
      content: createPdf('Hello Aurum'),
    });
    const before = await listTextInTemp();

    await extractor.process(RESOURCE_ID, 'job-1');

    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(fileRepo.create).toHaveBeenCalledTimes(1);
    expect(resourceRepo.update).toHaveBeenCalledWith(RESOURCE_ID, {
      searchVector: expect.stringContaining('Hello Aurum'),
    });
    await expectNoTempLeftover(before);
  });

  it('skips oversized PDFs before downloading them to a temp file', async () => {
    const { extractor, storage, resourceRepo } = createExtractor({
      // 记录体积已超 1MB 上限：不必下载，更不必落盘
      content: Buffer.alloc(2 * 1024 * 1024),
      sizeBytes: 2n * 1024n * 1024n,
      maxPdfParseMB: 1,
    });
    const before = await listTextInTemp();

    await expect(extractor.process(RESOURCE_ID, 'job-1')).resolves.toBeUndefined();

    expect(storage.getStream).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(resourceRepo.update).not.toHaveBeenCalled();
    await expectNoTempLeftover(before);
  });

  it('skips oversized PDFs even when the recorded size is stale', async () => {
    const { extractor, storage, resourceRepo, fileRepo } = createExtractor({
      // 记录只有 1KB，实际 2MB：落盘后用真实大小复核，仍然不解析
      content: Buffer.alloc(2 * 1024 * 1024),
      sizeBytes: 1024n,
      maxPdfParseMB: 1,
    });
    const before = await listTextInTemp();

    await expect(extractor.process(RESOURCE_ID, 'job-1')).resolves.toBeUndefined();

    // 确实走了"落盘 + 按真实大小复核"这条兜底路径（记录值没拦住）
    expect(storage.getStream).toHaveBeenCalledTimes(1);
    expect(storage.put).not.toHaveBeenCalled();
    expect(fileRepo.create).not.toHaveBeenCalled();
    expect(resourceRepo.update).not.toHaveBeenCalled();
    await expectNoTempLeftover(before);
  });

  it('caps plain text at MAX_TEXT and truncates searchVector', async () => {
    const { extractor, storage, resourceRepo } = createExtractor({
      content: Buffer.from('x'.repeat(2_000_000)),
      mimeType: 'text/plain',
    });

    await extractor.process(RESOURCE_ID, 'job-1');

    // 只保留 1_000_000 字符（MAX_TEXT），超出部分不再落盘
    const [, stored] = storage.put.mock.calls[0] as [string, Buffer];
    expect(stored.length).toBe(1_000_000);
    // searchVector 只保留前 10_000 字符
    const [, update] = resourceRepo.update.mock.calls[0] as [string, { searchVector: string }];
    expect(update.searchVector.length).toBe(10_000);
    expect(resourceRepo.update).toHaveBeenCalledTimes(1);
  });
});
