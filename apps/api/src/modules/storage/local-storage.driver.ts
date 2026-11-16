import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { IStorageService, StorageObjectInfo } from './interfaces/storage-service.interface';
import { generateStorageKey } from './storage-key.util';

/**
 * 本地磁盘存储驱动
 *
 * 所有文件操作通过 resolvePath 校验 storage key，防止路径穿越攻击：
 * 1. 禁止 key 包含 ".." 路径段
 * 2. 禁止绝对路径（"/" 或 "C:\" 开头）
 * 3. 禁止空字节、反斜杠、冒号（Windows 路径穿越向量）
 * 4. resolve 后必须落在 STORAGE_ROOT 目录内
 *
 * storage key 使用正斜杠 "/" 作为分隔符（跨平台），磁盘路径用 path.sep 拼接。
 */
@Injectable()
export class LocalStorageDriver implements IStorageService {
  private readonly root: string;

  constructor(config: ConfigService) {
    const root = config.get<string>('storage.root') || './storage';
    this.root = path.resolve(root);
  }

  /**
   * 将 storage key 解析为磁盘绝对路径，并校验路径穿越
   */
  private resolvePath(key: string): string {
    // 校验 key 格式
    if (!key) {
      throw new Error('Invalid storage key: empty key');
    }
    if (path.isAbsolute(key)) {
      throw new Error('Invalid storage key: absolute path not allowed');
    }
    // 拒绝 Windows 路径穿越向量：反斜杠、空字节、冒号
    if (key.includes('\\') || key.includes('\0') || key.includes(':')) {
      throw new Error('Invalid storage key: illegal characters');
    }
    const segments = key.split('/');
    if (segments.some((seg) => seg === '..' || seg === '.')) {
      throw new Error('Invalid storage key: path traversal detected');
    }

    const resolved = path.resolve(this.root, ...segments);
    // 确保解析后的路径在 root 内
    const rootWithSep = this.root + path.sep;
    if (resolved !== this.root && !resolved.startsWith(rootWithSep)) {
      throw new Error('Invalid storage key: path traversal detected');
    }
    return resolved;
  }

  async put(key: string, data: Buffer | NodeJS.ReadableStream): Promise<string> {
    const filePath = this.resolvePath(key);
    // 先写同目录临时文件再 rename：写入中途失败不会留下半截文件，
    // 也不会因为内容寻址复用同一 key 时把已有的完好文件截断。
    const tempPath = `${filePath}.tmp-${randomUUID()}`;

    try {
      if (Buffer.isBuffer(data)) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(tempPath, data);
      } else {
        const source = data as Readable;

        // createReadStream 打开文件是异步的：源文件读不出来（磁盘异常、杀软拦截、
        // 临时文件被移走）时，'error' 可能在下面 mkdir 的 await 期间就触发。
        // 必须在这里同步挂上监听——事件无人接收会变成未捕获异常，直接打挂进程。
        let sourceError: Error | null = null;
        const captureSourceError = (error: Error) => {
          sourceError = error;
        };
        source.once('error', captureSourceError);

        try {
          await fs.mkdir(path.dirname(filePath), { recursive: true });
        } catch (error) {
          // 这里不能摘掉监听：fs.ReadStream 在 open 尚未完成时 destroy()，
          // 挂起的打开失败（ENOENT/EACCES）仍会作为 'error' 发出，摘掉就变成未捕获异常。
          source.destroy();
          throw error;
        }

        // 摘掉临时监听后立即交给 pipeline，两者之间没有 await，不会留下空窗。
        source.off('error', captureSourceError);
        if (sourceError) {
          throw sourceError;
        }

        // 用 pipeline 而非 data.pipe(writable)：pipe 不会把源流的 error 转发给目标流，
        // 读失败既不会 reject 也无法被调用方感知。pipeline 同时监听两端、出错时销毁
        // 两个流，保证失败以 reject 的形式传回调用方。
        await pipeline(source, createWriteStream(tempPath));
      }

      await fs.rename(tempPath, filePath);
      return key;
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async get(key: string): Promise<Buffer> {
    const filePath = this.resolvePath(key);
    try {
      return await fs.readFile(filePath);
    } catch {
      throw new NotFoundException(`File not found: ${key}`);
    }
  }

  async getStream(key: string): Promise<Readable> {
    const filePath = this.resolvePath(key);
    try {
      await fs.access(filePath);
    } catch {
      throw new NotFoundException(`File not found: ${key}`);
    }
    return createReadStream(filePath);
  }

  async getStreamRange(key: string, start: number, end: number): Promise<Readable> {
    const filePath = this.resolvePath(key);
    try {
      await fs.access(filePath);
    } catch {
      throw new NotFoundException(`File not found: ${key}`);
    }
    return createReadStream(filePath, { start, end });
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolvePath(key);
    try {
      await fs.unlink(filePath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // 文件不存在不算错误，幂等删除
      if (err.code !== 'ENOENT') throw e;
    }
  }

  async exists(key: string): Promise<boolean> {
    const filePath = this.resolvePath(key);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async listKeys(prefix: string = ''): Promise<string[]> {
    const objects = await this.listObjects(prefix);
    return objects.map((object) => object.key);
  }

  async listObjects(prefix: string = ''): Promise<StorageObjectInfo[]> {
    const rootPath = prefix ? this.resolvePath(prefix) : this.root;
    const objects: StorageObjectInfo[] = [];

    const walk = async (dir: string) => {
      let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') return;
        throw e;
      }

      for (const entry of entries) {
        if (entry.name === '.gitkeep') {
          continue;
        }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const stat = await fs.stat(fullPath);
          objects.push({
            key: path.relative(this.root, fullPath).split(path.sep).join('/'),
            modifiedAt: stat.mtime,
            sizeBytes: stat.size,
          });
        }
      }
    };

    await walk(rootPath);
    return objects.sort((a, b) => a.key.localeCompare(b.key));
  }

  generateKey(role: string, hash: string, variant?: string, extension?: string): string {
    return generateStorageKey(role, hash, variant, extension);
  }
}
