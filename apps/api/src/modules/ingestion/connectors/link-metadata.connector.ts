import { BadRequestException, Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { SafeUrlService } from '../../../common/security/safe-url.service';
import {
  ConnectorInspectOptions,
  LinkMetadata,
  ResourceConnector,
  SyncPage,
} from './resource-connector.interface';

const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_PUBLISHER_LENGTH = 255;
const MAX_SQLITE_BIGINT = 9_223_372_036_854_775_807n;

@Injectable()
export class LinkMetadataConnector implements ResourceConnector {
  readonly type = 'link_metadata';

  constructor(private readonly safeUrl: SafeUrlService) {}

  async inspect(url: string, options: ConnectorInspectOptions = {}): Promise<LinkMetadata> {
    const result = await this.safeUrl.fetchHtml(url, {
      validateUrl: async (candidate) => options.validateUrl?.(candidate.toString()),
    });
    const $ = cheerio.load(result.body);
    const pick = (selector: string, attribute = 'content') =>
      $(selector).first().attr(attribute)?.trim() || null;
    const absoluteHttpUrl = (value: string | null): string | null => {
      if (!value) return null;
      try {
        const resolved = this.safeUrl.normalize(new URL(value, result.url).toString()).toString();
        return resolved.length <= MAX_URL_LENGTH ? resolved : null;
      } catch {
        return null;
      }
    };
    const truncate = (value: string, maxLength: number) => value.slice(0, maxLength);
    const finalUrl = result.url.toString();
    if (finalUrl.length > MAX_URL_LENGTH) {
      throw new BadRequestException(`Final URL exceeds ${MAX_URL_LENGTH} character limit`);
    }
    const canonicalUrl = absoluteHttpUrl(pick('link[rel="canonical"]', 'href')) ?? finalUrl;
    const rawTitle =
      pick('meta[property="og:title"]') ??
      ($('title').first().text().trim() || result.url.hostname);
    const rawDescription =
      pick('meta[property="og:description"]') ?? pick('meta[name="description"]');
    const rawPublisher = pick('meta[property="og:site_name"]') ?? result.url.hostname;
    const title = truncate(rawTitle, MAX_TITLE_LENGTH);
    const description = rawDescription ? truncate(rawDescription, MAX_DESCRIPTION_LENGTH) : null;
    const publisher = truncate(rawPublisher, MAX_PUBLISHER_LENGTH);
    const previewUrl = absoluteHttpUrl(pick('meta[property="og:image"]'));
    const faviconUrl = absoluteHttpUrl(pick('link[rel~="icon"]', 'href'));
    const contentLengthHeader = result.headers.get('content-length');
    const declaredContentLength =
      contentLengthHeader && /^\d+$/.test(contentLengthHeader) ? BigInt(contentLengthHeader) : null;
    const contentLength =
      declaredContentLength !== null && declaredContentLength <= MAX_SQLITE_BIGINT
        ? declaredContentLength
        : null;
    const contentLengthExceeded = declaredContentLength !== null && contentLength === null;
    const lastModified = result.headers.get('last-modified');

    return {
      requestedUrl: url,
      finalUrl,
      canonicalUrl,
      title,
      description,
      publisher,
      faviconUrl,
      previewUrl,
      httpStatus: result.status,
      contentType: result.headers.get('content-type'),
      contentLength,
      etag: result.headers.get('etag'),
      lastModified:
        lastModified && !Number.isNaN(Date.parse(lastModified)) ? new Date(lastModified) : null,
      rawMetadata: {
        title,
        canonicalUrl,
        description: description ?? '',
        publisher,
        contentLengthExceeded,
        metadataTruncated:
          rawTitle.length > MAX_TITLE_LENGTH ||
          (rawDescription?.length ?? 0) > MAX_DESCRIPTION_LENGTH ||
          rawPublisher.length > MAX_PUBLISHER_LENGTH,
      },
    };
  }

  async sync(): Promise<SyncPage> {
    throw new BadRequestException('LinkMetadataConnector does not support sync operations');
  }
}
