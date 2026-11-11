import { describe, expect, it, vi } from 'vitest';
import { DohResolver } from './doh-resolver';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup } from 'node:dns/promises';

const lookupMock = vi.mocked(lookup);

function dohResponse(answer: Array<{ type: number; data: string; TTL?: number }>, status = 0) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ Status: status, Answer: answer }),
    body: { cancel: async () => undefined },
  };
}

function dohFetch(
  byType: Record<'A' | 'AAAA', Array<{ type: number; data: string; TTL?: number }>>,
) {
  return vi.fn(async (input: URL | string) => {
    const url = new URL(input.toString());
    const type = url.searchParams.get('type') as 'A' | 'AAAA';
    return dohResponse(byType[type] ?? []);
  }) as unknown as typeof fetch;
}

describe('DohResolver', () => {
  it('returns DoH addresses with IPv4 first and caches the result', async () => {
    const fetchImpl = dohFetch({
      A: [{ type: 1, data: '104.20.38.219', TTL: 120 }],
      AAAA: [{ type: 28, data: '2606:4700::6814:26db', TTL: 60 }],
    });
    const resolver = new DohResolver({ mode: 'doh', fetchImpl });

    const first = await resolver.resolve('image.civitai.com');
    expect(first).toEqual([
      { address: '104.20.38.219', family: 4 },
      { address: '2606:4700::6814:26db', family: 6 },
    ]);

    const second = await resolver.resolve('image.civitai.com');
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back to system DNS when DoH fails', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const fetchImpl = vi.fn(async () => {
      throw new Error('doh down');
    }) as unknown as typeof fetch;
    const resolver = new DohResolver({ mode: 'doh', fetchImpl });

    await expect(resolver.resolve('example.com')).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
    ]);
    expect(lookupMock).toHaveBeenCalledWith('example.com', { all: true, verbatim: true });
  });

  it('stops calling DoH during cooldown after repeated failures', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const fetchImpl = vi.fn(async () => {
      throw new Error('doh down');
    }) as unknown as typeof fetch;
    const resolver = new DohResolver({ mode: 'doh', fetchImpl });

    await resolver.resolve('a.example.com');
    await resolver.resolve('b.example.com');
    await resolver.resolve('c.example.com');
    expect(fetchImpl).toHaveBeenCalledTimes(6);

    await resolver.resolve('d.example.com');
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('skips DoH entirely in system mode', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const resolver = new DohResolver({ mode: 'system', fetchImpl });

    await resolver.resolve('example.com');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lookupMock).toHaveBeenCalled();
  });

  it('handles IP literals without any network resolution', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const resolver = new DohResolver({ mode: 'doh', fetchImpl });

    await expect(resolver.resolve('127.0.0.1')).resolves.toEqual([
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(resolver.resolve('::1')).resolves.toEqual([{ address: '::1', family: 6 }]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });
});
