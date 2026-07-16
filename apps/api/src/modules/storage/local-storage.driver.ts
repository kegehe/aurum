import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import type { Readable } from 'node:stream';
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
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    if (Buffer.isBuffer(data)) {
      await fs.writeFile(filePath, data);
    } else {
      // Stream
      const writable = createWriteStream(filePath);
      await new Promise<void>((resolve, reject) => {
        data.pipe(writable);
        writable.on('finish', resolve);
        writable.on('error', reject);
      });
    }
    return key;
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
