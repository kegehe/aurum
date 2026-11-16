import { describe, expect, it, vi } from 'vitest';
import { DesignAssetService } from './design-asset.service';

function makeService(overrides: Record<string, unknown> = {}) {
  const prisma = {
    designDocument: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    designVersion: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    designAssetFile: { createMany: vi.fn() },
    ...(overrides.prisma as Record<string, unknown> | undefined),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  const preview = { compile: vi.fn().mockResolvedValue({}) };
  const snapshots = {
    getCover: vi.fn().mockResolvedValue(null),
  };
  return {
    prisma,
    preview,
    snapshots,
    service: new DesignAssetService(
      prisma as never,
      preview as never,
      snapshots as never,
      {} as never,
      { enqueue: vi.fn(), enqueueForVersion: vi.fn() } as never,
    ),
  };
}

/** saveVersion 的最小资产：manifest 只要能让 validateFiles 通过即可 */
function makeSaveHarness(head: unknown) {
  const harness = makeService();
  const manifest = {
    preview: { entry: 'index.tsx' },
    files: [{ path: 'index.tsx', type: 'registry:ui', language: 'tsx' }],
  };
  const asset = {
    id: 'doc-1',
    format: 'package',
    manifest,
    status: 'published',
    version: { id: 'v1' },
  };
  vi.spyOn(harness.service, 'get').mockResolvedValue(asset as never);
  harness.prisma.designVersion.findFirst.mockResolvedValue({
    id: 'v1',
    versionNumber: 1,
    contentHash: 'hash-v1',
  });
  harness.prisma.designVersion.create.mockResolvedValue({ id: 'v2', versionNumber: 2 });
  harness.prisma.designDocument.findUnique.mockResolvedValue(head);
  harness.prisma.designDocument.updateMany.mockResolvedValue({ count: 1 });
  return harness;
}

describe('DesignAssetService', () => {
  it('rejects a create request without manifest or files', async () => {
    const { service } = makeService();
    await expect(
      service.create({ manifest: undefined as never, files: [] }),
    ).rejects.toThrow(/必须包含 manifest 和 files/);
  });

  it('diffs two versions by file path', async () => {
    const { prisma, service } = makeService();
    prisma.designDocument.findFirst.mockResolvedValue({ id: 'doc-1' });
    prisma.designVersion.findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        where.id === 'v2'
          ? {
              id: 'v2',
              versionNumber: 2,
              contentHash: 'hash-2',
              files: [
                { path: 'button.tsx', content: 'new' },
                { path: 'extra.css', content: 'body{}' },
              ],
            }
          : {
              id: 'v1',
              versionNumber: 1,
              contentHash: 'hash-1',
              files: [
                { path: 'button.tsx', content: 'old' },
                { path: 'removed.css', content: 'x' },
              ],
            },
      ),
    );

    const diff = await service.diffVersions('doc-1', 'v2', 'v1');
    expect(diff.summary).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(diff.files.find((file) => file.path === 'button.tsx')?.status).toBe('changed');
    expect(diff.files.find((file) => file.path === 'extra.css')?.status).toBe('added');
    expect(diff.files.find((file) => file.path === 'removed.css')?.status).toBe('removed');
  });

  it('基于过期的正式版本保存会被拒绝', async () => {
    const { service, prisma } = makeSaveHarness({
      currentPublishedVersionId: 'v2',
      versions: [{ id: 'v2' }],
    });

    await expect(
      service.saveVersion('doc-1', {
        files: [{ path: 'index.tsx', content: 'new' }],
        expectedBaseVersionId: 'v1',
      }),
    ).rejects.toThrow('正式版本已发生变化');
    expect(prisma.designDocument.updateMany).not.toHaveBeenCalled();
  });

  it('从未发布过的资产以最新版本作为 HEAD，保存不会被误判过期', async () => {
    const { service, prisma } = makeSaveHarness({
      currentPublishedVersionId: null,
      versions: [{ id: 'v1' }],
    });

    await service.saveVersion('doc-1', {
      files: [{ path: 'index.tsx', content: 'new' }],
      expectedBaseVersionId: 'v1',
    });

    expect(prisma.designDocument.updateMany).toHaveBeenCalledWith({
      where: { id: 'doc-1', currentPublishedVersionId: null },
      data: { currentPublishedVersionId: 'v2', status: 'published' },
    });
  });

  it('指针在检查后、认领前被并发改动时保存失败', async () => {
    const { service, prisma } = makeSaveHarness({
      currentPublishedVersionId: 'v1',
      versions: [{ id: 'v1' }],
    });
    prisma.designDocument.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.saveVersion('doc-1', {
        files: [{ path: 'index.tsx', content: 'new' }],
        expectedBaseVersionId: 'v1',
      }),
    ).rejects.toThrow('正式版本已发生变化');
  });
});
