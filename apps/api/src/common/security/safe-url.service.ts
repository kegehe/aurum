import { BadRequestException, Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import * as ipaddr from 'ipaddr.js';
import { Agent, fetch } from 'undici';

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
    const dispatcher = this.createSafeDispatcher();

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
            'user-agent': 'resource-service-link-importer/0.1',
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

  protected async resolvePublicHost(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some(({ address }) => !this.isPublicAddress(address))) {
      throw new BadRequestException('URL resolves to a blocked network address');
    }
    const selected = addresses[0];
    return { address: selected.address, family: selected.family as 4 | 6 };
  }

  /**
   * 创建一个 DNS-pinned undici Agent，确保所有连接解析到公网地址。
   * 调用方负责在使用后调用 dispatcher.close()。
   */
  createSafeDispatcher(options?: { headersTimeout?: number; bodyTimeout?: number }): Agent {
    return new Agent({
      connect: {
        lookup: (hostname, _options, callback) => {
          void this.resolvePublicHost(hostname)
            .then(({ address, family }) => callback(null, address, family))
            .catch((error: unknown) => {
              callback(error instanceof Error ? error : new Error(String(error)), '', 4);
            });
        },
      },
      headersTimeout: options?.headersTimeout ?? 10_000,
      bodyTimeout: options?.bodyTimeout ?? 15_000,
      maxRedirections: 0,
    });
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
