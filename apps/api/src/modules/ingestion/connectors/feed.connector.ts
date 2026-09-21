import { BadRequestException, Injectable } from '@nestjs/common';
import { fetch } from 'undici';
import Parser from 'rss-parser';
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

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const MIN_PAGE_LIMIT = 1;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_FEED_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_TITLE_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_AUTHOR_LENGTH = 255;

/** rss-parser 折叠后的条目形状（仅列出本连接器关心的字段） */
interface FeedItem {
  title?: string;
  link?: string;
  id?: string;
  url?: string;
  guid?: string | { _text?: string; $?: { isPermaLink?: string } };
  isoDate?: string;
  pubDate?: string;
  creator?: string;
  author?: string;
  content?: string;
  contentSnippet?: string;
  summary?: string;
  description?: string;
  enclosure?: { url?: string; type?: string; length?: string };
  mediaContent?: XmlAttrs | XmlAttrs[];
  mediaThumbnail?: XmlAttrs | XmlAttrs[];
  itunesAuthor?: string;
  itunesSummary?: string;
  /** RSS 的 `<content:encoded>` 全文（自定义字段） */
  encoded?: string;
  /** 常见于图片类 RSS 扩展，如 `<full-image>` / `<photo>` */
  fullImage?: string;
  photo?: string;
  /** JSON Feed 字段 */
  image?: string | { url?: string };
  attachments?: Array<{ url?: string; mime_type?: string }>;
}

interface ParsedFeed {
  title?: string;
  link?: string;
  items: FeedItem[];
}

/** xml2js 节点：属性可能直接铺开，也可能挂在 `$` 下 */
interface XmlAttrs {
  url?: string;
  type?: string;
  medium?: string;
  isDefault?: string;
  $?: { url?: string; type?: string; medium?: string };
}

/** 媒体组（media:content / media:thumbnail 可重复），取第一个带 URL 的成员 */
function firstAttr(value: XmlAttrs | XmlAttrs[] | null | undefined): XmlAttrs | null {
  if (!value) return null;
  const list = Array.isArray(value) ? value : [value];
  return list.find((entry) => attrUrl(entry) !== null) ?? null;
}

function attrUrl(entry: XmlAttrs | null | undefined): string | null {
  const url = entry?.$?.url ?? entry?.url;
  return typeof url === 'string' && url.trim() ? url.trim() : null;
}

function attrType(entry: XmlAttrs | null | undefined): string | null {
  const type = entry?.$?.type ?? entry?.type;
  return typeof type === 'string' && type.trim() ? type.trim() : null;
}

/** JSON Feed 1.x 条目（字段名与 RSS/Atom 不同，需归一化） */
interface JsonFeedItem {
  id: string;
  url?: string;
  external_url?: string;
  title?: string;
  content_text?: string;
  content_html?: string;
  image?: string;
  banner_image?: string;
  date_published?: string;
  authors?: Array<{ name?: string }>;
  /** JSON Feed 1.0 早期形态的单个作者 */
  author?: { name?: string };
  attachments?: Array<{ url: string; mime_type?: string }>;
}

/** 把 JSON Feed 归一化成连接器内部的条目形状 */
function normalizeJsonFeed(raw: unknown): ParsedFeed {
  const feed = raw as {
    title?: string;
    home_page_url?: string;
    items?: JsonFeedItem[];
  };
  return {
    title: feed.title,
    link: feed.home_page_url,
    items: (feed.items ?? []).map((item) => {
      const html = item.content_html || item.content_text;
      return {
        id: item.id,
        link: item.url,
        title: item.title,
        content: html,
        contentSnippet: htmlToText(html) ?? undefined,
        isoDate: item.date_published,
        author: item.authors?.[0]?.name ?? item.author?.name,
        image: item.image,
        attachments: item.attachments,
      };
    }),
  };
}

/** 从 HTML 摘要中提取首个图片地址，用作预览 */
function firstImageInHtml(html: string | undefined): string | null {
  if (!html) return null;
  const match = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  return match?.[1] ?? null;
}

