import { Injectable } from '@nestjs/common';
import { fetch } from 'undici';
import { SafeUrlService } from '../../../common/security/safe-url.service';

const CHECK_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const MAX_SQLITE_BIGINT = 9_223_372_036_854_775_807n;

export interface LocatorCheckResult {
  httpStatus: number;
  contentType: string | null;
  contentLength: bigint | null;
  etag: string | null;
  lastModified: Date | null;
  error: string | null;
}

export interface LocatorCheckOptions {
  validateUrl?: (candidate: string) => Promise<void>;
}

/**
 * 链接健康检查器
 *
 * 使用 HEAD 请求探测 URL 可用性，获取 HTTP 状态、内容类型、ETag 等信息。
 * 当服务器不支持 HEAD（返回 405）时，fallback 到 GET + Range: bytes=0-0。
 * 所有请求经过 SafeUrlService 的 SSRF 防护和 DNS pinning。
 *
 * 重定向计数器在 HEAD→GET fallback 之间累积，确保总重定向不超过 MAX_REDIRECTS。
 * 超时信号覆盖整个检查流程（HEAD + GET fallback），而非单个请求。
 */
@Injectable()
export class LocatorHealthChecker {
  constructor(private readonly safeUrl: SafeUrlService) {}

  async check(rawUrl: string, options: LocatorCheckOptions = {}): Promise<LocatorCheckResult> {
    try {
      let current = this.safeUrl.normalize(rawUrl);
      const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
      const dispatcher = this.safeUrl.createSafeDispatcher(
        { headersTimeout: 10_000, bodyTimeout: 10_000 },
        current.hostname,
      );

      try {
        let redirectsUsed = 0;
        for (let step = 0; step <= MAX_REDIRECTS; step++) {
          await options.validateUrl?.(current.toString());
          // SSRF 校验：代理模式下 dispatcher 不做 DNS-pinning，这里显式校验目标主机为公网地址
          await this.safeUrl.resolvePublicHost(current.hostname);

          // 先尝试 HEAD
          const headResponse = await fetch(current, {
            dispatcher,
            redirect: 'manual',
            signal,
            method: 'HEAD',
            headers: {
              'user-agent': 'aurum-health-checker/0.1',
            },
          });

          // 处理重定向
          if (headResponse.status >= 300 && headResponse.status < 400) {
            const location = headResponse.headers.get('location');
            await headResponse.body?.cancel();
            if (!location) {
              return makeErrorResult(headResponse.status, 'Redirect response has no location');
            }
            current = this.safeUrl.normalize(new URL(location, current).toString());
            redirectsUsed++;
            if (redirectsUsed > MAX_REDIRECTS) {
              return makeErrorResult(0, `Too many redirects (maximum ${MAX_REDIRECTS})`);
            }
            continue;
          }

          // HEAD 不被支持，fallback 到 GET + Range
          if (headResponse.status === 405) {
            await headResponse.body?.cancel();
            return await this.fallbackGetCheck(current, dispatcher, signal, options, redirectsUsed);
          }

          // 其他非 2xx — 仍然记录状态码
          if (!headResponse.ok) {
            await headResponse.body?.cancel();
            return {
              httpStatus: headResponse.status,
              contentType: headResponse.headers.get('content-type'),
              contentLength: parseContentLength(headResponse.headers.get('content-length')),
              etag: headResponse.headers.get('etag'),
              lastModified: parseLastModified(headResponse.headers.get('last-modified')),
              error: headResponse.status >= 400 ? `HTTP ${headResponse.status}` : null,
            };
          }

          // 成功的 HEAD 响应
          return {
            httpStatus: headResponse.status,
            contentType: headResponse.headers.get('content-type'),
            contentLength: parseContentLength(headResponse.headers.get('content-length')),
            etag: headResponse.headers.get('etag'),
            lastModified: parseLastModified(headResponse.headers.get('last-modified')),
            error: null,
          };
        }
        return makeErrorResult(0, `Too many redirects (maximum ${MAX_REDIRECTS})`);
      } finally {
        await dispatcher.close();
      }
    } catch (error) {
      return {
        httpStatus: 0,
        contentType: null,
        contentLength: null,
        etag: null,
        lastModified: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * GET + Range: bytes=0-0 fallback
   * 当服务器不支持 HEAD 时使用，只读取极少量数据以获取响应头
   * 支持重定向跟随（与 HEAD 循环一致）
   *
   * @param redirectsUsed HEAD 阶段已使用的重定向次数，GET 阶段继续累积
   */
  private async fallbackGetCheck(
    url: URL,
    dispatcher: ReturnType<SafeUrlService['createSafeDispatcher']>,
    signal: AbortSignal,
    options: LocatorCheckOptions = {},
    redirectsUsed = 0,
  ): Promise<LocatorCheckResult> {
    let current = url;
    for (let step = 0; step <= MAX_REDIRECTS; step++) {
      await options.validateUrl?.(current.toString());
      // SSRF 校验：代理模式下 dispatcher 不做 DNS-pinning，这里显式校验目标主机为公网地址
      await this.safeUrl.resolvePublicHost(current.hostname);
      const response = await fetch(current, {
        dispatcher,
        redirect: 'manual',
        signal,
        method: 'GET',
        headers: {
          'user-agent': 'aurum-health-checker/0.1',
          range: 'bytes=0-0',
        },
      });

      // 处理重定向
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) {
          return makeErrorResult(response.status, 'Redirect response has no location');
        }
        current = this.safeUrl.normalize(new URL(location, current).toString());
        redirectsUsed++;
        if (redirectsUsed > MAX_REDIRECTS) {
          return makeErrorResult(
            0,
            `Too many redirects in GET fallback (maximum ${MAX_REDIRECTS})`,
          );
        }
        continue;
      }

      await response.body?.cancel();

      const status = response.status === 206 ? 200 : response.status;
      return {
        httpStatus: status,
        contentType: response.headers.get('content-type'),
        contentLength: parseContentLength(response.headers.get('content-length')),
        etag: response.headers.get('etag'),
        lastModified: parseLastModified(response.headers.get('last-modified')),
        error: status >= 400 ? `HTTP ${status}` : null,
      };
    }
    return makeErrorResult(0, `Too many redirects in GET fallback (maximum ${MAX_REDIRECTS})`);
  }
}

function parseContentLength(value: string | null): bigint | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const n = BigInt(value);
  return n <= MAX_SQLITE_BIGINT ? n : null;
}

function parseLastModified(value: string | null): Date | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? null : new Date(ts);
}

function makeErrorResult(httpStatus: number, error: string): LocatorCheckResult {
  return {
    httpStatus,
    contentType: null,
    contentLength: null,
    etag: null,
    lastModified: null,
    error,
  };
}
