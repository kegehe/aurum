import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ResourceService } from '../resource/resource.service';
import {
  getMediaDescriptor,
  isSafeDataUri,
  safeMediaAlt,
  type MediaDescriptor,
  type ResolvedMedia,
} from './design-media';
import type { JsonRecord } from './design.types';

/** 实时预览/权威渲染用的素材边长；导出时用更大的边长。 */
export const DESIGN_MEDIA_PREVIEW_MAX_EDGE = 1200;
export const DESIGN_MEDIA_EXPORT_MAX_EDGE = 1600;

const CACHE_TTL_MS = 2 * 60 * 1000;
const CACHE_LIMIT_BYTES = 32 * 1024 * 1024;
const MAX_MEDIA_BYTES = 4 * 1024 * 1024;

interface CacheEntry {
  value: ResolvedMedia;
  bytes: number;
  expiresAt: number;
}

/**
 * 把设计 content 里的 media 资源引用解析成 data URI。
 *
 * content 只存 resourceId；预览、渲染、导出时才读盘。滑块会连续触发预览，
 * 所以这里必须有缓存：同一个资源 + 边长只读一次，并做 in-flight 去重。
 */
@Injectable()
export class DesignMediaService {
  private readonly logger = new Logger(DesignMediaService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<ResolvedMedia>>();
  private cacheBytes = 0;

  constructor(private readonly resources: ResourceService) {}

  /** 一句话生成：从资源库拿素材描述（不读字节）。 */
  async describe(resourceId: string): Promise<MediaDescriptor> {
    const info = await this.resources.assertDesignMedia(resourceId);
    return {
      resourceId,
      kind: info.kind,
      alt: safeMediaAlt(info.title),
      width: info.width && info.width > 0 ? info.width : undefined,
      height: info.height && info.height > 0 ? info.height : undefined,
      durationSeconds: info.durationSeconds ?? undefined,
      fit: 'cover',
      position: 'center',
    };
  }

  async resolveContent(
    content: JsonRecord,
    options: { strict?: boolean; maxEdge?: number } = {},
  ): Promise<ResolvedMedia | null> {
    const descriptor = getMediaDescriptor(content);
    if (!descriptor) return null;
    return this.resolve(descriptor, options);
  }

  async resolve(
    descriptor: MediaDescriptor,
    options: { strict?: boolean; maxEdge?: number } = {},
  ): Promise<ResolvedMedia | null> {
    const maxEdge = options.maxEdge ?? DESIGN_MEDIA_PREVIEW_MAX_EDGE;
    const key = `${descriptor.resourceId}:${descriptor.kind}:${maxEdge}`;
    const cached = this.readCache(key);
    if (cached) return cached;

    const pending = this.inflight.get(key);
    if (pending) return this.handle(pending, Boolean(options.strict), descriptor, key);

    const task = this.load(descriptor, maxEdge)
      .then((value) => {
        this.writeCache(key, value);
        return value;
      })
      .finally(() => {
        if (this.inflight.get(key) === task) this.inflight.delete(key);
      });
    this.inflight.set(key, task);
    return this.handle(task, Boolean(options.strict), descriptor, key);
  }

  /**
   * 发布/直接写入前的门禁：绕过 data URI 缓存，确认资源仍然存在且可读。
   * 用 assertDesignMedia（只查文件记录）而不是读全量字节，避免发布接口被大图拖慢。
   */
  async assertAvailable(content: JsonRecord): Promise<void> {
    const descriptor = getMediaDescriptor(content);
    if (!descriptor) return;
    const info = await this.resources.assertDesignMedia(descriptor.resourceId);
    if (info.kind !== descriptor.kind) {
      throw new BadRequestException('素材类型与资源不一致，请重新选择素材');
    }
  }

  private async handle(
    task: Promise<ResolvedMedia>,
    strict: boolean,
    descriptor: MediaDescriptor,
    key: string,
  ): Promise<ResolvedMedia | null> {
    try {
      return await task;
    } catch (error) {
      if (strict) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`素材解析失败，使用占位（${descriptor.resourceId}/${key}）：${message}`);
      return null;
    }
  }

  private async load(descriptor: MediaDescriptor, maxEdge: number): Promise<ResolvedMedia> {
    const data = await this.resources.readDesignMedia(descriptor.resourceId, {
      maxEdge,
      maxBytes: MAX_MEDIA_BYTES,
    });
    if (data.kind !== descriptor.kind) {
      throw new BadRequestException('素材类型与资源不一致，请重新选择素材');
    }
    const dataUri = `data:${data.mimeType};base64,${data.buffer.toString('base64')}`;
    if (!isSafeDataUri(dataUri)) {
      throw new BadRequestException('素材格式无法内嵌到设计预览');
    }
    return {
      dataUri,
      mimeType: data.mimeType,
      kind: data.kind,
      width: descriptor.width,
      height: descriptor.height,
    };
  }

  private readCache(key: string): ResolvedMedia | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      this.cacheBytes -= entry.bytes;
      return null;
    }
    // 命中后移到末尾，Map 的插入顺序即可当作 LRU。
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  private writeCache(key: string, value: ResolvedMedia): void {
    // 单条过大就不进缓存，避免一张图挤掉全部条目。
    const bytes = Buffer.byteLength(value.dataUri);
    if (bytes > CACHE_LIMIT_BYTES / 4) return;

    const existing = this.cache.get(key);
    if (existing) {
      this.cacheBytes -= existing.bytes;
      this.cache.delete(key);
    }
    this.cache.set(key, { value, bytes, expiresAt: Date.now() + CACHE_TTL_MS });
    this.cacheBytes += bytes;

    while (this.cacheBytes > CACHE_LIMIT_BYTES) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const removed = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      this.cacheBytes -= removed?.bytes ?? 0;
    }
  }
}
