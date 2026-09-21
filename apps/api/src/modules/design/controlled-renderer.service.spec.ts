import { describe, expect, it } from 'vitest';
import { ControlledRendererService } from './controlled-renderer.service';

describe('ControlledRendererService', () => {
  it('renders deterministic PNG snapshots and visual diffs without external resources', async () => {
    const writes = new Map<string, Buffer>();
    const storage = {
      generateKey: (role: string, hash: string, variant?: string, extension?: string) =>
        `${role}/${hash}-${variant}.${extension}`,
      put: async (key: string, value: Buffer) => {
        writes.set(key, value);
        return key;
      },
    } as never;
    const renderer = new ControlledRendererService(storage);
    const base = {
      tokenSchemaVersion: 'aurum.tokens.v1',
      tokens: { color: { primary: { $type: 'color', $value: '#1769aa' } } },
    };
    const candidate = {
      tokenSchemaVersion: 'aurum.tokens.v1',
      tokens: { color: { primary: { $type: 'color', $value: '#b42318' } } },
    };

    const snapshots = await renderer.render(candidate, base, 'candidate-test');

    expect(snapshots).toHaveLength(3);
    expect(snapshots.every((item) => item.changedPixels > 0)).toBe(true);
    expect(writes.size).toBe(6);
    expect([...writes.values()].every((image) => image.subarray(1, 4).toString() === 'PNG')).toBe(
      true,
    );
  }, 60_000);

  it('captures component contract changes instead of rendering an identical generic page', async () => {
    const storage = {
      generateKey: (role: string, hash: string, variant?: string, extension?: string) =>
        `${role}/${hash}-${variant}.${extension}`,
      put: async (key: string) => key,
    } as never;
    const renderer = new ControlledRendererService(storage);
    const base = {
      schemaVersion: 'aurum.component.v1',
      componentType: 'button',
      variants: { primary: { tone: 'brand', size: 'md' } },
    };
    const candidate = {
      schemaVersion: 'aurum.component.v1',
      componentType: 'button',
      variants: { primary: { tone: 'danger', size: 'lg' } },
    };

    const snapshots = await renderer.render(candidate, base, 'component-test');

    expect(snapshots.every((item) => item.changedPixels > 0)).toBe(true);
  }, 60_000);

  it('uses resolved dependency content when rendering a style pack', async () => {
    const storage = {
      generateKey: (role: string, hash: string, variant?: string, extension?: string) =>
        `${role}/${hash}-${variant}.${extension}`,
      put: async (key: string) => key,
    } as never;
    const renderer = new ControlledRendererService(storage);
    const dependency = {
      documentId: 'theme-document',
      versionId: 'theme-v1',
      content: {
        tokenSchemaVersion: 'aurum.tokens.v1',
        tokens: { color: { primary: { $type: 'color', $value: '#1769aa' } } },
      },
    };
    const base = {
      schemaVersion: 'aurum.style-pack.v1',
      dependencies: [{ documentId: 'theme-document', versionId: 'theme-v1' }],
      __aurumFixtureDependencies: [dependency],
    };
    const candidate = {
      ...base,
      __aurumFixtureDependencies: [
        {
          ...dependency,
          versionId: 'theme-v2',
          content: {
            ...dependency.content,
            tokens: { color: { primary: { $type: 'color', $value: '#b42318' } } },
          },
        },
      ],
    };

    const snapshots = await renderer.render(candidate, base, 'style-pack-test');

    expect(snapshots.every((item) => item.changedPixels > 0)).toBe(true);
  }, 60_000);
});
