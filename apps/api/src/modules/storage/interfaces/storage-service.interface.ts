import type { Readable } from 'node:stream';

/**
 * 文件存储服务接口
 *
 * 所有文件读写通过此接口，不直接使用 fs 模块。
 * 切换 MinIO/S3 时只需实现此接口的另一个驱动。
 */
export const STORAGE_SERVICE = Symbol('STORAGE_SERVICE');

export interface StorageObjectInfo {
  key: string;
  modifiedAt: Date;
  sizeBytes: number;
}

export interface IStorageService {
  /** 写入文件，返回 storage key（相对路径） */
  put(key: string, data: Buffer | NodeJS.ReadableStream): Promise<string>;

  /** 读取整个文件为 Buffer */
  get(key: string): Promise<Buffer>;

  /** 获取文件可读流（用于大文件下载） */
  getStream(key: string): Promise<Readable>;

  /** 获取文件指定字节范围的可读流（用于视频/音频等媒体 Range 请求） */
  getStreamRange(key: string, start: number, end: number): Promise<Readable>;

  /** 删除文件（幂等，文件不存在不报错） */
  delete(key: string): Promise<void>;

  /** 文件是否存在 */
  exists(key: string): Promise<boolean>;

  /** 枚举存储中的文件 key。prefix 为空时枚举整个存储根目录 */
  listKeys(prefix?: string): Promise<string[]>;

  /** 枚举存储中的文件对象元信息。prefix 为空时枚举整个存储根目录 */
  listObjects(prefix?: string): Promise<StorageObjectInfo[]>;

  /** 根据角色、hash、变体、扩展名生成 storage key */
  generateKey(role: string, hash: string, variant?: string, extension?: string): string;
}
