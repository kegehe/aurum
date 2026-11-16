import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable, Writable } from 'node:stream';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { ResourceController } from './resource.controller';

/** 只实现 preview() / pipeStream() 用到的 Response 能力 */
class FakeResponse extends Writable {
  headers = new Map<string, string>();
  statusCode = 200;
  jsonBody: unknown;
  body: Buffer[] = [];

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  }

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown) {
    this.jsonBody = payload;
    this.end();
    return this;
  }

  _write(chunk: Buffer, _encoding: string, callback: () => void) {
    this.body.push(Buffer.from(chunk));
    callback();
  }
}

function createController(mimeType: string, originalFilename: string, content = '<svg></svg>') {
  const payload = Buffer.from(content);
  const service = {
    getResizedPreview: vi.fn().mockResolvedValue(null),
    getOriginalFileInfo: vi.fn().mockResolvedValue({
      mimeType,
      originalFilename,
      sizeBytes: payload.byteLength,
    }),
    getOriginalFile: vi.fn().mockResolvedValue({
      stream: Readable.from([payload]),
      mimeType,
      originalFilename,
    }),
    getOriginalFileRange: vi.fn(),
    getThumbnailFile: vi.fn(),
    getDerivedFile: vi.fn().mockResolvedValue({
      stream: Readable.from([payload]),
      mimeType,
      originalFilename,
    }),
    createBatchDownload: vi.fn(),
  };
  return { controller: new ResourceController(service as never), service };
}

async function preview(
  mimeType: string,
  originalFilename: string,
  headers: Request['headers'] = {},
) {
  const { controller } = createController(mimeType, originalFilename);
  const res = new FakeResponse();
  // preview() 把流 pipe 给响应后即返回；这里只断言响应头，不依赖流是否读完
  await controller.preview('resource-1', undefined, { headers } as Request, res as never);
  return res;
}

