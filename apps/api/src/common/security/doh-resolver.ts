import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

export type DnsResolutionMode = 'auto' | 'doh' | 'system';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

interface DohAnswer {
  type: number;
  TTL?: number;
  data: string;
}

interface DohResponse {
  Status: number;
  Answer?: DohAnswer[];
}

interface CacheEntry {
  expiresAt: number;
  addresses: ResolvedAddress[];
}

const DEFAULT_DOH_URL = 'https://cloudflare-dns.com/dns-query';
const DEFAULT_TIMEOUT_MS = 3_000;
const MIN_TTL_MS = 30_000;
const MAX_TTL_MS = 5 * 60_000;
const DEFAULT_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 512;
const FAILURE_THRESHOLD = 3;
const FAILURE_COOLDOWN_MS = 5 * 60_000;

function readMode(): DnsResolutionMode {
  if (process.env.NODE_ENV === 'test') return 'system';
  const raw = (process.env.SAFE_URL_DNS_MODE ?? 'auto').trim().toLowerCase();
  return raw === 'doh' || raw === 'system' ? raw : 'auto';
}

function readTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.SAFE_URL_DOH_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/**
 * 出站 DNS 解析：优先用 DoH 拿到未受本地网络污染的地址。
 *
 * 本机配置了代理时，实际连接由代理远端解析，但 SSRF 校验仍需要一份可信的解析结果；
 * 本地 DNS 被污染会把公网域名解析成保留地址或假地址，导致校验误杀或连接失败。
 * DoH 查询同时经过同一个代理，因此「校验看到的地址」与「代理实际连接的域名」一致。
 *
 * 失败时会连续计数并在冷却期内回退系统 DNS，避免 DoH 不可用时拖慢每次请求。
 */
export class DohResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly mode: DnsResolutionMode;
  private readonly dohUrl: string;
  private readonly timeoutMs: number;
  private readonly proxyUrl?: string;
  private readonly fetchImpl: typeof undiciFetch;
  private consecutiveFailures = 0;
  private cooldownUntil = 0;

  constructor(
    options: {
      mode?: DnsResolutionMode;
      dohUrl?: string;
      timeoutMs?: number;
      proxyUrl?: string;
      fetchImpl?: typeof undiciFetch;
    } = {},
  ) {
    this.mode = options.mode ?? readMode();
    this.dohUrl = options.dohUrl ?? process.env.SAFE_URL_DOH_URL ?? DEFAULT_DOH_URL;
    this.timeoutMs = options.timeoutMs ?? readTimeoutMs();
    this.proxyUrl = options.proxyUrl;
    this.fetchImpl = options.fetchImpl ?? undiciFetch;
  }

  async resolve(hostname: string): Promise<ResolvedAddress[]> {
    const literal = isIP(hostname);
    if (literal !== 0) {
      return [{ address: hostname, family: literal === 6 ? 6 : 4 }];
    }

    const key = hostname.toLowerCase();
    const cached = this.cache.get(key);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        // 命中即刷新 LRU 顺序
        this.cache.delete(key);
        this.cache.set(key, cached);
        return cached.addresses;
      }
      this.cache.delete(key);
    }

    if (this.shouldUseDoh()) {
      try {
        const { addresses, ttlMs } = await this.resolveWithDoh(hostname);
        if (addresses.length > 0) {
          this.remember(key, addresses, ttlMs);
          this.consecutiveFailures = 0;
          return addresses;
        }
      } catch {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= FAILURE_THRESHOLD) {
          this.cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
          this.consecutiveFailures = 0;
        }
      }
    }

    return this.resolveWithSystem(hostname);
  }

  clearCache(): void {
    this.cache.clear();
  }

  private shouldUseDoh(): boolean {
    if (this.mode === 'system') return false;
    if (Date.now() < this.cooldownUntil) return false;
    // auto：只有配置了代理时才默认启用；直连环境系统 DNS 通常可用
    return this.mode === 'doh' || Boolean(this.proxyUrl);
  }

  private async resolveWithDoh(
    hostname: string,
  ): Promise<{ addresses: ResolvedAddress[]; ttlMs: number }> {
    const dispatcher = this.proxyUrl
      ? new ProxyAgent({
          uri: this.proxyUrl,
          headersTimeout: this.timeoutMs,
          bodyTimeout: this.timeoutMs,
        })
      : undefined;

    try {
      const results = await Promise.allSettled([
        this.queryDoh(hostname, 'A', dispatcher),
        this.queryDoh(hostname, 'AAAA', dispatcher),
      ]);
      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<{ answers: DohAnswer[] }> =>
          result.status === 'fulfilled',
      );
      if (fulfilled.length === 0) {
        throw (results[0] as PromiseRejectedResult).reason;
      }

      const seen = new Set<string>();
      const addresses: ResolvedAddress[] = [];
      let ttlMs = MAX_TTL_MS;
      for (const { answers } of fulfilled.map((result) => result.value)) {
        for (const answer of answers) {
          const family = answer.type === 28 ? 6 : 4;
          const key = `${family}:${answer.data}`;
          if (seen.has(key) || isIP(answer.data) === 0) continue;
          seen.add(key);
          addresses.push({ address: answer.data, family });
          if (answer.TTL) {
            ttlMs = Math.min(ttlMs, answer.TTL * 1000);
          }
        }
      }

      return {
        addresses: addresses.sort((a, b) => (a.family === 4 ? -1 : b.family === 4 ? 1 : 0)),
        ttlMs: addresses.length > 0 ? ttlMs : DEFAULT_TTL_MS,
      };
    } finally {
      await dispatcher?.close().catch(() => undefined);
    }
  }

  private async queryDoh(
    hostname: string,
    type: 'A' | 'AAAA',
    dispatcher: ProxyAgent | undefined,
  ): Promise<{ answers: DohAnswer[] }> {
    const url = new URL(this.dohUrl);
    url.searchParams.set('name', hostname);
    url.searchParams.set('type', type);

    const response = await this.fetchImpl(url, {
      dispatcher,
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { accept: 'application/dns-json' },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`DoH HTTP ${response.status}`);
    }
    const payload = (await response.json()) as DohResponse;
    if (payload.Status === 3) return { answers: [] };
    if (payload.Status !== 0) throw new Error(`DoH status ${payload.Status}`);
    return { answers: payload.Answer ?? [] };
  }

  private async resolveWithSystem(hostname: string): Promise<ResolvedAddress[]> {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses
      .map(({ address, family }) => ({ address, family: family as 4 | 6 }))
      .sort((a, b) => (a.family === 4 ? -1 : b.family === 4 ? 1 : 0));
  }

  private remember(key: string, addresses: ResolvedAddress[], ttlMs: number): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, {
      expiresAt: Date.now() + Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, ttlMs)),
      addresses,
    });
  }
}
