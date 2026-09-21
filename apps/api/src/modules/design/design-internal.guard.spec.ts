import { UnauthorizedException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesignInternalGuard, safeEqual } from './design-internal.guard';

function contextFor(path: string, key?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ originalUrl: path, headers: { 'x-aurum-design-internal-key': key } }),
    }),
  } as never;
}

describe('DesignInternalGuard', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('requires the internal service key for draft mutations in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DESIGN_INTERNAL_API_KEY', 'a-very-long-internal-key');
    const guard = new DesignInternalGuard();

    expect(() => guard.canActivate(contextFor('/api/design/documents'))).toThrow(
      UnauthorizedException,
    );
    expect(guard.canActivate(contextFor('/api/design/documents', 'a-very-long-internal-key'))).toBe(
      true,
    );
  });

  it('leaves externally keyed published routes to the read-key policy', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const guard = new DesignInternalGuard();

    expect(guard.canActivate(contextFor('/api/design/published/search'))).toBe(true);
    expect(guard.canActivate(contextFor('/api/design/mcp'))).toBe(true);
  });

  it('uses equal-length constant-time comparisons', () => {
    expect(safeEqual('same-key', 'same-key')).toBe(true);
    expect(safeEqual('same-key', 'other-key')).toBe(false);
    expect(safeEqual('short', 'longer')).toBe(false);
  });
});
