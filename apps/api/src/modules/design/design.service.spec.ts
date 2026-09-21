import { describe, expect, it, vi } from 'vitest';
import { DesignService } from './design.service';

describe('DesignService fixture resolution', () => {
  it('flattens nested style-pack dependencies into renderable leaf documents', async () => {
    const nestedPack = {
      schemaVersion: 'aurum.style-pack.v1',
      dependencies: [{ documentId: 'theme-document', versionId: 'theme-v1' }],
    };
    const versions = new Map([
      [
        'pack-v1',
        { id: 'pack-v1', documentId: 'pack-document', content: JSON.stringify(nestedPack) },
      ],
      [
        'theme-v1',
        {
          id: 'theme-v1',
          documentId: 'theme-document',
          content: JSON.stringify({
            tokenSchemaVersion: 'aurum.tokens.v1',
            tokens: { color: { primary: { $type: 'color', $value: '#1769aa' } } },
          }),
        },
      ],
    ]);
    const prisma = {
      designVersion: {
        findMany: vi.fn().mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
          Promise.resolve(
            where.id.in.map((id) => versions.get(id)).filter(Boolean),
          ),
        ),
      },
    };
    const service = new DesignService(prisma as never, {} as never, {} as never);
    const root = {
      schemaVersion: 'aurum.style-pack.v1',
      dependencies: [{ documentId: 'pack-document', versionId: 'pack-v1' }],
    };

    const resolved = await (service as never as {
      resolveFixtureContent(value: typeof root): Promise<Record<string, unknown>>;
    }).resolveFixtureContent(root);

    expect(resolved.__aurumFixtureDependencies).toEqual([
      expect.objectContaining({ documentId: 'theme-document', versionId: 'theme-v1' }),
    ]);
  });

  it('rejects cyclic nested style-pack version references', async () => {
    const versions = new Map([
      [
        'pack-a',
        {
          id: 'pack-a',
          documentId: 'pack-a-document',
          content: JSON.stringify({
            schemaVersion: 'aurum.style-pack.v1',
            dependencies: [{ documentId: 'pack-b-document', versionId: 'pack-b' }],
          }),
        },
      ],
      [
        'pack-b',
        {
          id: 'pack-b',
          documentId: 'pack-b-document',
          content: JSON.stringify({
            schemaVersion: 'aurum.style-pack.v1',
            dependencies: [{ documentId: 'pack-a-document', versionId: 'pack-a' }],
          }),
        },
      ],
    ]);
    const prisma = {
      designVersion: {
        findMany: vi.fn().mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
          Promise.resolve(
            where.id.in.map((id) => versions.get(id)).filter(Boolean),
          ),
        ),
      },
    };
    const service = new DesignService(prisma as never, {} as never, {} as never);

    await expect(
      (service as never as {
        resolveFixtureContent(value: Record<string, unknown>): Promise<Record<string, unknown>>;
      }).resolveFixtureContent({
        schemaVersion: 'aurum.style-pack.v1',
        dependencies: [{ documentId: 'pack-a-document', versionId: 'pack-a' }],
      }),
    ).rejects.toThrow('circular version reference');
  });
});
