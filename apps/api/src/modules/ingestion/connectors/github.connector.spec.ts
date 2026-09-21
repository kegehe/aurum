import { BadRequestException } from '@nestjs/common';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubConnector, parseGithubRepo } from './github.connector';
import { ResourceType } from '../../../common/constants/enums';

vi.mock('undici', () => ({
  fetch: vi.fn(),
}));

import { fetch } from 'undici';

const mockFetch = vi.mocked(fetch);

function createMockSafeUrlService() {
  return {
    normalize: vi.fn((value: string) => new URL(value)),
    createSafeDispatcher: vi.fn().mockReturnValue({
      close: vi.fn().mockResolvedValue(undefined),
    }),
  } as unknown as import('../../../common/security/safe-url.service').SafeUrlService;
}

function createMockConfig(token = '') {
  return {
    get: vi.fn((key: string) => (key === 'github.token' ? token : undefined)),
  } as never;
}

function mockResponse(options: {
  status?: number;
  json?: unknown;
  etag?: string | null;
  retryAfter?: string | null;
  text?: string;
}) {
  const headers = new Map<string, string>();
  if (options.etag) headers.set('etag', options.etag);
  if (options.retryAfter) headers.set('retry-after', options.retryAfter);
  return {
    ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
    status: options.status ?? 200,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    json: async () => options.json,
    text: async () => options.text ?? '',
  } as unknown as Response;
}

function makeAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: 555,
    name: 'app-1.0.0.zip',
    label: null,
    content_type: 'application/zip',
    browser_download_url: 'https://github.com/owner/repo/releases/download/v1.0.0/app-1.0.0.zip',
    size: 12345,
    download_count: 7,
    ...overrides,
  };
}

function makeRelease(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    tag_name: 'v1.0.0',
    name: 'Version 1.0.0',
    body: 'Release notes here',
    draft: false,
    prerelease: false,
    html_url: 'https://github.com/owner/repo/releases/tag/v1.0.0',
    published_at: '2024-03-01T00:00:00Z',
    created_at: '2024-03-01T00:00:00Z',
    author: { login: 'maintainer' },
    assets: [makeAsset()],
    ...overrides,
  };
}

