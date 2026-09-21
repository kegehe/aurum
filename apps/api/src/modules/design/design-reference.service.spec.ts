import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DesignReferenceService } from './design-reference.service';

describe('DesignReferenceService', () => {
  const source = {
    id: '0e0c21c4-44f1-4e53-8daa-ff796d722049',
    slug: 'approved-example',
    enabled: true,
    baseUrl: 'https://example.com/inspiration',
    robotsUrl: null,
    allowedModes: 'metadata_only',
    rateLimitPerMinute: 30,
    requiresReview: false,
    termsUrl: null,
    config: null,
  };

  function createService(robots = 'User-agent: *\nAllow: /') {
    const repository = {
      findById: vi.fn().mockResolvedValue(source),
      findDesignReferenceTermsAcceptance: vi.fn(),
      createDesignReferenceTermsAcceptance: vi.fn(),
    };
    const safeUrl = {
      normalize: (url: string) => new URL(url),
      fetchText: vi
        .fn()
        .mockResolvedValue({ body: robots, url: new URL('https://example.com/robots.txt') }),
      fetchHtml: vi.fn().mockResolvedValue({
        body: '<title>Reference</title><meta name="description" content="Metadata only"><link rel="canonical" href="/inspiration/page">',
        url: new URL('https://example.com/inspiration/page'),
      }),
    };
    const design = { createReferenceDraft: vi.fn().mockResolvedValue({ draftId: 'draft-1' }) };
    const prisma = {
      $transaction: async (callback: (tx: unknown) => unknown) =>
        callback({
          designReferenceQuota: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            create: vi.fn().mockResolvedValue({}),
          },
        }),
      designReferenceQuota: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    return {
      service: new DesignReferenceService(repository as never, safeUrl as never, design as never, prisma as never),
      safeUrl,
      design,
    };
  }

  it('keeps only a metadata profile after robots and source policy pass', async () => {
    const { service, design } = createService();

    await expect(
      service.createUrlReferenceDraft(
        'document-1',
        'https://example.com/inspiration/page',
        source.id,
      ),
    ).resolves.toEqual({ draftId: 'draft-1' });
    expect(design.createReferenceDraft).toHaveBeenCalledWith(
      'document-1',
      expect.objectContaining({
        policy: 'inspiration_only',
        title: 'Reference',
        canonicalUrl: 'https://example.com/inspiration/page',
      }),
      'https://example.com/inspiration/page',
      expect.any(Date),
      false,
    );
  });

  it('rejects robots disallow rules before fetching page markup', async () => {
    const { service, safeUrl } = createService('User-agent: *\nDisallow: /inspiration');

    await expect(
      service.createUrlReferenceDraft(
        'document-1',
        'https://example.com/inspiration/page',
        source.id,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(safeUrl.fetchHtml).not.toHaveBeenCalled();
  });

  it('rejects a URL outside the approved source path', async () => {
    const { service, safeUrl } = createService();

    await expect(
      service.createUrlReferenceDraft('document-1', 'https://example.com/other', source.id),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(safeUrl.fetchText).not.toHaveBeenCalled();
  });

  it('requires explicit terms acceptance and puts reviewed sources into an approval state', async () => {
    const termsSource = {
      ...source,
      termsUrl: 'https://example.com/terms',
      requiresReview: true,
      config: JSON.stringify({
        designReferenceTermsAcceptedAt: '2026-08-20T00:00:00.000Z',
        designReferenceTermsAcceptedBy: 'operator-1',
      }),
    };
    const repository = {
      findById: vi.fn().mockResolvedValue(termsSource),
      findDesignReferenceTermsAcceptance: vi.fn().mockResolvedValue({ id: 'acceptance-1' }),
      createDesignReferenceTermsAcceptance: vi.fn(),
    };
    const safeUrl = {
      normalize: (url: string) => new URL(url),
      fetchText: vi.fn().mockResolvedValue({ body: 'User-agent: *\nAllow: /' }),
      fetchHtml: vi.fn().mockImplementation((url: string) =>
        Promise.resolve(
          url === 'https://example.com/terms'
            ? { body: '<main>Terms v1</main>', url: new URL(url) }
            : { body: '<title>Reference</title>', url: new URL('https://example.com/inspiration/page') },
        ),
      ),
    };
    const design = { createReferenceDraft: vi.fn().mockResolvedValue({ draftId: 'draft-1' }) };
    const prisma = {
      $transaction: async (callback: (tx: unknown) => unknown) =>
        callback({
          designReferenceQuota: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            create: vi.fn().mockResolvedValue({}),
          },
        }),
      designReferenceQuota: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = new DesignReferenceService(
      repository as never,
      safeUrl as never,
      design as never,
      prisma as never,
    );

    await service.createUrlReferenceDraft(
      'document-1',
      'https://example.com/inspiration/page',
      source.id,
    );
    expect(design.createReferenceDraft).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.any(String),
      expect.any(Date),
      true,
    );
  });

  it('hashes the current terms body and records every acceptance as an audit event', async () => {
    const termsSource = { ...source, termsUrl: 'https://example.com/terms' };
    const repository = {
      findById: vi.fn().mockResolvedValue(termsSource),
      findDesignReferenceTermsAcceptance: vi.fn(),
      createDesignReferenceTermsAcceptance: vi.fn().mockResolvedValue({ id: 'acceptance-1' }),
    };
    const safeUrl = {
      fetchHtml: vi.fn().mockResolvedValue({
        body: '<main>Terms v1</main>',
        url: new URL('https://example.com/legal/terms'),
      }),
    };
    const service = new DesignReferenceService(
      repository as never,
      safeUrl as never,
      {} as never,
      {} as never,
    );

    await service.acceptTerms(source.id, '2026-08', 'operator-1');

    expect(repository.createDesignReferenceTermsAcceptance).toHaveBeenCalledWith(
      expect.objectContaining({
        termsUrl: 'https://example.com/legal/terms',
        termsHash: expect.any(String),
        termsVersion: '2026-08',
      }),
    );
  });
});