/** 去掉标签并展开常见实体，得到可用于摘要的纯文本 */
export function htmlToText(value: string | undefined | null): string | null {
  if (!value) return null;
  const text = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

/** guid 的 isPermaLink 为 false 时值是文本标识，不能当 URL 用 */
export function feedItemExternalId(item: FeedItem): string | null {
  const guid = typeof item.guid === 'string' ? item.guid : item.guid?._text;
  const isPermaLink = typeof item.guid === 'object' ? item.guid?.$?.isPermaLink !== 'false' : true;
  const candidates = [guid && isPermaLink ? guid : null, guid, item.id, item.link];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) return value.slice(0, 255);
  }
  return null;
}

/**
 * RSS / Atom / JSON Feed 连接器（通过 rss-parser 统一三种格式）。
 *
 * 与 Civitai / GitHub 连接器不同，Feed 没有分页 API：一次请求即拿到整个列表，
 * 因此游标是本地切片偏移（`offset:N`），让 maxPages 能像 GitHub 那样分批推进，
 * 避免为超过单次处理上限的条目重新拉取整个 Feed。
 *
 * Feed 本身只描述条目，条目可能只有一个 HTML 页面链接；没有 enclosure /
 * media:content 时下载链接就回退到页面 URL，此时下载到的内容是 HTML（记录在
 * 定位器的 lastError / 文件类型上），元数据本身仍然可用。
 */
@Injectable()
export class FeedConnector implements ResourceConnector {
  readonly type = 'rss';

  constructor(private readonly safeUrl: SafeUrlService) {}

  async inspect(_url: string, _options?: ConnectorInspectOptions): Promise<LinkMetadata> {
    throw new BadRequestException(
      'FeedConnector does not support single-URL inspection. Use sync instead.',
    );
  }

  async sync(options: SyncOptions = {}): Promise<SyncPage> {
    const filters = options.filters ?? {};
    const feedUrl = this.resolveFeedUrl(filters.feedUrl);
    const limit = this.clampLimit(options.limit ?? DEFAULT_PAGE_LIMIT);
    const offset = this.parseOffsetCursor(options.cursor);

    const { body, contentType } = await this.fetchFeed(feedUrl);
    const itemFields: Array<[string, string]> = [
      ['media:content', 'mediaContent'],
      ['media:thumbnail', 'mediaThumbnail'],
      ['itunes:author', 'itunesAuthor'],
      ['itunes:summary', 'itunesSummary'],
      ['content:encoded', 'encoded'],
      ['full-image', 'fullImage'],
      ['photo', 'photo'],
    ];
    const parser = new Parser({ customFields: { item: itemFields } });
    let feed: ParsedFeed;
    try {
      // JSON Feed 直接就是 JSON 文本；其余（RSS/Atom/RDF）交给 xml2js
      if (contentType.includes('json') || body.trimStart().startsWith('{')) {
        feed = normalizeJsonFeed(JSON.parse(body));
      } else {
        feed = (await parser.parseString(body)) as unknown as ParsedFeed;
      }
    } catch (error) {
      throw new BadRequestException(
        `Failed to parse feed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const publisher = feed.title?.trim() || new URL(feedUrl).hostname;
    const allItems = feed.items ?? [];
    const pageItems = allItems.slice(offset, offset + limit);
    const items = pageItems
      .map((item) => this.mapItem(item, feedUrl, publisher))
      .filter((item): item is RemoteResource => item !== null);

    const nextOffset = offset + pageItems.length;
    return {
      items,
      nextCursor: nextOffset < allItems.length ? `offset:${nextOffset}` : null,
      totalItems: allItems.length,
    };
  }

  private resolveFeedUrl(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new BadRequestException('RSS source requires a valid "feedUrl" config');
    }
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      throw new BadRequestException(`Invalid feed URL: ${raw}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BadRequestException('Feed URL must use http or https');
    }
    return url.toString();
  }

  /** 逐跳手动重定向，每跳重新做公网解析校验，避免重定向指向内网 */
  private async fetchFeed(feedUrl: string): Promise<{ body: string; contentType: string }> {
    let current = new URL(feedUrl);
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const dispatcher = this.safeUrl.createSafeDispatcher(
        { headersTimeout: 15_000, bodyTimeout: 20_000 },
        current.hostname,
      );
      try {
        const response = await fetch(current.toString(), {
          dispatcher,
          redirect: 'manual',
          signal,
          headers: {
            accept:
              'application/rss+xml, application/atom+xml, application/xml+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.8',
            'user-agent': 'aurum-feed-connector/0.1',
          },
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          try {
            await response.body?.cancel();
          } catch {
            // 无 body 或 body 不可取消时忽略，重定向本身仍需继续
          }
          if (!location) throw new BadRequestException('Feed redirect has no location');
          const next = new URL(location, current);
          if (next.protocol !== 'http:' && next.protocol !== 'https:') {
            throw new BadRequestException(
              `Unsupported protocol in feed redirect: ${next.protocol}`,
            );
          }
          current = next;
          continue;
        }

        if (response.status === 404) {
          throw new BadRequestException(`Feed not found: ${current}`);
        }
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new BadRequestException(
            `Feed server returned HTTP ${response.status}: ${detail.slice(0, 200)}`,
          );
        }
        return {
          body: await this.readLimitedBody(response.body),
          contentType: (response.headers.get('content-type') ?? '').toLowerCase(),
        };
      } finally {
        await dispatcher.close();
      }
    }
    throw new BadRequestException(`Too many redirects (maximum ${MAX_REDIRECTS})`);
  }

