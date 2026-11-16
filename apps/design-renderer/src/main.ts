import 'reflect-metadata';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { PreviewCompileService, PreviewSnapshotService } from '@aurum/design-preview';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const PORT = Number(process.env.DESIGN_RENDERER_PORT || 3002);
const HOST = process.env.DESIGN_RENDERER_HOST || '127.0.0.1';
const KEY = process.env.DESIGN_RENDERER_KEY || '';

// 渲染接口会执行上传的代码并截图，暴露到非回环地址却没有密钥等于开放远程代码执行。
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
if (!KEY && !LOOPBACK_HOSTS.has(HOST)) {
  console.error(
    `[design-renderer] 拒绝启动：DESIGN_RENDERER_HOST=${HOST} 不是回环地址，必须同时设置 DESIGN_RENDERER_KEY`,
  );
  process.exit(1);
}

const compiler = new PreviewCompileService();
const snapshot = new PreviewSnapshotService();

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, { ok: true, service: 'design-renderer' });
    }
    if (KEY && req.headers['x-design-renderer-key'] !== KEY) {
      return sendJson(res, 401, { message: 'renderer authentication required' });
    }
    if (req.method === 'POST' && req.url === '/internal/compile') {
      const body = (await readJson(req)) as {
        manifest?: unknown;
        files?: unknown;
      };
      if (!body.manifest || !Array.isArray(body.files)) {
        return sendJson(res, 400, { message: 'manifest and files are required' });
      }
      const result = await compiler.compile({
        manifest: body.manifest as never,
        files: body.files as never,
      });
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && req.url === '/internal/screenshot') {
      const body = (await readJson(req)) as {
        html?: unknown;
        viewport?: string;
        state?: 'default' | 'hover';
      };
      if (typeof body.html !== 'string' || !body.html) {
        return sendJson(res, 400, { message: 'html is required' });
      }
      const png = await snapshot.capture(
        body.html,
        (body.viewport ?? 'desktop') as never,
        (body.state ?? 'default') as never,
      );
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store');
      res.end(png);
      return;
    }
    sendJson(res, 404, { message: 'Not found' });
  } catch (error) {
    const status =
      typeof (error as { getStatus?: () => number }).getStatus === 'function'
        ? (error as { getStatus: () => number }).getStatus()
        : 500;
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, status, { message: message.slice(0, 2_000) });
  }
});

server.on('error', (error) => {
  console.error(`[design-renderer] server error: ${error.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(
    `[design-renderer] listening on ${HOST}:${PORT}${KEY ? ' (auth enabled)' : ''}`,
  );
});

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体超过 8MB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
