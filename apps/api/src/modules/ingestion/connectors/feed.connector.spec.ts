import { BadRequestException } from '@nestjs/common';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeedConnector, feedItemExternalId, htmlToText } from './feed.connector';
import { ResourceType } from '../../../common/constants/enums';

vi.mock('undici', () => ({
  fetch: vi.fn(),
}));

import { fetch } from 'undici';

const mockFetch = vi.mocked(fetch);

const FEED_URL = 'https://example.com/feed.xml';

function createMockSafeUrlService() {
  return {
    normalize: vi.fn((value: string) => new URL(value)),
    createSafeDispatcher: vi.fn().mockReturnValue({
      close: vi.fn().mockResolvedValue(undefined),
    }),
  } as unknown as import('../../../common/security/safe-url.service').SafeUrlService;
}

function createService() {
  const safeUrl = createMockSafeUrlService();
  return { service: new FeedConnector(safeUrl), safeUrl };
}

function encodeBody(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function mockResponse(options: { status?: number; body?: string; contentType?: string }) {
  const status = options.status ?? 200;
  const body = options.body ?? '';
  const headers = new Map<string, string>();
  headers.set('content-type', options.contentType ?? 'application/rss+xml; charset=utf-8');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () =>
            sent
              ? { done: true, value: undefined }
              : ((sent = true), { done: false, value: encodeBody(body) }),
          cancel: async () => undefined,
        };
      },
    },
  } as unknown as Response;
}

function rssXml(items: string, options: { feedTitle?: string | null } = {}): string {
  const feedTitle =
    options.feedTitle === null
      ? '<title></title>'
      : `<title>${options.feedTitle ?? 'Example Feed'}</title>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:media="http://search.yahoo.com/mrss/" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" version="2.0">
  <channel>
    ${feedTitle}
    <link>https://example.com</link>
    <description>desc</description>
    ${items}
  </channel>
</rss>`;
}

function singleRssItem(overrides: Record<string, string | null> = {}, rawInner = ''): string {
  const fields: Record<string, string | null> = {
    guid: 'item-1',
    title: 'First item',
    link: 'https://example.com/posts/1',
    pubDate: 'Mon, 21 Sep 2026 08:00:00 GMT',
    ...overrides,
  };
  const tags = Object.entries(fields)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `<${key}>${value}</${key}>`)
    .join('');
  return `<item>${tags}${rawInner}</item>`;
}

const AUDIO_ENCLOSURE =
  '<enclosure url="https://cdn.example.com/ep1.mp3" type="audio/mpeg" length="1234"/>';

beforeEach(() => {
  mockFetch.mockReset();
});

describe('htmlToText', () => {
  it('strips tags and decodes common entities', () => {
    expect(htmlToText('<p>Hello &amp; bye&nbsp;&lt;3</p>')).toBe('Hello & bye <3');
  });

  it('returns null for empty input', () => {
    expect(htmlToText('   ')).toBeNull();
    expect(htmlToText(undefined)).toBeNull();
  });
});

describe('feedItemExternalId', () => {
  it('prefers a permalink guid', () => {
    expect(feedItemExternalId({ guid: 'https://example.com/p/1', link: 'x' })).toBe(
      'https://example.com/p/1',
    );
  });

  it('uses non-permalink guid as identifier', () => {
    expect(
      feedItemExternalId({ guid: { _text: 'tag:ex,2026:123', $: { isPermaLink: 'false' } } }),
    ).toBe('tag:ex,2026:123');
  });

  it('falls back to link when guid is empty', () => {
    expect(feedItemExternalId({ guid: '  ', link: 'https://example.com/p/2' })).toBe(
      'https://example.com/p/2',
    );
  });

  it('returns null without any identifier', () => {
    expect(feedItemExternalId({})).toBeNull();
  });
});