  private async readLimitedBody(body: ReadableStream<Uint8Array> | null): Promise<string> {
    if (!body) throw new BadRequestException('Feed response had no body');
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > MAX_FEED_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new BadRequestException(`Feed exceeds ${Math.floor(MAX_FEED_BYTES / 1024)} KB limit`);
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(received);
    let position = 0;
    for (const chunk of chunks) {
      merged.set(chunk, position);
      position += chunk.byteLength;
    }
    return new TextDecoder('utf-8').decode(merged);
  }

  private mapItem(item: FeedItem, feedUrl: string, publisher: string): RemoteResource | null {
    const externalId = feedItemExternalId(item);
    const permalink = item.link?.trim();
    if (!externalId && !permalink) return null;

    const media = firstAttr(item.mediaContent);
    const thumbnail = firstAttr(item.mediaThumbnail);
    const enclosure = item.enclosure && !Array.isArray(item.enclosure) ? item.enclosure : undefined;
    const itemUrl = this.resolveItemUrl(item);
    const mediaUrl = attrUrl(media) ?? attrUrl(thumbnail) ?? itemUrl?.url ?? null;
    const mediaType = attrType(media) ?? itemUrl?.type ?? null;
    const enclosureUrl = enclosure?.url?.trim();
    // 优先真实附件（enclosure → media:content → 条目扩展字段），最后回退到页面链接
    const url = enclosureUrl || mediaUrl || permalink || externalId;
    if (!url) return null;

    const mimeType = enclosureUrl ? enclosure?.type || null : mediaType;
    // 标题已由 XML 解析器解码，直接去空白使用；用 htmlToText 会误删 `<3`、数学符号等合法文本
    const title = item.title?.replace(/\s+/g, ' ').trim() || permalink || externalId || url;
    const description = this.resolveDescription(item);
    const authorName = this.resolveAuthor(item);
    const html = item.encoded || item.content;
    const previewUrl =
      attrUrl(thumbnail) ??
      firstImageInHtml(html) ??
      (this.classifyResourceType(url, mimeType) === ResourceType.image ? url : null);

    return {
      externalId: externalId || permalink!,
      url,
      canonicalUrl: permalink,
      resourceType: this.classifyResourceType(url, mimeType),
      mimeType: mimeType ?? undefined,
      title: this.truncate(title, MAX_TITLE_LENGTH),
      description,
      authorName: authorName ? this.truncate(authorName, MAX_AUTHOR_LENGTH) : null,
      authorUrl: null,
      publisher,
      previewUrl,
      width: null,
      height: null,
      externalCreatedAt: this.parseExternalDate(item.isoDate ?? item.pubDate),
      rawMetadata: {
        feedUrl,
        kind: 'feed_item',
        permalink: permalink ?? null,
        enclosureUrl: enclosureUrl ?? null,
        mediaUrl: mediaUrl ?? null,
        publishedAt: item.isoDate ?? item.pubDate ?? null,
      },
      additionalLocators: permalink
        ? [{ locatorType: 'page', url: permalink }]
        : [{ locatorType: 'api', url: feedUrl }],
    };
  }