describe('ResourceController.preview 不可信内容隔离', () => {
  it.each([
    ['image/svg+xml', 'logo.svg'],
    ['image/svg+xml; charset=utf-8', 'logo.svg'],
    ['image/svg', 'logo.svg'],
    ['application/xhtml+xml', 'page.xhtml'],
    ['text/html', 'page.html'],
    ['application/xml', 'data.xml'],
    ['IMAGE/SVG+XML', 'LOGO.SVG'],
  ])('%s（%s）降级为附件下载', async (mimeType, filename) => {
    const res = await preview(mimeType, filename);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
  });

  it('MIME 声称安全但扩展名是 svg 时仍然降级', async () => {
    const res = await preview('text/plain', 'logo.svg');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('扩展名大小写不敏感', async () => {
    const res = await preview('text/plain', 'logo.SVG');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('普通位图仍然内联预览', async () => {
    const res = await preview('image/png', 'photo.png');
    expect(res.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('SVG 的 Range 请求同样不内联', async () => {
    const { controller, service } = createController('image/svg+xml', 'logo.svg');
    service.getOriginalFileRange.mockReturnValue(Readable.from([Buffer.from('<sv')]));
    const res = new FakeResponse();
    await controller.preview(
      'resource-1',
      undefined,
      { headers: { range: 'bytes=0-2' } } as Request,
      res as never,
    );
    expect(res.statusCode).toBe(206);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
  });
});

describe('ResourceController 下载路由的沙箱兜底', () => {
  it('下载 SVG 原文件时附带 CSP 沙箱', async () => {
    const { controller } = createController('image/svg+xml', 'logo.svg');
    const res = new FakeResponse();
    await controller.download('resource-1', res as never);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
  });

  it('下载 HTML 快照时附带 CSP 沙箱', async () => {
    const { controller } = createController('text/html', 'page.snapshot');
    const res = new FakeResponse();
    await controller.downloadDerived('resource-1', 'snapshot', res as never);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
  });

  it('下载位图时不添加多余的 CSP', async () => {
    const { controller } = createController('image/png', 'photo.png');
    const res = new FakeResponse();
    await controller.download('resource-1', res as never);
    expect(res.headers.has('content-security-policy')).toBe(false);
  });
});

describe('ResourceController.preview 原文件缺失降级', () => {
  it('原文件记录缺失时输出缩略图而不是 404', async () => {
    const { controller, service } = createController('image/png', 'photo.png');
    service.getOriginalFileInfo.mockRejectedValue(
      new NotFoundException('Original file for resource resource-1 not found'),
    );
    service.getThumbnailFile.mockResolvedValue({
      stream: Readable.from([Buffer.from('thumb-bytes')]),
      mimeType: 'image/webp',
      etag: '"thumb-1"',
    });
    const res = new FakeResponse();

    await controller.preview('resource-1', undefined, { headers: {} } as Request, res as never);

    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('etag')).toBe('"thumb-1"');
    expect(service.getOriginalFile).not.toHaveBeenCalled();
  });
});

describe('ResourceController 批量下载', () => {
  it('回传成功与跳过的资源数量，供前端如实提示', async () => {
    const { controller, service } = createController('image/png', 'photo.png');
    service.createBatchDownload.mockResolvedValue({
      stream: Readable.from([Buffer.from('zip')]),
      filename: 'resources-2026-10-26.zip',
      foundResources: 2,
      missingResources: 1,
      missingResourceIds: ['remote'],
    });
    const res = new FakeResponse();

    await controller.batchDownload({ resourceIds: ['a', 'b', 'remote'] } as never, res as never);

    expect(res.headers.get('x-resource-found-count')).toBe('2');
    expect(res.headers.get('x-resource-missing-count')).toBe('1');
  });
});

type ThumbnailHttpResult = {
  statusCode: number;
  headers: IncomingMessage['headers'];
  body: Buffer;
  /** 响应正常收完（对端写完了结束块） */
  clean: boolean;
  /** 直到超时仍没有任何结束信号 */
  hung: boolean;
  error?: NodeJS.ErrnoException;
};

function httpGet(
  url: string,
  headers?: Record<string, string>,
  timeoutMs = 1500,
): Promise<ThumbnailHttpResult> {
  return new Promise((resolve) => {
    let statusCode = 0;
    let responseHeaders: IncomingMessage['headers'] = {};
    const chunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (partial: Pick<ThumbnailHttpResult, 'clean' | 'hung' | 'error'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        statusCode,
        headers: responseHeaders,
        body: Buffer.concat(chunks),
        ...partial,
      });
    };

    const req = httpRequest(url, { headers }, (res) => {
      statusCode = res.statusCode ?? 0;
      responseHeaders = res.headers;
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('aborted', () => {
        const error = new Error(
          timedOut ? 'request hung' : 'socket aborted',
        ) as NodeJS.ErrnoException;
        error.code = timedOut ? 'ETIMEOUT' : 'ECONNRESET';
        finish({ clean: false, hung: timedOut, error });
      });
      res.on('end', () => finish({ clean: !timedOut, hung: timedOut }));
      res.on('error', (error: NodeJS.ErrnoException) => {
        finish({ clean: false, hung: timedOut, error });
      });
    });
    req.on('error', (error: NodeJS.ErrnoException) => {
      finish({ clean: false, hung: timedOut || error.code === 'ETIMEOUT', error });
    });
    timer = setTimeout(() => {
      timedOut = true;
      const error = new Error('request hung') as NodeJS.ErrnoException;
      error.code = 'ETIMEOUT';
      req.destroy(error);
    }, timeoutMs);
    req.end();
  });
}

/** ServerResponse 没有 Express 的 status/json；缩略图 304 和读失败 500 会用到它们 */
function attachStatusHelpers(res: ServerResponse): ServerResponse {
  const response = res as ServerResponse & {
    status: (code: number) => ServerResponse;
    json: (payload: unknown) => ServerResponse;
  };
  response.status = (code: number) => {
    res.statusCode = code;
    return response;
  };
  response.json = (payload: unknown) => {
    const body = Buffer.from(JSON.stringify(payload));
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Length', String(body.length));
    }
    res.end(body);
    return response;
  };
  return response;
}

/** 把 thumbnail() 挂到真实 HTTP 连接上，等价于用 curl 看连接会不会结束 */
async function requestThumbnail(
  controller: ResourceController,
  headers?: Record<string, string>,
  timeoutMs = 1500,
): Promise<ThumbnailHttpResult> {
  const server = createServer((req, res) => {
    void controller.thumbnail(
      'resource-1',
      req as Request,
      attachStatusHelpers(res) as unknown as Response,
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  try {
    return await httpGet(
      `http://127.0.0.1:${address.port}/resources/resource-1/thumbnail`,
      headers,
      timeoutMs,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

/** 先吐出一段数据再读失败，复现「响应头已经发出、磁盘中途出错」 */
function streamThatErrorsAfterFirstChunk(): Readable {
  let pushed = false;
  const stream = new Readable({
    read() {
      if (pushed) return;
      pushed = true;
      this.push(Buffer.from('partial-webp'));
      // 等首块写进响应之后再失败，此时 headersSent 已经为 true
      const timer = setTimeout(() => {
        this.destroy(new Error('storage read failed'));
      }, 50);
      timer.unref();
    },
  });
  stream.on('error', () => {
    // 控制器负责关掉响应；这里避免未监听的 error 先把测试进程打崩
  });
  return stream;
}

describe('ResourceController.thumbnail', () => {
  it('正常缩略图返回 200 和图片字节', async () => {
    const { controller, service } = createController('image/webp', 'thumb.webp');
    service.getThumbnailFile.mockResolvedValue({
      stream: Readable.from([Buffer.from('full-webp')]),
      mimeType: 'image/webp',
      etag: '"thumb-1"',
    });

    const result = await requestThumbnail(controller);

    expect(result.statusCode).toBe(200);
    expect(result.clean).toBe(true);
    expect(result.hung).toBe(false);
    expect(result.headers['content-type']).toBe('image/webp');
    expect(result.headers.etag).toBe('"thumb-1"');
    expect(result.body.toString()).toBe('full-webp');
  });

  it('ETag 命中时返回 304 且不再读文件', async () => {
    const { controller, service } = createController('image/webp', 'thumb.webp');
    service.getThumbnailFile.mockImplementation(async (_id: string, ifNoneMatch?: string) => {
      if (ifNoneMatch === '"thumb-1"') return { notModified: true, etag: '"thumb-1"' };
      throw new Error('should not read the thumbnail file');
    });

    const result = await requestThumbnail(controller, { 'if-none-match': '"thumb-1"' });

    expect(result.statusCode).toBe(304);
    expect(result.clean).toBe(true);
    expect(result.hung).toBe(false);
    expect(result.headers.etag).toBe('"thumb-1"');
    expect(result.body.length).toBe(0);
  });

  it('传输出一段后读盘失败时服务端关闭连接，而不是挂到超时', async () => {
    const { controller, service } = createController('image/webp', 'thumb.webp');
    service.getThumbnailFile.mockResolvedValue({
      stream: streamThatErrorsAfterFirstChunk(),
      mimeType: 'image/webp',
      etag: '"thumb-1"',
    });

    const result = await requestThumbnail(controller, undefined, 1500);

    expect(result.hung).toBe(false);
    expect(result.clean).toBe(false);
    expect(result.statusCode).toBe(200);
    expect(result.error?.code).toBe('ECONNRESET');
  });
});
