import * as os from 'node:os';
import * as path from 'node:path';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { IStorageService } from '../storage/interfaces/storage-service.interface';

/**
 * 将 storage 中的文件流式复制到临时文件，返回临时文件路径。
 *
 * 相比 `storage.get()`（把整个文件读进内存再写盘），这里使用 `getStream()` 边读边写，
 * 内存占用仅为一个流缓冲块，适合接近上传上限的大文件。
 * 缩略图/视频封面/元数据检测（Sharp/FFmpeg 需要文件路径）与 PDF 文本提取共用此函数。
 *
 * 流写入失败时会删除残留的临时文件再抛出。调用方仍需在 finally 中删除返回的临时文件。
 */
export async function streamStorageToTemp(
  storage: IStorageService,
  storageKey: string,
  prefix: string,
): Promise<string> {
  const readStream = await storage.getStream(storageKey);
  const tmpPath = path.join(os.tmpdir(), `${prefix}-${randomUUID()}`);
  const writeStream = createWriteStream(tmpPath);
  try {
    await pipeline(readStream, writeStream);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
  return tmpPath;
}

/**
 * 从可读流中读取至多 maxBytes 字节的 UTF-8 文本。
 *
 * 用于纯文本提取：只读取需要保留的前缀，避免把整个大文本文件读入内存。
 * 达到上限后立即停止读取并销毁流，释放底层文件描述符。
 */
export async function readTextCapped(stream: Readable, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      total += buf.length;
      if (total >= maxBytes) break;
    }
  } finally {
    // 提前 break 时结束底层流；正常读完或已出错时调用为无害空操作
    stream.destroy();
  }
  return Buffer.concat(chunks).toString('utf-8');
}
