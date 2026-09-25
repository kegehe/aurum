import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { DirectDownloadConnector } from './direct-download.connector';

vi.mock('undici', () => ({
  fetch: vi.fn(),
  // 真实模块导出被 SafeUrlService 使用（Agent/ProxyAgent），mock 时保留占位
  Agent: class {},
  ProxyAgent: class {},
}));
vi.mock('file-type', () => ({
  default: { fromFile: vi.fn() },
}));

import { fetch } from 'undici';
import fileType from 'file-type';

const mockFetch = vi.mocked(fetch);
const mockFromFile = vi.mocked(fileType.fromFile);

const URL_UNDER_TEST = 'https://cdn.example.com/files/photo.jpg';
const CONTENT = Buffer.from('jpeg-bytes-here', 'utf-8');

function createDeps(
  options: {
    maxFileSizeMB?: number;
    detected?: { mime: string; ext: string } | null;
    downloadDirectory?: string | null;
  } = {},
) {
  const dispatcher = { close: vi.fn().mockResolvedValue(undefined) };
  const safeUrl = {
    createSafeDispatcher: vi.fn().mockReturnValue(dispatcher),
    resolvePublicHost: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
  };
  const storage = {
    generateKey: vi.fn(
      (role: string, hash: string, _variant?: string, ext?: string) =>
        `${role}s/ab/cd/${hash}.${ext}`,
    ),
    put: vi.fn(async (_key: string, stream: NodeJS.ReadableStream) => {
      // 与真实驱动一样消费可读流：否则未读的 Readable 会在 finally 的 unlink 之后
      // 才 open，冒成 unhandled 'error'（ENOENT/EPERM）使 vitest 退出码变 1
      for await (const _chunk of stream) {
        // drain
      }
    }),
  };
  const config = {
    get: vi.fn(() => options.maxFileSizeMB ?? 100),
  };
  mockFromFile.mockResolvedValue(
    (options.detected === null
      ? undefined
      : (options.detected ?? { mime: 'image/jpeg', ext: 'jpg' })) as never,
  );
  return {
    connector: new DirectDownloadConnector(safeUrl as never, storage as never, config as never),
    safeUrl,
    storage,
    dispatcher,
  };
}

function response(options: {
  status?: number;
  contentType?: string | null;
  contentLength?: number | null;
  body?: Buffer | null;
  location?: string;
}) {
  const status = options.status ?? 200;
  const headers = new Map<string, string>();
  if (options.contentType) headers.set('content-type', options.contentType);
  if (options.contentLength != null) headers.set('content-length', String(options.contentLength));
  if (options.location) headers.set('location', options.location);
  const body = options.body === null ? null : (options.body ?? CONTENT);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    body: body
      ? {
          cancel: async () => undefined,
          getReader: () => {
            let sent = false;
            return {
              read: async () =>
                sent
                  ? { done: true, value: undefined }
                  : ((sent = true), { done: false, value: new Uint8Array(body) }),
              cancel: async () => undefined,
            };
          },
        }
      : null,
  } as unknown as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFromFile.mockReset();
});

