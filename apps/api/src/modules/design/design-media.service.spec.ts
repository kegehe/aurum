import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DesignMediaService } from './design-media.service';
import type { MediaDescriptor } from './design-media';

const RESOURCE_ID = '0e0c21c4-44f1-4e53-8daa-ff796d722049';

const descriptor: MediaDescriptor = {
  resourceId: RESOURCE_ID,
  kind: 'image',
  alt: '示例图',
  width: 800,
  height: 600,
  fit: 'cover',
  position: 'center',
};

function createService() {
  const resources = {
    assertDesignMedia: vi.fn(),
    readDesignMedia: vi.fn(),
  };
  const service = new DesignMediaService(resources as never);
  return { service, resources };
}

function withMedia() {
  return {
    schemaVersion: 'aurum.component.v2',
    componentType: 'media-showcase',
    appliesTo: 'container',
    media: descriptor,
    variants: { default: { declarations: {} } },
  };
}

describe('DesignMediaService', () => {
  it('describe builds a safe descriptor from resource metadata', async () => {
    const { service, resources } = createService();
    resources.assertDesignMedia.mockResolvedValue({
      kind: 'video',
      title: 'A < B',
      width: 1920,
      height: 1080,
      durationSeconds: 12,
    });

    await expect(service.describe(RESOURCE_ID)).resolves.toEqual({
      resourceId: RESOURCE_ID,
      kind: 'video',
      alt: 'A B',
      width: 1920,
      height: 1080,
      durationSeconds: 12,
      fit: 'cover',
      position: 'center',
    });
  });

  it('resolves media to a data URI and caches repeated previews', async () => {
    const { service, resources } = createService();
    resources.readDesignMedia.mockResolvedValue({
      buffer: Buffer.from('image-bytes'),
      mimeType: 'image/png',
      kind: 'image',
      cacheKey: 'sha:1',
    });

    await expect(service.resolve(descriptor)).resolves.toMatchObject({
      dataUri: `data:image/png;base64,${Buffer.from('image-bytes').toString('base64')}`,
      kind: 'image',
    });
    await service.resolve(descriptor);
    expect(resources.readDesignMedia).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent resolutions for the same resource and edge', async () => {
    const { service, resources } = createService();
    let release: ((value: unknown) => void) | undefined;
    resources.readDesignMedia.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const first = service.resolve(descriptor);
    const second = service.resolve(descriptor);
    await Promise.resolve();
    expect(resources.readDesignMedia).toHaveBeenCalledTimes(1);
    release?.({
      buffer: Buffer.from('x'),
      mimeType: 'image/png',
      kind: 'image',
      cacheKey: 'sha:1',
    });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('returns null in tolerant mode and throws in strict mode when resolution fails', async () => {
    const { service, resources } = createService();
    resources.readDesignMedia.mockRejectedValue(new BadRequestException('素材不可用'));

    await expect(service.resolve(descriptor)).resolves.toBeNull();
    await expect(service.resolve(descriptor, { strict: true })).rejects.toThrow('素材不可用');
  });

  it('rejects when the resource type no longer matches the descriptor', async () => {
    const { service, resources } = createService();
    resources.readDesignMedia.mockResolvedValue({
      buffer: Buffer.from('x'),
      mimeType: 'image/png',
      kind: 'video',
      cacheKey: 'sha:1',
    });

    await expect(service.resolve(descriptor, { strict: true })).rejects.toThrow('素材类型');
  });

  it('assertAvailable checks the resource even if a data URI is cached', async () => {
    const { service, resources } = createService();
    resources.assertDesignMedia.mockResolvedValue({
      kind: 'image',
      title: 'x',
      width: 1,
      height: 1,
      durationSeconds: null,
    });

    await service.assertAvailable(withMedia());
    expect(resources.assertDesignMedia).toHaveBeenCalledWith(RESOURCE_ID);
  });

  it('resolveContent ignores content without media', async () => {
    const { service, resources } = createService();
    await expect(service.resolveContent({ variants: {} })).resolves.toBeNull();
    expect(resources.readDesignMedia).not.toHaveBeenCalled();
  });
});