  /**
   * 条目上除 enclosure / media:content 之外的可下载地址：
   * JSON Feed 的 attachments / image、以及 RSS 常见的 full-image / photo 扩展。
   */
  private resolveItemUrl(item: FeedItem): { url: string; type: string | null } | null {
    const candidates: Array<{ url?: string; type?: string; mime_type?: string } | string> = [];
    if (item.attachments) candidates.push(...item.attachments);
    if (item.image)
      candidates.push(typeof item.image === 'string' ? { url: item.image } : item.image);
    if (item.fullImage) candidates.push({ url: item.fullImage });
    if (item.photo) candidates.push({ url: item.photo });
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return { url: candidate.trim(), type: null };
      }
      const url = (candidate as { url?: string }).url?.trim();
      if (url) {
        return {
          url,
          type:
            (candidate as { type?: string; mime_type?: string }).type ??
            (candidate as { mime_type?: string }).mime_type ??
            null,
        };
      }
    }
    return null;
  }

  private resolveDescription(item: FeedItem): string | null {
    const raw =
      item.contentSnippet ||
      htmlToText(item.encoded) ||
      htmlToText(item.content) ||
      htmlToText(item.summary) ||
      htmlToText(item.itunesSummary) ||
      htmlToText(item.description);
    return raw ? this.truncate(raw, MAX_DESCRIPTION_LENGTH) : null;
  }

  private resolveAuthor(item: FeedItem): string | null {
    // dc:creator / itunes:author 是字符串；JSON Feed 的 author 是对象
    const author = typeof item.author === 'string' ? item.author : null;
    return author || item.creator || item.itunesAuthor || null;
  }

  private classifyResourceType(url: string, mimeType: string | null): ResourceType {
    if (mimeType) {
      if (mimeType.startsWith('image/')) return ResourceType.image;
      if (mimeType.startsWith('video/')) return ResourceType.video;
      if (mimeType.startsWith('audio/')) return ResourceType.audio;
      if (mimeType === 'application/pdf') return ResourceType.document;
      if (/zip|tar|gz|rar|7z/.test(mimeType)) return ResourceType.archive;
    }
    let pathname = url;
    try {
      pathname = new URL(url).pathname;
    } catch {
      // 相对/非 URL 标识，退化为字符串匹配
    }
    const lower = pathname.toLowerCase();
    if (/\.tar\.gz$/.test(lower)) return ResourceType.archive;
    const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
    const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp']);
    const videoExts = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v']);
    const audioExts = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);
    const archiveExts = new Set(['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz']);
    const docExts = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'epub']);
    const fontExts = new Set(['ttf', 'otf', 'woff', 'woff2']);
    if (imageExts.has(ext)) return ResourceType.image;
    if (videoExts.has(ext)) return ResourceType.video;
    if (audioExts.has(ext)) return ResourceType.audio;
    if (archiveExts.has(ext)) return ResourceType.archive;
    if (docExts.has(ext)) return ResourceType.document;
    if (fontExts.has(ext)) return ResourceType.font;
    if (/^https?:\/\//i.test(url)) return ResourceType.text;
    return ResourceType.other;
  }

  private parseOffsetCursor(cursor?: string | null): number {
    if (!cursor) return 0;
    const match = /^offset:(\d+)$/.exec(cursor.trim());
    if (!match) return 0;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private truncate(value: string, maxLength: number): string {
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }

  private clampLimit(limit: number): number {
    if (!Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT;
    return Math.max(MIN_PAGE_LIMIT, Math.min(MAX_PAGE_LIMIT, Math.floor(limit)));
  }

  private parseExternalDate(value: string | undefined | null): Date | null {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
}