describe('parseGithubRepo', () => {
  it('parses owner/name shorthand', () => {
    expect(parseGithubRepo('owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses github.com URLs and strips .git', () => {
    expect(parseGithubRepo('https://github.com/octocat/Hello-World.git')).toEqual({
      owner: 'octocat',
      repo: 'Hello-World',
    });
  });

  it('rejects non-github hosts and malformed input', () => {
    expect(parseGithubRepo('https://evil.example/owner/repo')).toBeNull();
    expect(parseGithubRepo('owner')).toBeNull();
    expect(parseGithubRepo('')).toBeNull();
    expect(parseGithubRepo(undefined)).toBeNull();
    expect(parseGithubRepo('owner/../repo')).toBeNull();
  });
});

describe('GitHubConnector', () => {
  let connector: GitHubConnector;
  let safeUrl: ReturnType<typeof createMockSafeUrlService>;

  beforeEach(() => {
    vi.clearAllMocks();
    safeUrl = createMockSafeUrlService();
    connector = new GitHubConnector(safeUrl as never, createMockConfig());
  });

  describe('inspect', () => {
    it('throws BadRequestException', async () => {
      await expect(connector.inspect('https://github.com/owner/repo')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('sync', () => {
    it('requires a valid repo filter', async () => {
      await expect(connector.sync({ filters: {} })).rejects.toThrow(/requires a valid "repo"/);
    });

    it('maps release assets to RemoteResource', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ json: [makeRelease({ assets: [makeAsset({ name: 'bundle.png' })] })] }),
      );

      const page = await connector.sync({ filters: { repo: 'owner/repo' } });
      expect(page.items).toHaveLength(1);
      const remote = page.items[0];
      expect(remote.externalId).toBe('555');
      expect(remote.url).toBe(
        'https://github.com/owner/repo/releases/download/v1.0.0/app-1.0.0.zip',
      );
      expect(remote.canonicalUrl).toBe('https://github.com/owner/repo/releases/tag/v1.0.0');
      expect(remote.resourceType).toBe(ResourceType.image);
      expect(remote.title).toBe('Version 1.0.0 - bundle.png');
      expect(remote.description).toBe('Release notes here');
      expect(remote.authorName).toBe('maintainer');
      expect(remote.publisher).toBe('GitHub');
      expect(remote.externalCreatedAt).toEqual(new Date('2024-03-01T00:00:00Z'));
      expect(remote.additionalLocators).toEqual([
        { locatorType: 'page', url: 'https://github.com/owner/repo/releases/tag/v1.0.0' },
      ]);
      expect(remote.rawMetadata).toMatchObject({
        releaseId: 100,
        assetId: 555,
        kind: 'release_asset',
      });
    });

    it('falls back to the tag source zip when a release has no assets', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ json: [makeRelease({ assets: [] })] }));

      const page = await connector.sync({ filters: { repo: 'owner/repo' } });
      expect(page.items).toHaveLength(1);
      expect(page.items[0].externalId).toBe('release-100');
      expect(page.items[0].url).toBe('https://github.com/owner/repo/archive/refs/tags/v1.0.0.zip');
      expect(page.items[0].resourceType).toBe(ResourceType.archive);
      expect(page.items[0].rawMetadata).toMatchObject({ kind: 'source_archive' });
    });

    it('skips draft releases', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ json: [makeRelease({ draft: true }), makeRelease({ id: 101 })] }),
      );

      const page = await connector.sync({ filters: { repo: 'owner/repo' } });
      expect(page.items).toHaveLength(1);
      expect(page.items[0].externalId).toBe('555');
    });

    it('classifies resource type from extension and content type', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          json: [
            makeRelease({
              assets: [
                makeAsset({ id: 1, name: 'game.tar.gz', content_type: 'application/gzip' }),
                makeAsset({ id: 2, name: 'clip.mp4', content_type: 'video/mp4' }),
                makeAsset({ id: 3, name: 'data.bin', content_type: 'application/octet-stream' }),
              ],
            }),
          ],
        }),
      );

      const page = await connector.sync({ filters: { repo: 'owner/repo' } });
      expect(page.items.map((item) => item.resourceType)).toEqual([
        ResourceType.archive,
        ResourceType.video,
        ResourceType.other,
      ]);
    });

    it('uses page-number cursors and reports next page only for a full page', async () => {
      const fullPage = Array.from({ length: 30 }, (_, i) => makeRelease({ id: 200 + i }));
      mockFetch.mockResolvedValueOnce(mockResponse({ json: fullPage }));

      const page = await connector.sync({ filters: { repo: 'owner/repo' } });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(String(mockFetch.mock.calls[0][0])).toContain('page=1');
      expect(page.nextCursor).toBe('2');

      mockFetch.mockResolvedValueOnce(mockResponse({ json: [makeRelease()] }));
      const last = await connector.sync({ filters: { repo: 'owner/repo' }, cursor: '5' });
      expect(String(mockFetch.mock.calls[1][0])).toContain('page=5');
      expect(last.nextCursor).toBeNull();
    });

    it('sends an Authorization header when GITHUB_TOKEN is configured', async () => {
      const tokenConnector = new GitHubConnector(
        safeUrl as never,
        createMockConfig('ghp_testtoken123'),
      );
      mockFetch.mockResolvedValueOnce(mockResponse({ json: [] }));

      await tokenConnector.sync({ filters: { repo: 'owner/repo' } });
      const init = mockFetch.mock.calls[0][1] as { headers: Record<string, string> };
      expect(init.headers.authorization).toBe('Bearer ghp_testtoken123');
    });

    it('sends If-None-Match after caching an ETag and handles 304', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ json: [makeRelease()], etag: 'W/"abc123"' }));
      await connector.sync({ filters: { repo: 'owner/repo' } });

      mockFetch.mockResolvedValueOnce(mockResponse({ status: 304 }));
      const second = await connector.sync({ filters: { repo: 'owner/repo' } });
      const init = mockFetch.mock.calls[1][1] as { headers: Record<string, string> };
      expect(init.headers['if-none-match']).toBe('W/"abc123"');
      expect(second.items).toEqual([]);
      expect(second.nextCursor).toBeNull();
    });

    it('surfaces rate limit errors with retry-after', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ status: 403, retryAfter: '42', json: { message: 'rate limited' } }),
      );

      await expect(connector.sync({ filters: { repo: 'owner/repo' } })).rejects.toThrow(
        /rate limit reached \(HTTP 403\); retry after 42s/,
      );
    });

    it('reports a clear error for unknown repositories', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ status: 404 }));
      await expect(connector.sync({ filters: { repo: 'no/such-repo' } })).rejects.toThrow(
        /not found: no\/such-repo/,
      );
    });

    it('clamps per_page to [1, 100] and tolerates bad cursors', async () => {
      mockFetch.mockResolvedValue(mockResponse({ json: [] }));

      await connector.sync({ filters: { repo: 'owner/repo' }, limit: 500 });
      expect(String(mockFetch.mock.calls[0][0])).toContain('per_page=100');

      await connector.sync({ filters: { repo: 'owner/repo' }, cursor: 'garbage' });
      expect(String(mockFetch.mock.calls[1][0])).toContain('page=1');
    });

    it('closes the dispatcher after the request', async () => {
      const mockClose = vi.fn().mockResolvedValue(undefined);
      (safeUrl.createSafeDispatcher as ReturnType<typeof vi.fn>).mockReturnValue({
        close: mockClose,
      });
      mockFetch.mockResolvedValueOnce(mockResponse({ json: [] }));

      await connector.sync({ filters: { repo: 'owner/repo' } });
      expect(mockClose).toHaveBeenCalled();
    });
  });
});
