import { describe, expect, it } from 'vitest';
import {
  buildMediaSkeleton,
  getMediaDescriptor,
  isSafeDataUri,
  safeMediaAlt,
  validateMediaDescriptor,
} from './design-media';
import type { JsonRecord } from './design.types';

const RESOURCE_ID = '0e0c21c4-44f1-4e53-8daa-ff796d722049';

function content(overrides: Partial<JsonRecord> = {}): JsonRecord {
  return {
    schemaVersion: 'aurum.component.v2',
    componentType: 'media-showcase',
    appliesTo: 'container',
    media: {
      resourceId: RESOURCE_ID,
      kind: 'image',
      alt: '示例图片',
      width: 800,
      height: 600,
    },
    variants: { default: { declarations: {} } },
    ...overrides,
  };
}

const imageMedia = {
  dataUri: 'data:image/png;base64,AAAA',
  mimeType: 'image/png',
  kind: 'image' as const,
};

describe('validateMediaDescriptor', () => {
  it('fills safe defaults and keeps dimensions', () => {
    expect(validateMediaDescriptor((content().media as JsonRecord))).toEqual({
      resourceId: RESOURCE_ID,
      kind: 'image',
      alt: '示例图片',
      width: 800,
      height: 600,
      fit: 'cover',
      position: 'center',
    });
  });

  it('rejects unknown fields so clients cannot smuggle URLs or data URIs', () => {
    expect(() =>
      validateMediaDescriptor({
        resourceId: RESOURCE_ID,
        kind: 'image',
        alt: 'x',
        url: 'https://example.com/a.png',
      }),
    ).toThrow('不支持字段');
  });

  it('rejects non-uuid ids and unsupported fits', () => {
    expect(() =>
      validateMediaDescriptor({ resourceId: 'not-a-uuid', kind: 'image', alt: 'x' }),
    ).toThrow('UUID');
    expect(() =>
      validateMediaDescriptor({
        resourceId: RESOURCE_ID,
        kind: 'image',
        alt: 'x',
        fit: 'stretch',
      }),
    ).toThrow('fit');
  });

  it('returns null when content has no media', () => {
    expect(getMediaDescriptor({ variants: {} })).toBeNull();
  });
});

describe('safeMediaAlt', () => {
  it('removes characters that would trip the design content scanner', () => {
    const value = safeMediaAlt('A < B; {url(https://x)} @import javascript:alert(1)');
    expect(value).not.toMatch(/[;{}<>]/);
    expect(value.toLowerCase()).not.toContain('url(');
    expect(value.toLowerCase()).not.toContain('@import');
    expect(value.toLowerCase()).not.toContain('javascript:');
  });

  it('falls back to 素材 when the title is empty', () => {
    expect(safeMediaAlt('  ')).toBe('素材');
  });

  it('truncates by code points so emoji are not split', () => {
    const value = safeMediaAlt('😀'.repeat(400));
    expect(Array.from(value)).toHaveLength(300);
    expect(value).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

describe('buildMediaSkeleton', () => {
  it('renders a cover image with alt text and escaped attributes', () => {
    const html = buildMediaSkeleton(
      content({
        media: {
          resourceId: RESOURCE_ID,
          kind: 'image',
          alt: 'A "quoted" title',
        },
      }),
      'aurum-media-default',
      imageMedia,
    );
    expect(html).toContain('<figure');
    expect(html).toContain('data-media-kind="image"');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('alt="A &quot;quoted&quot; title"');
    expect(html).toContain('object-fit:cover');
  });

  it('renders a video badge and duration for video media', () => {
    const html = buildMediaSkeleton(
      content({
        media: {
          resourceId: RESOURCE_ID,
          kind: 'video',
          alt: '演示视频',
          durationSeconds: 125,
        },
      }),
      'aurum-media-default',
      { ...imageMedia, kind: 'video' },
    );
    expect(html).toContain('data-media-kind="video"');
    expect(html).toContain('▶');
    expect(html).toContain('2:05');
    expect(html).not.toContain('<video');
  });

  it('renders a placeholder instead of throwing when media cannot be resolved', () => {
    const html = buildMediaSkeleton(content(), 'aurum-media-default', null);
    expect(html).toContain('素材不可用');
    expect(html).not.toContain('<img');
  });
});

describe('isSafeDataUri', () => {
  it('accepts browser-renderable image data URIs', () => {
    expect(isSafeDataUri('data:image/png;base64,AAAA')).toBe(true);
    expect(isSafeDataUri('data:image/webp;base64,AAAA')).toBe(true);
  });

  it('rejects html/svg data URIs and non-base64 payloads', () => {
    expect(isSafeDataUri('data:text/html;base64,AAAA')).toBe(false);
    expect(isSafeDataUri('data:image/svg+xml;base64,AAAA')).toBe(false);
    expect(isSafeDataUri('data:image/png;base64,<script>')).toBe(false);
  });
});
