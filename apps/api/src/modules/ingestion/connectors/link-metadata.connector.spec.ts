import { describe, expect, it } from 'vitest';
import { LinkMetadataConnector } from './link-metadata.connector';

describe('LinkMetadataConnector', () => {
  it('extracts canonical URL and Open Graph metadata', async () => {
    const safeUrl = {
      fetchHtml: async () => ({
        url: new URL('https://example.com/articles/first'),
        status: 200,
        headers: new Headers({
          'content-type': 'text/html; charset=utf-8',
          'content-length': '128',
          etag: '"version-1"',
          'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
        }),
        body: `
          <html><head>
            <title>Fallback title</title>
            <link rel="canonical" href="/canonical" />
            <link rel="icon" href="/favicon.ico" />
            <meta property="og:title" content="Open Graph title" />
            <meta property="og:description" content="Description" />
            <meta property="og:site_name" content="Example" />
            <meta property="og:image" content="/preview.png" />
          </head></html>`,
      }),
      normalize: (value: string) => new URL(value),
    };
    const connector = new LinkMetadataConnector(safeUrl as never);

    const metadata = await connector.inspect('https://example.com/articles/first');

    expect(metadata.title).toBe('Open Graph title');
    expect(metadata.finalUrl).toBe('https://example.com/articles/first');
    expect(metadata.canonicalUrl).toBe('https://example.com/canonical');
    expect(metadata.previewUrl).toBe('https://example.com/preview.png');
    expect(metadata.faviconUrl).toBe('https://example.com/favicon.ico');
    expect(metadata.contentLength).toBe(BigInt(128));
    expect(metadata.etag).toBe('"version-1"');
  });

  it('does not retain non-HTTP metadata URLs', async () => {
    const safeUrl = {
      fetchHtml: async () => ({
        url: new URL('https://example.com/page'),
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        body: `
          <html><head>
            <link rel="canonical" href="javascript:alert(1)" />
            <meta property="og:image" content="data:image/png;base64,AA==" />
          </head></html>`,
      }),
      normalize: (value: string) => {
        const parsed = new URL(value);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('unsafe protocol');
        }
        return parsed;
      },
    };
    const connector = new LinkMetadataConnector(safeUrl as never);

    const metadata = await connector.inspect('https://example.com/page');

    expect(metadata.canonicalUrl).toBe('https://example.com/page');
    expect(metadata.previewUrl).toBeNull();
  });

  it('forwards source validation to every URL requested by the safe fetcher', async () => {
    const validateUrl = async (url: string) => {
      if (url.includes('outside.example')) throw new Error('outside source');
    };
    const safeUrl = {
      fetchHtml: async (_url: string, options: { validateUrl?: (url: URL) => Promise<void> }) => {
        await options.validateUrl?.(new URL('https://example.com/assets/start'));
        await options.validateUrl?.(new URL('https://outside.example/redirect'));
        throw new Error('outside source');
      },
      normalize: (value: string) => new URL(value),
    };
    const connector = new LinkMetadataConnector(safeUrl as never);

    await expect(
      connector.inspect('https://example.com/assets/start', { validateUrl }),
    ).rejects.toThrow('outside source');
  });

  it('truncates external display metadata to resource field limits', async () => {
    const safeUrl = {
      fetchHtml: async () => ({
        url: new URL('https://example.com/page'),
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        body: `<meta property="og:title" content="${'t'.repeat(300)}" />
               <meta property="og:description" content="${'d'.repeat(2100)}" />
               <meta property="og:site_name" content="${'p'.repeat(300)}" />`,
      }),
      normalize: (value: string) => new URL(value),
    };
    const connector = new LinkMetadataConnector(safeUrl as never);

    const metadata = await connector.inspect('https://example.com/page');

    expect(metadata.title).toHaveLength(255);
    expect(metadata.description).toHaveLength(2000);
    expect(metadata.publisher).toHaveLength(255);
    expect(metadata.rawMetadata.metadataTruncated).toBe(true);
  });

  it('rejects an overlong final redirect URL', async () => {
    const safeUrl = {
      fetchHtml: async () => ({
        url: new URL(`https://example.com/${'a'.repeat(2050)}`),
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        body: '<html></html>',
      }),
      normalize: (value: string) => new URL(value),
    };
    const connector = new LinkMetadataConnector(safeUrl as never);

    await expect(connector.inspect('https://example.com/page')).rejects.toThrow(
      'Final URL exceeds 2048 character limit',
    );
  });

  it('does not persist a content length that exceeds SQLite BIGINT range', async () => {
    const safeUrl = {
      fetchHtml: async () => ({
        url: new URL('https://example.com/page'),
        status: 200,
        headers: new Headers({
          'content-type': 'text/html',
          'content-length': '9223372036854775808',
        }),
        body: '<title>Example</title>',
      }),
      normalize: (value: string) => new URL(value),
    };
    const connector = new LinkMetadataConnector(safeUrl as never);

    const metadata = await connector.inspect('https://example.com/page');

    expect(metadata.contentLength).toBeNull();
    expect(metadata.rawMetadata.contentLengthExceeded).toBe(true);
  });
});