describe('FeedConnector', () => {
  it('has rss type and refuses single-URL inspection', async () => {
    const { service } = createService();
    expect(service.type).toBe('rss');
    await expect(service.inspect('https://example.com')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('requires a feed URL', async () => {
    const { service } = createService();
    await expect(service.sync({ filters: {} })).rejects.toThrow(/feedUrl/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects non-http feed URLs', async () => {
    const { service } = createService();
    await expect(
      service.sync({ filters: { feedUrl: 'ftp://example.com/feed.xml' } }),
    ).rejects.toThrow(/http or https/);
    await expect(service.sync({ filters: { feedUrl: 'not a url' } })).rejects.toThrow(
      /Invalid feed URL/,
    );
  });

  it('maps an RSS 2.0 enclosure item to a downloadable audio resource', async () => {
    mockFetch.mockResolvedValue(mockResponse({ body: rssXml(singleRssItem({}, AUDIO_ENCLOSURE)) }));
    const { service, safeUrl } = createService();

    const page = await service.sync({ filters: { feedUrl: FEED_URL }, limit: 10 });

    expect(safeUrl.createSafeDispatcher).toHaveBeenCalledWith(
      expect.anything(),
      new URL(FEED_URL).hostname,
    );
    expect(page.totalItems).toBe(1);
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
    const item = page.items[0];
    expect(item.externalId).toBe('item-1');
    expect(item.url).toBe('https://cdn.example.com/ep1.mp3');
    expect(item.canonicalUrl).toBe('https://example.com/posts/1');
    expect(item.resourceType).toBe(ResourceType.audio);
    expect(item.mimeType).toBe('audio/mpeg');
    expect(item.title).toBe('First item');
    expect(item.publisher).toBe('Example Feed');
    expect(item.externalCreatedAt).toEqual(new Date('2026-09-21T08:00:00.000Z'));
    expect(item.additionalLocators).toEqual([
      { locatorType: 'page', url: 'https://example.com/posts/1' },
    ]);
    expect(item.rawMetadata).toMatchObject({ feedUrl: FEED_URL, kind: 'feed_item' });
  });

  it('uses hostname as publisher when the feed has no title', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({ body: rssXml(singleRssItem(), { feedTitle: null }) }),
    );
    const { service } = createService();
    const page = await service.sync({ filters: { feedUrl: FEED_URL } });
    expect(page.items[0].publisher).toBe('example.com');
  });

  it('parses Atom entries and media:content', async () => {
    const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <title>Atom Blog</title>
  <id>urn:uuid:feed</id>
  <updated>2026-09-20T10:00:00Z</updated>
  <entry>
    <id>tag:ex,2026:entry-9</id>
    <title>Atom &lt;entry&gt;</title>
    <link href="https://blog.example.com/entry-9"/>
    <updated>2026-09-20T10:00:00Z</updated>
    <content type="html">&lt;p&gt;body text&lt;/p&gt;</content>
    <media:content url="https://cdn.example.com/shot.png" type="image/png" medium="image"/>
  </entry>
</feed>`;
    mockFetch.mockResolvedValue(mockResponse({ body: atom, contentType: 'application/atom+xml' }));
    const { service } = createService();

    const page = await service.sync({ filters: { feedUrl: 'https://blog.example.com/atom' } });

    expect(page.items).toHaveLength(1);
    const item = page.items[0];
    expect(item.externalId).toBe('tag:ex,2026:entry-9');
    expect(item.url).toBe('https://cdn.example.com/shot.png');
    expect(item.resourceType).toBe(ResourceType.image);
    expect(item.mimeType).toBe('image/png');
    expect(item.previewUrl).toBe('https://cdn.example.com/shot.png');
    expect(item.title).toBe('Atom <entry>');
    expect(item.description).toBe('body text');
    expect(item.publisher).toBe('Atom Blog');
  });

  it('parses JSON feeds', async () => {
    const json = JSON.stringify({
      version: 'https://jsonfeed.org/version/1',
      title: 'JSON Feed',
      home_page_url: 'https://jf.example.com',
      items: [
        {
          id: 'jf-1',
          url: 'https://jf.example.com/posts/1',
          title: 'Hello JSON',
          attachments: [{ url: 'https://cdn.example.com/a.mov', mime_type: 'video/quicktime' }],
          date_published: '2026-09-19T00:00:00Z',
          author: { name: 'Jane' },
        },
      ],
    });
    mockFetch.mockResolvedValue(mockResponse({ body: json, contentType: 'application/json' }));
    const { service } = createService();

    const page = await service.sync({ filters: { feedUrl: 'https://jf.example.com/feed.json' } });

    expect(page.items).toHaveLength(1);
    const item = page.items[0];
    expect(item.externalId).toBe('jf-1');
    expect(item.url).toBe('https://cdn.example.com/a.mov');
    expect(item.resourceType).toBe(ResourceType.video);
    expect(item.authorName).toBe('Jane');
    expect(item.externalCreatedAt).toEqual(new Date('2026-09-19T00:00:00Z'));
  });

  it('falls back to the page link when an item has no attachment', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        body: rssXml(singleRssItem({ link: 'https://example.com/blog' })),
      }),
    );
    const { service } = createService();
    const page = await service.sync({ filters: { feedUrl: FEED_URL } });
    expect(page.items[0].url).toBe('https://example.com/blog');
    expect(page.items[0].resourceType).toBe(ResourceType.text);
  });

  it('uses an inline image from HTML content as preview', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        body: rssXml(
          singleRssItem(
            {},
            '<content:encoded><![CDATA[<div><img src="https://cdn.example.com/inline.jpg"/></div>]]></content:encoded>',
          ),
        ),
      }),
    );
    const { service } = createService();
    const page = await service.sync({ filters: { feedUrl: FEED_URL } });
    expect(page.items[0].previewUrl).toBe('https://cdn.example.com/inline.jpg');
  });

  it('skips items without any identifier', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({ body: rssXml('<item><title>ghost</title></item>' + singleRssItem()) }),
    );
    const { service } = createService();
    const page = await service.sync({ filters: { feedUrl: FEED_URL } });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].externalId).toBe('item-1');
  });

  it('pages through a large feed with offset cursors', async () => {
    const items = Array.from(
      { length: 5 },
      (_, i) =>
        `<item><guid>g${i}</guid><title>t${i}</title><link>https://example.com/${i}</link></item>`,
    ).join('');
    mockFetch.mockResolvedValue(mockResponse({ body: rssXml(items) }));
    const { service } = createService();

    const first = await service.sync({ filters: { feedUrl: FEED_URL }, limit: 2 });
    expect(first.items.map((item) => item.externalId)).toEqual(['g0', 'g1']);
    expect(first.nextCursor).toBe('offset:2');
    expect(first.totalItems).toBe(5);

    const second = await service.sync({
      filters: { feedUrl: FEED_URL },
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.externalId)).toEqual(['g2', 'g3']);
    expect(second.nextCursor).toBe('offset:4');

    const last = await service.sync({
      filters: { feedUrl: FEED_URL },
      limit: 2,
      cursor: 'offset:4',
    });
    expect(last.items.map((item) => item.externalId)).toEqual(['g4']);
    expect(last.nextCursor).toBeNull();
  });

  it('treats unknown cursor formats as the first page', async () => {
    mockFetch.mockResolvedValue(mockResponse({ body: rssXml(singleRssItem()) }));
    const { service } = createService();
    const page = await service.sync({ filters: { feedUrl: FEED_URL }, cursor: 'page-7' });
    expect(page.items[0].externalId).toBe('item-1');
  });

  it('clamps the page limit into range', async () => {
    mockFetch.mockResolvedValue(mockResponse({ body: rssXml(singleRssItem()) }));
    const { service } = createService();
    // limit=0 → 夹到 1；limit=9999 → 夹到 200。只需能正常返回一页
    await service.sync({ filters: { feedUrl: FEED_URL }, limit: 0 });
    await service.sync({ filters: { feedUrl: FEED_URL }, limit: Number.NaN });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('reports non-ok responses clearly', async () => {
    const { service } = createService();

    mockFetch.mockResolvedValue(mockResponse({ status: 404, body: 'nope' }));
    await expect(service.sync({ filters: { feedUrl: FEED_URL } })).rejects.toThrow(
      /Feed not found/,
    );

    mockFetch.mockResolvedValue(mockResponse({ status: 500, body: 'Internal Server Error' }));
    await expect(service.sync({ filters: { feedUrl: FEED_URL } })).rejects.toThrow(/HTTP 500/);
  });

  it('rejects unparsable payloads', async () => {
    mockFetch.mockResolvedValue(mockResponse({ body: 'this is not a feed' }));
    const { service } = createService();
    await expect(service.sync({ filters: { feedUrl: FEED_URL } })).rejects.toThrow(
      /Failed to parse feed/,
    );
  });

  it('rejects feeds larger than the size cap', async () => {
    const huge = rssXml(singleRssItem()) + 'x'.repeat(1024 * 1024);
    mockFetch.mockResolvedValue(mockResponse({ body: huge }));
    const { service } = createService();
    await expect(service.sync({ filters: { feedUrl: FEED_URL } })).rejects.toThrow(/KB limit/);
  });

  it('follows redirects per hop with a fresh safe dispatcher', async () => {
    const { service, safeUrl } = createService();
    const dispatcher = { close: vi.fn().mockResolvedValue(undefined) };
    (safeUrl.createSafeDispatcher as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(dispatcher)
      .mockReturnValueOnce({ close: vi.fn().mockResolvedValue(undefined) });
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 301,
        headers: { get: (n: string) => (n.toLowerCase() === 'location' ? FEED_URL : null) },
        body: {
          cancel: async () => undefined,
          getReader: () => ({ read: async () => ({ done: true, value: undefined }) }),
        },
      } as unknown as Response)
      .mockResolvedValueOnce(mockResponse({ body: rssXml(singleRssItem()) }));

    const page = await service.sync({
      filters: { feedUrl: 'https://short.example.com/feed' },
    });

    expect(page.items).toHaveLength(1);
    const hosts = (safeUrl.createSafeDispatcher as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[1],
    );
    expect(hosts).toEqual(['short.example.com', 'example.com']);
    expect(dispatcher.close).toHaveBeenCalled();
  });

  it('stops when redirects loop beyond the limit', async () => {
    const { service } = createService();
    let hop = 0;
    mockFetch.mockImplementation(async () => ({
      ok: false,
      status: 302,
      headers: {
        get: (n: string) =>
          n.toLowerCase() === 'location' ? `https://r${hop++}.example.com/feed` : null,
      },
      body: {
        cancel: async () => undefined,
        getReader: () => ({ read: async () => ({ done: true, value: undefined }) }),
      },
    })) as unknown as ReturnType<typeof vi.fn>;

    await expect(service.sync({ filters: { feedUrl: FEED_URL } })).rejects.toThrow(
      /Too many redirects/,
    );
  });

  it('refuses redirect targets on unsupported protocols', async () => {
    const { service } = createService();
    mockFetch.mockResolvedValue({
      ok: false,
      status: 302,
      headers: { get: () => 'file:///etc/passwd' },
      body: {
        cancel: async () => undefined,
        getReader: () => ({ read: async () => ({ done: true, value: undefined }) }),
      },
    } as unknown as Response);

    await expect(service.sync({ filters: { feedUrl: FEED_URL } })).rejects.toThrow(
      /Unsupported protocol/,
    );
  });

  it('closes the dispatcher even when the request fails', async () => {
    const { service, safeUrl } = createService();
    const dispatcher = { close: vi.fn().mockResolvedValue(undefined) };
    (safeUrl.createSafeDispatcher as ReturnType<typeof vi.fn>).mockReturnValue(dispatcher);
    mockFetch.mockRejectedValue(new Error('socket hang up'));

    await expect(service.sync({ filters: { feedUrl: FEED_URL } })).rejects.toThrow(
      /socket hang up/,
    );
    expect(dispatcher.close).toHaveBeenCalled();
  });

  it('sends a feed-specific accept header and user agent', async () => {
    mockFetch.mockResolvedValue(mockResponse({ body: rssXml(singleRssItem()) }));
    const { service } = createService();
    await service.sync({ filters: { feedUrl: FEED_URL } });

    const [, init] = mockFetch.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers['user-agent']).toBe('aurum-feed-connector/0.1');
    expect(headers.accept).toContain('application/atom+xml');
    expect(init.redirect).toBe('manual');
  });
});
