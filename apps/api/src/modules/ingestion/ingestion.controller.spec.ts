import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { IngestionController } from './ingestion.controller';

function createController() {
  const service = {
    mirrorRemoteResources: vi.fn(),
    mirrorRemoteResource: vi.fn(),
  };
  return { controller: new IngestionController(service as never), service };
}

describe('IngestionController 批量镜像路由', () => {
  it('delegates the selected ids to the ingestion service', async () => {
    const { controller, service } = createController();
    const result = { resourceIds: ['a'], queued: 1, skipped: 0, skippedResources: [] };
    service.mirrorRemoteResources.mockResolvedValue(result);

    await expect(controller.mirrorRemoteResources({ resourceIds: ['a'] } as never)).resolves.toBe(
      result,
    );
    expect(service.mirrorRemoteResources).toHaveBeenCalledWith(['a']);
  });

  it('registers resources/batch/mirror before resources/:id/mirror', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, IngestionController.prototype.mirrorRemoteResources),
    ).toBe('resources/batch/mirror');

    // Nest 按原型方法声明顺序注册路由；顺序反了 "batch" 会被当成资源 ID。
    const methodNames = Object.getOwnPropertyNames(IngestionController.prototype);
    expect(methodNames.indexOf('mirrorRemoteResources')).toBeLessThan(
      methodNames.indexOf('mirrorRemoteResource'),
    );
  });
});
