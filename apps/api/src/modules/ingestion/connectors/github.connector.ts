import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

const GITHUB_API_BASE = 'https://api.github.com';
const DEFAULT_PAGE_LIMIT = 30;
const MAX_PAGE_LIMIT = 100;
const MIN_PAGE_LIMIT = 1;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_TITLE_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 2000;
const ETAG_CACHE_MAX = 50;

interface GithubAsset {
  id: number;
  name: string;
  label?: string | null;
  content_type?: string;
  browser_download_url: string;
  size?: number;
  download_count?: number;
  created_at?: string;
  updated_at?: string;
}

interface GithubRelease {
  id: number;
  tag_name: string;
  name?: string | null;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  html_url?: string;
  published_at?: string | null;
  created_at?: string;
  author?: { login?: string };
  assets?: GithubAsset[];
}

/** 解析 `owner/repo`、`github.com/owner/repo` 等形式；非法时返回 null */
export function parseGithubRepo(input: unknown): { owner: string; repo: string } | null {
  if (typeof input !== 'string') return null;
  const candidate = input.trim();
  if (!candidate) return null;

  let segments: string[];
  if (/^https?:\/\//i.test(candidate)) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return null;
    }
    if (url.hostname !== 'github.com' && url.hostname !== 'api.github.com') return null;
    segments = url.pathname.split('/').filter(Boolean);
  } else {
    // 简写形式：owner/repo 或 github.com/owner/repo
    segments = candidate
      .replace(/^(www\.|github\.com)\//i, '')
      .split(/[/?#]/)
      .filter(Boolean);
  }
  if (segments.length < 2) return null;
  const [owner, rawRepo] = segments;
  const repo = rawRepo.replace(/\.git$/, '');
  const safeName = /^[A-Za-z0-9._-]{1,100}$/;
  // 排除 '.'/'..'，防止拼接 API 路径时发生穿越
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
  if (!safeName.test(owner) || !safeName.test(repo)) return null;
  return { owner, repo };
}

@Injectable()
export class GitHubConnector implements ResourceConnector {
  readonly type = 'github';

  /** url -> ETag，用于 If-None-Match 增量请求 */
  private readonly etagCache = new Map<string, string>();

  constructor(
    private readonly safeUrl: SafeUrlService,
    private readonly config: ConfigService,
  ) {}

  async inspect(_url: string, _options?: ConnectorInspectOptions): Promise<LinkMetadata> {
    throw new BadRequestException(
      'GitHubConnector does not support single-URL inspection. Use sync instead.',
    );
  }

  async sync(options: SyncOptions = {}): Promise<SyncPage> {
    const filters = options.filters ?? {};
    const parsed = parseGithubRepo(filters.repo);
    if (!parsed) {
      throw new BadRequestException(
        'GitHub source requires a valid "repo" config (e.g. "owner/name" or a github.com URL)',
      );
    }
    const limit = this.clampLimit(options.limit ?? DEFAULT_PAGE_LIMIT);
    const page = this.parsePageCursor(options.cursor);

    const params = new URLSearchParams({ per_page: String(limit), page: String(page) });
    const endpoint = `${GITHUB_API_BASE}/repos/${parsed.owner}/${parsed.repo}/releases?${params.toString()}`;
    const dispatcher = this.safeUrl.createSafeDispatcher(
      { headersTimeout: 15_000, bodyTimeout: 20_000 },
      new URL(endpoint).hostname,
    );

    const token = this.config.get<string>('github.token');
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'aurum-github-connector/0.1',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const cachedEtag = this.etagCache.get(endpoint);
    if (cachedEtag) headers['if-none-match'] = cachedEtag;

    try {
      const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      const response = await fetch(endpoint, { dispatcher, signal, headers });

      if (response.status === 304) {
        // 列表未变化：无新内容，终止本次分页
        return { items: [], nextCursor: null, totalItems: null };
      }
      if (response.status === 403 || response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        throw new BadRequestException(
          `GitHub API rate limit reached (HTTP ${response.status})` +
            (retryAfter ? `; retry after ${retryAfter}s` : ''),
        );
      }
      if (response.status === 404) {
        throw new BadRequestException(
          `GitHub repository not found: ${parsed.owner}/${parsed.repo}`,
        );
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new BadRequestException(
          `GitHub API returned HTTP ${response.status}: ${body.slice(0, 200)}`,
        );
      }

      const etag = response.headers.get('etag');
      if (etag) this.rememberEtag(endpoint, etag);

      const releases = (await response.json()) as GithubRelease[];
      const items = releases
        .filter((release) => !release.draft)
        .flatMap((release) => this.mapRelease(release, parsed));

      return {
        items,
        // GitHub 分页游标即页号：满页才可能有下一页
        nextCursor: releases.length === limit ? String(page + 1) : null,
        totalItems: null,
      };
    } finally {
      await dispatcher.close();
    }
  }

  private mapRelease(
    release: GithubRelease,
    repo: { owner: string; repo: string },
  ): RemoteResource[] {
    const assets = release.assets ?? [];
    if (assets.length > 0) return assets.map((asset) => this.mapAsset(release, asset, repo));

    // 无 release 资产时回退到 tag 源码包，保证 release 本身可被镜像
    const zipUrl = `https://github.com/${repo.owner}/${repo.repo}/archive/refs/tags/${encodeURIComponent(release.tag_name)}.zip`;
    const base = this.releaseBase(release, repo);
    return [
      {
        ...base,
        externalId: `release-${release.id}`,
        url: zipUrl,
        resourceType: ResourceType.archive,
        mimeType: 'application/zip',
        title: this.truncate(`${release.name || release.tag_name} (source zip)`, MAX_TITLE_LENGTH),
        rawMetadata: {
          releaseId: release.id,
          tagName: release.tag_name,
          kind: 'source_archive',
        },
      },
    ];
  }

  private mapAsset(
    release: GithubRelease,
    asset: GithubAsset,
    repo: { owner: string; repo: string },
  ): RemoteResource {
    const resourceType = this.classifyResourceType(asset.name, asset.content_type);
    return {
      ...this.releaseBase(release, repo),
      externalId: String(asset.id),
      url: asset.browser_download_url,
      resourceType,
      mimeType: asset.content_type || this.guessMimeType(asset.name),
      title: this.truncate(
        `${release.name || release.tag_name} - ${asset.label || asset.name}`,
        MAX_TITLE_LENGTH,
      ),
      rawMetadata: {
        releaseId: release.id,
        assetId: asset.id,
        tagName: release.tag_name,
        assetName: asset.name,
        sizeBytes: asset.size ?? null,
        downloadCount: asset.download_count ?? null,
        kind: 'release_asset',
      },
    };
  }

  private releaseBase(
    release: GithubRelease,
    repo: { owner: string; repo: string },
  ): Omit<
    RemoteResource,
    'externalId' | 'url' | 'resourceType' | 'mimeType' | 'title' | 'rawMetadata'
  > {
    const authorName = release.author?.login ?? null;
    const description = release.body
      ? this.truncate(release.body.replace(/\r\n/g, '\n'), MAX_DESCRIPTION_LENGTH)
      : null;
    const canonicalUrl =
      release.html_url ??
      `https://github.com/${repo.owner}/${repo.repo}/releases/tag/${encodeURIComponent(release.tag_name)}`;
    return {
      canonicalUrl,
      description,
      authorName,
      authorUrl: authorName ? `https://github.com/${authorName}` : null,
      publisher: 'GitHub',
      previewUrl: null,
      width: null,
      height: null,
      externalCreatedAt: this.parseExternalDate(release.published_at ?? release.created_at),
      additionalLocators: [{ locatorType: 'page', url: canonicalUrl }],
    };
  }

  private classifyResourceType(name: string, contentType?: string | null): ResourceType {
    const lower = name.toLowerCase();
    if (/\.tar\.gz$|\.tgz$/.test(lower)) return ResourceType.archive;
    const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
    const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp']);
    const videoExts = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv']);
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
    if (contentType?.startsWith('image/')) return ResourceType.image;
    if (contentType?.startsWith('video/')) return ResourceType.video;
    if (contentType?.startsWith('audio/')) return ResourceType.audio;
    if (contentType === 'application/zip' || contentType === 'application/x-tar') {
      return ResourceType.archive;
    }
    return ResourceType.other;
  }

  private guessMimeType(name: string): string {
    const ext = name.toLowerCase().includes('.')
      ? name.slice(name.lastIndexOf('.') + 1).toLowerCase()
      : '';
    const map: Record<string, string> = {
      zip: 'application/zip',
      gz: 'application/gzip',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      mp4: 'video/mp4',
      pdf: 'application/pdf',
    };
    return map[ext] ?? 'application/octet-stream';
  }

  private parsePageCursor(cursor?: string | null): number {
    const parsed = Number.parseInt(cursor ?? '1', 10);
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
  }

  private rememberEtag(url: string, etag: string): void {
    if (this.etagCache.size >= ETAG_CACHE_MAX) this.etagCache.clear();
    this.etagCache.set(url, etag);
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
