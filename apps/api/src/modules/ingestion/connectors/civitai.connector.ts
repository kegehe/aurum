import { BadRequestException, Injectable } from '@nestjs/common';
import { fetch } from 'undici';
import { SafeUrlService } from '../../../common/security/safe-url.service';
import { ResourceType } from '../../../common/constants/enums';
import {
  ConnectorInspectOptions,
  LinkMetadata,
  RemoteResource,
  ResourceConnector,
  SyncOptions,
  SyncPage,
} from './resource-connector.interface';

const CIVITAI_API_BASE = 'https://civitai.com/api/v1';
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 200;
const MIN_PAGE_LIMIT = 1;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_TITLE_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_AUTHOR_LENGTH = 255;

/** Civitai API image item shape (subset of fields we use) */
interface CivitaiImageItem {
  id: number;
  url: string;
  nsfwLevel: number;
  type: 'image' | 'video';
  createdAt: string;
  postId?: number;
  width?: number;
  height?: number;
  hash?: string;
  meta?: {
    prompt?: string;
    negativePrompt?: string;
    model?: string;
    sampler?: string;
    cfgScale?: number;
    steps?: number;
    seed?: number;
    [key: string]: unknown;
  };
  stats?: {
    commentCount?: number;
    likeCount?: number;
    heartCount?: number;
    laughCount?: number;
  };
  user?: {
    username?: string;
    image?: string;
  };
}

interface CivitaiImagesResponse {
  items: CivitaiImageItem[];
  metadata: {
    nextCursor?: string;
    currentPage?: number;
    totalPages?: number;
    totalItems?: number;
  };
}

@Injectable()
export class CivitaiConnector implements ResourceConnector {
  readonly type = 'civitai';

  constructor(private readonly safeUrl: SafeUrlService) {}

  async inspect(_url: string, _options?: ConnectorInspectOptions): Promise<LinkMetadata> {
    throw new BadRequestException(
      'CivitaiConnector does not support single-URL inspection. Use sync instead.',
    );
  }

  async sync(options: SyncOptions = {}): Promise<SyncPage> {
    const limit = this.clampLimit(options.limit ?? DEFAULT_PAGE_LIMIT);
    const params = new URLSearchParams();
    params.set('limit', String(limit));

    // Apply filters from Source.config
    const filters = options.filters ?? {};
    if (filters.sort && typeof filters.sort === 'string') {
      params.set('sort', filters.sort);
    }
    if (filters.period && typeof filters.period === 'string') {
      params.set('period', filters.period);
    }
    if (filters.nsfw !== undefined && filters.nsfw !== null) {
      params.set('nsfw', String(filters.nsfw));
    }
    if (options.cursor) {
      params.set('cursor', options.cursor);
    }

    const endpoint = `${CIVITAI_API_BASE}/images?${params.toString()}`;
    const dispatcher = this.safeUrl.createSafeDispatcher(
      {
        headersTimeout: 15_000,
        bodyTimeout: 20_000,
      },
      new URL(endpoint).hostname,
    );

    try {
      const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      const response = await fetch(endpoint, {
        dispatcher,
        signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'aurum-civitai-connector/0.1',
        },
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new BadRequestException(
          `Civitai API returned HTTP ${response.status}: ${body.slice(0, 200)}`,
        );
      }

      const data = (await response.json()) as CivitaiImagesResponse;
      const items = (data.items ?? []).map((item) => this.mapItem(item));
      const nextCursor = data.metadata?.nextCursor ?? null;

      return {
        items,
        nextCursor,
        totalItems: data.metadata?.totalItems ?? null,
      };
    } finally {
      await dispatcher.close();
    }
  }

  private mapItem(item: CivitaiImageItem): RemoteResource {
    const externalId = String(item.id);
    const resourceType = item.type === 'video' ? ResourceType.video : ResourceType.image;
    // Infer MIME type from URL extension rather than hardcoding
    const mimeType = this.inferMimeType(item.url, item.type);

    // Build title from meta or fallback to ID
    const rawTitle = item.meta?.model
      ? `${item.meta.model} - #${item.id}`
      : `Civitai Image #${item.id}`;
    const title = this.truncate(rawTitle, MAX_TITLE_LENGTH);

    // Build description from prompt
    const rawDescription = item.meta?.prompt ?? null;
    const description = rawDescription
      ? this.truncate(rawDescription, MAX_DESCRIPTION_LENGTH)
      : null;

    const authorName = item.user?.username
      ? this.truncate(item.user.username, MAX_AUTHOR_LENGTH)
      : null;
    const authorUrl = item.user?.username ? `https://civitai.com/user/${item.user.username}` : null;

    // The page URL on civitai.com
    const pageUrl = item.postId
      ? `https://civitai.com/posts/${item.postId}`
      : `https://civitai.com/images/${item.id}`;

    return {
      externalId,
      url: item.url,
      canonicalUrl: pageUrl,
      resourceType,
      mimeType,
      title,
      description,
      authorName,
      authorUrl,
      publisher: 'Civitai',
      // Civitai's image URL is safe to use as the remote preview. It also
      // remains the direct-download locator used when the user mirrors it.
      previewUrl: item.url,
      width: item.width ?? null,
      height: item.height ?? null,
      externalCreatedAt: this.parseExternalDate(item.createdAt),
      rawMetadata: {
        id: item.id,
        nsfwLevel: item.nsfwLevel,
        hash: item.hash ?? null,
        meta: item.meta ?? null,
        stats: item.stats ?? null,
      },
      additionalLocators: [
        { locatorType: 'page', url: pageUrl },
        { locatorType: 'api', url: `${CIVITAI_API_BASE}/images/${item.id}` },
      ],
    };
  }

  private truncate(value: string, maxLength: number): string {
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }

  private clampLimit(limit: number): number {
    // 防御：配置里解析出的 limit 可能是 NaN/非法值，避免把 'NaN' 拼进请求参数
    if (!Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT;
    return Math.max(MIN_PAGE_LIMIT, Math.min(MAX_PAGE_LIMIT, limit));
  }

  /** 解析远端时间戳；无效值时返回 null，避免 Invalid Date 写入 Prisma 时报错 */
  private parseExternalDate(value: string | undefined | null): Date | null {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  /** Infer MIME type from URL extension, with fallback based on item type */
  private inferMimeType(url: string, type: 'image' | 'video'): string {
    try {
      const pathname = new URL(url).pathname;
      const ext = pathname.split('.').pop()?.toLowerCase() ?? '';
      const imageMimeMap: Record<string, string> = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        webp: 'image/webp',
        gif: 'image/gif',
        avif: 'image/avif',
      };
      const videoMimeMap: Record<string, string> = {
        mp4: 'video/mp4',
        webm: 'video/webm',
        mov: 'video/quicktime',
      };
      const mimeMap = type === 'video' ? videoMimeMap : imageMimeMap;
      if (ext && mimeMap[ext]) return mimeMap[ext];
    } catch {
      // URL parse failure — use fallback
    }
    return type === 'video' ? 'video/mp4' : 'image/jpeg';
  }
}
