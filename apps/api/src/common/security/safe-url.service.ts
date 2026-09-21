import { BadRequestException, Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import * as ipaddr from 'ipaddr.js';
import { Agent, Dispatcher, ProxyAgent, fetch } from 'undici';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_REDIRECTS = 5;
const FETCH_TOTAL_TIMEOUT_MS = 20_000;

export interface SafeFetchResult {
  url: URL;
  status: number;
  headers: Headers;
  body: string;
}

export interface SafeFetchOptions {
  validateUrl?: (url: URL) => Promise<void>;
}

/** Validates outbound URLs and pins each connection to a public DNS result. */
@Injectable()
export class SafeUrlService {
  normalize(rawUrl: string): URL {
    let url: URL;
    try {
      url = new URL(rawUrl.trim());
    } catch {
      throw new BadRequestException('Invalid URL');
    }
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
      throw new BadRequestException('Only HTTP(S) URLs are allowed');
    }
    if (url.username || url.password) {
      throw new BadRequestException('URLs with embedded credentials are not allowed');
    }
    url.hash = '';
    return url;
  }

  async fetchHtml(
    rawUrl: string,
    options: SafeFetchOptions = {},
    maxBytes = 512 * 1024,
  ): Promise<SafeFetchResult> {
    let current = this.normalize(rawUrl);
    const signal = AbortSignal.timeout(FETCH_TOTAL_TIMEOUT_MS);
    const dispatcher = this.createSafeDispatcher(undefined, current.hostname);

    try {
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        await options.validateUrl?.(current);
        await this.resolvePublicHost(current.hostname);
        const response = await fetch(current, {
          dispatcher,
          redirect: 'manual',
          signal,
          headers: {
            accept: 'text/html,application/xhtml+xml',
            'user-agent': 'aurum-link-importer/0.1',
          },
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) throw new BadRequestException('Redirect response has no location');
          current = this.normalize(new URL(location, current).toString());
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new BadRequestException(`Remote server returned HTTP ${response.status}`);
        }
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.toLowerCase().includes('text/html')) {
          await response.body?.cancel();
          throw new BadRequestException('Remote URL did not return an HTML document');
        }
        return {
          url: current,
          status: response.status,
          headers: response.headers,
          body: await this.readLimitedBody(response.body, maxBytes),
        };
      }
      throw new BadRequestException(`Too many redirects (maximum ${MAX_REDIRECTS})`);
    } finally {
      await dispatcher.close();
    }
  }

  /** Fetch a small plain-text document through the same SSRF and redirect controls. */
  async fetchText(
    rawUrl: string,
    options: SafeFetchOptions = {},
    maxBytes = 128 * 1024,
  ): Promise<SafeFetchResult> {
    let current = this.normalize(rawUrl);
    const signal = AbortSignal.timeout(FETCH_TOTAL_TIMEOUT_MS);
    const dispatcher = this.createSafeDispatcher(undefined, current.hostname);

    try {
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        await options.validateUrl?.(current);
        await this.resolvePublicHost(current.hostname);
        const response = await fetch(current, {
          dispatcher,
          redirect: 'manual',
          signal,
          headers: { accept: 'text/plain,*/*;q=0.1', 'user-agent': 'aurum-design-reference/1.0' },
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) throw new BadRequestException('Redirect response has no location');
          current = this.normalize(new URL(location, current).toString());
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new BadRequestException(`Remote server returned HTTP ${response.status}`);
        }
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType && !/^text\/(plain|robots|x-robots-txt)(?:;|$)/i.test(contentType)) {
          await response.body?.cancel();
          throw new BadRequestException('Remote URL did not return a plain-text document');
        }
        return {
          url: current,
          status: response.status,
          headers: response.headers,
          body: await this.readLimitedBody(response.body, maxBytes),
        };
      }
      throw new BadRequestException(`Too many redirects (maximum ${MAX_REDIRECTS})`);
    } finally {
      await dispatcher.close();
    }
  }

  private async readLimitedBody(
    body: ReadableStream<Uint8Array> | null,
    maxBytes: number,
  ): Promise<string> {
    if (!body) return '';
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let fullyConsumed = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          throw new BadRequestException(`Remote HTML exceeds ${maxBytes} byte limit`);
        }
        chunks.push(value);
      }
      fullyConsumed = true;
    } finally {
      if (!fullyConsumed) {
        await reader.cancel().catch(() => undefined);
      }
      reader.releaseLock();
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(output);
  }

  /**
   * 解析主机并校验其解析结果均为公网地址（SSRF 防护）。
   * 返回全部公网地址（IPv4 优先），供连接层选择。
   * 走代理时连接由代理发出，此校验仍作为客户端侧防御，防止请求指向内网地址。
   */
  async resolvePublicHost(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some(({ address }) => !this.isPublicAddress(address))) {
      throw new BadRequestException('URL resolves to a blocked network address');
    }
    return (
      addresses
        .map((a) => ({ address: a.address, family: a.family as 4 | 6 }))
        // IPv4 优先：多数环境 IPv6 连通性不可靠，避免首选 IPv6 时连接超时
        .sort((a, b) => (a.family === 4 ? -1 : b.family === 4 ? 1 : 0))
    );
  }

  /**
   * 创建一个出站请求 dispatcher。
   *
   * - 配置了 HTTP(S)_PROXY 时使用 ProxyAgent 走代理（本机无外网直连环境必需，
   *   如 Clash/V2Ray 等本地代理）。NO_PROXY='*' 或目标主机命中 NO_PROXY 列表时走直连。
   *   注意：走代理时无法在连接层做 DNS-pinning，调用方应自行调用 resolvePublicHost
   *   完成 SSRF 校验（fetchHtml 已内置；其他 fetch 入口需显式调用）。
   * - 未配置代理时创建 DNS-pinned undici Agent，确保所有连接解析到公网地址。
   *
   * 调用方负责在使用后调用 dispatcher.close()。
   *
   * @param options 超时配置
   * @param targetHostname 目标主机名，用于按 NO_PROXY 列表决定是否绕过代理
   */
  createSafeDispatcher(
    options?: { headersTimeout?: number; bodyTimeout?: number },
    targetHostname?: string,
  ): Dispatcher {
    const proxyUrl = this.resolveProxyUrl(targetHostname);
    if (proxyUrl) {
      return new ProxyAgent({
        uri: proxyUrl,
        headersTimeout: options?.headersTimeout ?? 10_000,
        bodyTimeout: options?.bodyTimeout ?? 15_000,
      });
    }
    return new Agent({
      connect: {
        // Node 22 的 net.connect 以 all:true 调用自定义 lookup，
        // 回调须返回地址数组 [{ address, family }]；返回单个字符串会导致 ERR_INVALID_IP_ADDRESS。
        lookup: (hostname, _options, callback) => {
          void this.resolvePublicHost(hostname)
            .then((addresses) => {
              const family = addresses[0]?.family ?? 4;
              callback(null, addresses, family);
            })
            .catch((error: unknown) => {
              callback(error instanceof Error ? error : new Error(String(error)), [], 0);
            });
        },
      },
      headersTimeout: options?.headersTimeout ?? 10_000,
      bodyTimeout: options?.bodyTimeout ?? 15_000,
      maxRedirections: 0,
    });
  }

  /**
   * 从环境变量读取代理配置。
   * 优先级：HTTPS_PROXY > https_proxy > HTTP_PROXY > http_proxy。
   * 小写变体用于兼容常见容器/CI 约定。
   * NO_PROXY：'*' 完全禁用代理；逗号分隔的主机列表按精确/子域后缀匹配。
   */
  private resolveProxyUrl(targetHostname?: string): string | undefined {
    const noProxyRaw = process.env.NO_PROXY ?? process.env.no_proxy ?? '';
    const noProxyList = noProxyRaw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    if (noProxyList.length > 0) {
      if (noProxyList.includes('*')) return undefined;
      if (targetHostname) {
        const host = targetHostname.toLowerCase();
        const shouldBypass = noProxyList.some((entry) => {
          // 兼容 `.example.com` 前导点写法（等价于 example.com 及其子域）
          const name = entry.startsWith('.') ? entry.slice(1) : entry;
          if (!name) return false;
          return host === name || host.endsWith(`.${name}`);
        });
        if (shouldBypass) return undefined;
      }
    }

    return (
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      undefined
    );
  }

  private isPublicAddress(address: string): boolean {
    let parsed: ipaddr.IPv4 | ipaddr.IPv6;
    try {
      parsed = ipaddr.parse(address);
    } catch {
      return false;
    }
    if (parsed.kind() === 'ipv4') return parsed.range() === 'unicast';

    const bytes = parsed.toByteArray();
    const embeddedIpv4 =
      bytes.slice(0, 12).every((byte) => byte === 0) ||
      (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff);
    if (embeddedIpv4) {
      return this.isPublicAddress(bytes.slice(12).join('.'));
    }
    return parsed.range() === 'unicast';
  }
}
