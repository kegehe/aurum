import { BadRequestException } from '@nestjs/common';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CivitaiConnector } from './civitai.connector';
import { ResourceType } from '../../../common/constants/enums';

// Mock undici fetch
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

function makeCivitaiItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 12345,
    url: 'https://image.civitai.com/xG1nkqKTMzBHvpZaitr1SD/12345.jpeg',
    nsfwLevel: 0,
    type: 'image' as const,
    createdAt: '2024-01-15T10:30:00.000Z',
    postId: 67890,
    width: 1024,
    height: 768,
    hash: 'abc123',
    meta: {
      prompt: 'a beautiful landscape, highly detailed',
      negativePrompt: 'blurry, low quality',
      model: 'Stable Diffusion XL',
      sampler: 'DPM++ 2M Karras',
      cfgScale: 7,
      steps: 30,
    },
    stats: {
      commentCount: 5,
      likeCount: 42,
    },
    user: {
      username: 'testartist',
      image: 'https://civitai.com/avatars/testartist.png',
    },
    ...overrides,
  };
}

function makeCivitaiResponse(items: unknown[] = [], nextCursor: string | null = null) {
  return {
    items,
    metadata: {
      nextCursor,
      currentPage: 1,
      totalPages: 10,
      totalItems: 2000,
    },
  };
}

describe('CivitaiConnector', () => {
  let connector: CivitaiConnector;
  let safeUrl: ReturnType<typeof createMockSafeUrlService>;

  beforeEach(() => {
    vi.clearAllMocks();
    safeUrl = createMockSafeUrlService();
    connector = new CivitaiConnector(safeUrl as never);
  });

  describe('type', () => {
    it('returns "civitai"', () => {
      expect(connector.type).toBe('civitai');
    });
  });

  describe('inspect', () => {
    it('throws BadRequestException', async () => {
      try {
        await connector.inspect('https://civitai.com/images/123');
        expect.fail('Expected BadRequestException to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).message).toContain(
          'does not support single-URL inspection',
        );
      }
    });
  });

  describe('sync', () => {
    it('maps image item to RemoteResource correctly', async () => {
      const item = makeCivitaiItem();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeCivitaiResponse([item], 'cursor-2'),
      } as Response);

      const page = await connector.sync();

      expect(page.items).toHaveLength(1);
      const remote = page.items[0];
      expect(remote.externalId).toBe('12345');
      expect(remote.url).toBe(item.url);
      expect(remote.canonicalUrl).toBe('https://civitai.com/posts/67890');
      expect(remote.resourceType).toBe(ResourceType.image);
      expect(remote.mimeType).toBe('image/jpeg'); // inferred from .jpeg extension in URL
      expect(remote.title).toBe('Stable Diffusion XL - #12345');
      expect(remote.description).toBe('a beautiful landscape, highly detailed');
      expect(remote.authorName).toBe('testartist');
      expect(remote.authorUrl).toBe('https://civitai.com/user/testartist');
      expect(remote.publisher).toBe('Civitai');
      expect(remote.width).toBe(1024);
      expect(remote.height).toBe(768);
      expect(remote.externalCreatedAt).toEqual(new Date('2024-01-15T10:30:00.000Z'));
      expect(remote.additionalLocators).toEqual([
        { locatorType: 'page', url: 'https://civitai.com/posts/67890' },
        { locatorType: 'api', url: 'https://civitai.com/api/v1/images/12345' },
      ]);
    });

    it('maps video item to ResourceType.video', async () => {
      const item = makeCivitaiItem({ type: 'video' });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeCivitaiResponse([item]),
      } as Response);

      const page = await connector.sync();
      expect(page.items[0].resourceType).toBe(ResourceType.video);
      expect(page.items[0].mimeType).toBe('video/mp4');
    });

    it('passes cursor, limit, and filter params to the API URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeCivitaiResponse([], null),
      } as Response);

      await connector.sync({
        cursor: 'test-cursor',
        limit: 50,
        filters: { sort: 'Newest', period: 'Month', nsfw: true },
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const calledUrl = String(mockFetch.mock.calls[0][0]);
      expect(calledUrl).toContain('limit=50');
      expect(calledUrl).toContain('sort=Newest');
      expect(calledUrl).toContain('period=Month');
      expect(calledUrl).toContain('nsfw=true');
      expect(calledUrl).toContain('cursor=test-cursor');
    });

    it('clamps limit to [1, 200] range', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => makeCivitaiResponse([], null),
      } as Response);

      await connector.sync({ limit: 0 });
      let calledUrl = String(mockFetch.mock.calls[0][0]);
      expect(calledUrl).toContain('limit=1');

      await connector.sync({ limit: 300 });
      calledUrl = String(mockFetch.mock.calls[1][0]);
      expect(calledUrl).toContain('limit=200');
    });

    it('returns nextCursor from API metadata', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeCivitaiResponse([], 'next-page-cursor'),
      } as Response);

      const page = await connector.sync();
      expect(page.nextCursor).toBe('next-page-cursor');
    });

    it('returns null nextCursor when no more pages', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeCivitaiResponse([], null),
      } as Response);

      const page = await connector.sync();
      expect(page.nextCursor).toBeNull();
    });

    it('throws on non-2xx API response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      } as unknown as Response);

      try {
        await connector.sync();
        expect.fail('Expected BadRequestException to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).message).toContain('HTTP 500');
      }
    });

    it('truncates long title and description', async () => {
      const longPrompt = 'x'.repeat(3000);
      const longModel = 'm'.repeat(300);
      const item = makeCivitaiItem({
        meta: { prompt: longPrompt, model: longModel },
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeCivitaiResponse([item]),
      } as Response);

      const page = await connector.sync();
      expect(page.items[0].title.length).toBeLessThanOrEqual(255);
      expect(page.items[0].description!.length).toBeLessThanOrEqual(2000);
    });

    it('constructs correct canonicalUrl from postId', async () => {
      const item = makeCivitaiItem({ postId: 99999 });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeCivitaiResponse([item]),
      } as Response);

      const page = await connector.sync();
      expect(page.items[0].canonicalUrl).toBe('https://civitai.com/posts/99999');
    });

    it('falls back to /images/{id} when no postId', async () => {
      const item = makeCivitaiItem({ postId: undefined });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeCivitaiResponse([item]),
      } as Response);

      const page = await connector.sync();
      expect(page.items[0].canonicalUrl).toBe('https://civitai.com/images/12345');
    });

    it('returns totalItems from metadata', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeCivitaiResponse([makeCivitaiItem()], 'cursor-2'),
      } as Response);

      const page = await connector.sync();
      expect(page.totalItems).toBe(2000);
    });

    it('closes the dispatcher in finally block', async () => {
      const mockClose = vi.fn().mockResolvedValue(undefined);
      (safeUrl.createSafeDispatcher as ReturnType<typeof vi.fn>).mockReturnValue({
        close: mockClose,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeCivitaiResponse([], null),
      } as Response);

      await connector.sync();
      expect(mockClose).toHaveBeenCalled();
    });
  });
});