describe('DirectDownloadConnector', () => {
  it('downloads, hashes and stores the file, reporting detected types', async () => {
    const deps = createDeps();
    mockFetch.mockResolvedValue(
      response({ contentType: 'image/jpeg', contentLength: CONTENT.length }),
    );

    const result = await deps.connector.download({
      url: URL_UNDER_TEST,
      expectedResourceType: 'image',
      declaredMimeType: 'image/jpeg',
    });

    const sha256 = createHash('sha256').update(CONTENT).digest('hex');
    expect(result).toEqual({
      storageKey: `originals/ab/cd/${sha256}.jpg`,
      sha256,
      mimeType: 'image/jpeg',
      extension: 'jpg',
      resourceType: 'image',
      sizeBytes: CONTENT.length,
    });
    expect(deps.storage.put).toHaveBeenCalled();
    expect(deps.dispatcher.close).toHaveBeenCalled();
  });

  it('prefixes the storage key with the source download directory', async () => {
    const deps = createDeps();
    mockFetch.mockResolvedValue(response({ contentType: 'image/jpeg' }));

    const result = await deps.connector.download({
      url: URL_UNDER_TEST,
      expectedResourceType: 'image',
      downloadDirectory: 'civitai/anime',
    });

    expect(result.storageKey).toMatch(/^civitai\/anime\/originals\//);
  });

  it('falls back to the declared MIME and URL extension when magic bytes are unknown', async () => {
    const deps = createDeps({ detected: null });
    mockFetch.mockResolvedValue(response({ contentType: 'application/octet-stream' }));

    const result = await deps.connector.download({
      url: 'https://cdn.example.com/files/archive.tar',
      expectedResourceType: 'archive',
      declaredMimeType: 'application/x-tar',
    });

    expect(result.mimeType).toBe('application/x-tar');
    expect(result.extension).toBe('tar');
  });

  it('rejects an unparseable URL before any request', async () => {
    const deps = createDeps();
    await expect(
      deps.connector.download({ url: 'not a url', expectedResourceType: 'image' }),
    ).rejects.toThrow(/Invalid download URL/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('surfaces non-ok responses as HTTP status errors', async () => {
    const deps = createDeps();
    mockFetch.mockResolvedValue(response({ status: 404, body: Buffer.alloc(0) }));

    await expect(
      deps.connector.download({ url: URL_UNDER_TEST, expectedResourceType: 'image' }),
    ).rejects.toThrow('HTTP 404');
    expect(deps.storage.put).not.toHaveBeenCalled();
    expect(deps.dispatcher.close).toHaveBeenCalled();
  });

  it('refuses an HTML response for an image resource', async () => {
    const deps = createDeps();
    mockFetch.mockResolvedValue(response({ contentType: 'text/html; charset=utf-8' }));

    await expect(
      deps.connector.download({ url: URL_UNDER_TEST, expectedResourceType: 'image' }),
    ).rejects.toThrow(/Unexpected response content type: text\/html/);
    expect(deps.storage.put).not.toHaveBeenCalled();
  });

  it('allows text/plain when the resource is a text resource', async () => {
    const deps = createDeps({ detected: null });
    mockFetch.mockResolvedValue(response({ contentType: 'text/plain' }));

    const result = await deps.connector.download({
      url: 'https://cdn.example.com/notes.txt',
      expectedResourceType: 'text',
      declaredMimeType: 'text/plain',
    });
    expect(result.sizeBytes).toBe(CONTENT.length);
  });

  it('rejects a declared size above the cap without streaming', async () => {
    const deps = createDeps({ maxFileSizeMB: 1 });
    mockFetch.mockResolvedValue(
      response({ contentType: 'image/jpeg', contentLength: 2 * 1024 * 1024 }),
    );

    await expect(
      deps.connector.download({ url: URL_UNDER_TEST, expectedResourceType: 'image' }),
    ).rejects.toThrow(/File too large: 2097152 bytes > 1048576 limit/);
    expect(deps.storage.put).not.toHaveBeenCalled();
  });

  it('stops mid-stream once the real byte count passes the cap', async () => {
    const deps = createDeps({ maxFileSizeMB: 1 });
    const huge = Buffer.alloc(1024 * 1024 + 16, 7);
    mockFetch.mockResolvedValue(response({ contentType: 'image/jpeg', body: huge }));

    await expect(
      deps.connector.download({ url: URL_UNDER_TEST, expectedResourceType: 'image' }),
    ).rejects.toThrow(/File exceeds 1048576 byte limit/);
    expect(deps.storage.put).not.toHaveBeenCalled();
  });

  it('rejects an empty body', async () => {
    const deps = createDeps();
    mockFetch.mockResolvedValue(response({ contentType: 'image/jpeg', body: null }));

    await expect(
      deps.connector.download({ url: URL_UNDER_TEST, expectedResourceType: 'image' }),
    ).rejects.toThrow(/Empty response body/);
  });

  it('rejects content that is not a recognizable image', async () => {
    const deps = createDeps({ detected: null });
    mockFetch.mockResolvedValue(response({ contentType: 'image/jpeg' }));

    await expect(
      deps.connector.download({
        url: URL_UNDER_TEST,
        expectedResourceType: 'image',
        declaredMimeType: 'image/jpeg',
      }),
    ).rejects.toThrow(/not a recognizable image file/);
  });

  it('validates every redirect hop as a public host', async () => {
    const deps = createDeps();
    mockFetch
      .mockResolvedValueOnce(
        response({
          status: 302,
          location: 'https://mirror.example.com/photo.jpg',
          body: Buffer.alloc(0),
        }),
      )
      .mockResolvedValueOnce(response({ contentType: 'image/jpeg' }));

    const result = await deps.connector.download({
      url: URL_UNDER_TEST,
      expectedResourceType: 'image',
    });

    expect(result.sizeBytes).toBe(CONTENT.length);
    const hosts = (deps.safeUrl.resolvePublicHost as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0],
    );
    expect(hosts).toEqual(['cdn.example.com', 'mirror.example.com']);
    expect(mockFetch.mock.calls[1][0]).toBe('https://mirror.example.com/photo.jpg');
  });

  it('refuses redirect targets on unsupported protocols', async () => {
    const deps = createDeps();
    mockFetch.mockResolvedValue(
      response({ status: 302, location: 'file:///etc/passwd', body: Buffer.alloc(0) }),
    );

    await expect(
      deps.connector.download({ url: URL_UNDER_TEST, expectedResourceType: 'image' }),
    ).rejects.toThrow(/Unsupported protocol in download URL: file:/);
  });

  it('invokes the checkpoint hook so callers can cancel or refresh leases', async () => {
    const deps = createDeps();
    mockFetch.mockResolvedValue(response({ contentType: 'image/jpeg' }));
    const onCheckpoint = vi.fn().mockResolvedValue(undefined);

    await deps.connector.download({
      url: URL_UNDER_TEST,
      expectedResourceType: 'image',
      onCheckpoint,
    });

    expect(onCheckpoint.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('propagates cancellation errors from the checkpoint hook', async () => {
    const deps = createDeps();
    mockFetch.mockResolvedValue(response({ contentType: 'image/jpeg' }));
    class Canceled extends Error {}
    const onCheckpoint = vi.fn().mockRejectedValue(new Canceled('canceled'));

    await expect(
      deps.connector.download({ url: URL_UNDER_TEST, expectedResourceType: 'image', onCheckpoint }),
    ).rejects.toThrow('canceled');
    expect(deps.dispatcher.close).toHaveBeenCalled();
  });
});
