import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { generateStorageKey } from '../storage/storage-key.util';
import { ControlledRendererService } from './controlled-renderer.service';
import type { JsonRecord } from './design.types';

/**
 * 存储替身委托给**真实的** generateStorageKey（零依赖纯函数）。
 *
 * 这里曾经用模板字符串伪造 key，于是渲染器传入的两个未注册 role
 * （'design-preview' / 'design-diff'）在真实驱动下抛 Unknown file role
 * 也照样绿灯，缺陷一路藏到运行时。别再改回伪造版本。
 */
function createStorage(writes?: Map<string, Buffer>) {
  return {
    generateKey: (role: string, hash: string, variant?: string, extension?: string) =>
      generateStorageKey(role, hash, variant, extension),
    put: async (key: string, value: Buffer) => {
      writes?.set(key, value);
      return key;
    },
  } as never;
}

const THEME: JsonRecord = {
  tokenSchemaVersion: 'aurum.tokens.v1',
  tokens: {
    color: {
      action: { primary: { $type: 'color', $value: '#1f6feb' } },
      text: { onPrimary: { $type: 'color', $value: '#ffffff' } },
    },
    space: { md: { $type: 'dimension', $value: '8px' } },
    radius: { md: { $type: 'dimension', $value: '6px' } },
    easing: { out: { $type: 'cubicBezier', $value: [0.2, 0, 0, 1] } },
    duration: { fast: { $type: 'duration', $value: '400ms' } },
  },
};

/** 组件 v2 内容，依赖以夹具注入的形式给出 */
function componentContent(
  declarations: JsonRecord,
  states: JsonRecord = {},
  componentType = 'glass-card',
): JsonRecord {
  return {
    schemaVersion: 'aurum.component.v2',
    componentType,
    appliesTo: 'container',
    dependencies: [
      {
        documentId: '0e0c21c4-44f1-4e53-8daa-ff796d722049',
        versionId: '1e0c21c4-44f1-4e53-8daa-ff796d722049',
      },
    ],
    variants: { default: { declarations, states } },
    __aurumFixtureDependencies: [
      {
        documentId: '0e0c21c4-44f1-4e53-8daa-ff796d722049',
        versionId: '1e0c21c4-44f1-4e53-8daa-ff796d722049',
        content: THEME,
      },
    ],
  };
}

function animationContent(transform: string): JsonRecord {
  return {
    schemaVersion: 'aurum.animation.v1',
    animationType: 'fade-slide-in',
    trigger: 'on-enter',
    dependencies: [
      {
        documentId: '0e0c21c4-44f1-4e53-8daa-ff796d722049',
        versionId: '2e0c21c4-44f1-4e53-8daa-ff796d722049',
      },
    ],
    keyframes: [
      { at: 'from', declarations: { opacity: 0, transform } },
      { at: 'to', declarations: { opacity: 1, transform: 'translateY(0)' } },
    ],
    timing: { duration: '{duration.fast}', easing: '{easing.out}', iterationCount: 1 },
    reducedMotion: { declarations: { opacity: 1, transform: 'translateY(0)' } },
    __aurumFixtureDependencies: [
      {
        documentId: '0e0c21c4-44f1-4e53-8daa-ff796d722049',
        versionId: '2e0c21c4-44f1-4e53-8daa-ff796d722049',
        content: THEME,
      },
    ],
  };
}

describe('ControlledRendererService', () => {
  it('renders deterministic PNG snapshots and visual diffs without external resources', async () => {
    const writes = new Map<string, Buffer>();
    const renderer = new ControlledRendererService(createStorage(writes));
    const base = {
      tokenSchemaVersion: 'aurum.tokens.v1',
      tokens: { color: { primary: { $type: 'color', $value: '#1769aa' } } },
    };
    const candidate = {
      tokenSchemaVersion: 'aurum.tokens.v1',
      tokens: { color: { primary: { $type: 'color', $value: '#b42318' } } },
    };

    const result = await renderer.render(
      { kind: 'theme', content: candidate, baseContent: base },
      'candidate-test',
    );

    expect(result.outputs).toHaveLength(3);
    expect(result.outputs.every((item) => item.changedPixels > 0)).toBe(true);
    expect(writes.size).toBe(6);
    expect([...writes.values()].every((image) => image.subarray(1, 4).toString() === 'PNG')).toBe(
      true,
    );
    // 锁住产物落在设计运营台自己的目录，而不是悄悄退化到别的 role
    expect([...writes.keys()].some((key) => key.startsWith('design-previews/'))).toBe(true);
    expect([...writes.keys()].some((key) => key.startsWith('design-diffs/'))).toBe(true);
    expect(result.browserVersion).toBeTruthy();
    expect(result.fixtureVersion).toBe('aurum.fixture.v2');
  }, 60_000);

  it('reports the browser version and font stack so previews stay reproducible', async () => {
    const renderer = new ControlledRendererService(createStorage());
    const result = await renderer.render(
      { kind: 'theme', content: THEME, baseContent: THEME },
      'meta-test',
    );
    expect(result.browserVersion).toMatch(/^\d+\./);
    expect(result.fontStack).toContain('Arial');
  }, 60_000);

  it('produces byte-identical renders for the same input', async () => {
    // 这是"预览可复现"的唯一真正断言。渲染同样输入两次必须得到同一个 artifactHash。
    const renderer = new ControlledRendererService(createStorage());
    const request = {
      kind: 'component' as const,
      content: componentContent({ 'background-color': '#1f6feb', 'border-radius': '{radius.md}' }),
      baseContent: componentContent({
        'background-color': '#1f6feb',
        'border-radius': '{radius.md}',
      }),
    };
    const first = await renderer.render(request, 'determinism-test');
    const second = await renderer.render(request, 'determinism-test');
    expect(second.outputs.map((o) => o.artifactHash)).toEqual(
      first.outputs.map((o) => o.artifactHash),
    );
  }, 120_000);

  it('renders component v2 declarations as real elements with every state', async () => {
    const renderer = new ControlledRendererService(createStorage());
    // 只为拿到产物，实际像素断言交给下面的 diff 用例
    const result = await renderer.render(
      {
        kind: 'component',
        content: componentContent(
          {
            'background-color': '{color.action.primary}',
            color: '{color.text.onPrimary}',
            'border-radius': '{radius.md}',
            padding: '{space.md}',
          },
          {
            hover: { 'background-color': '#1558c0' },
            'focus-visible': { outline: '2px solid #1f6feb' },
            disabled: { opacity: 0.5 },
          },
        ),
        baseContent: componentContent({ 'background-color': '#cccccc' }),
      },
      'component-v2-test',
    );
    expect(result.outputs.every((item) => item.changedPixels > 0)).toBe(true);
  }, 60_000);

  it('renders embedded media data URIs even with all network requests aborted', async () => {
    const writes = new Map<string, Buffer>();
    const renderer = new ControlledRendererService(createStorage(writes));
    const redPng = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 220, g: 20, b: 20 } },
    })
      .png()
      .toBuffer();
    const mediaContent = {
      ...componentContent({ 'aspect-ratio': 1.333, 'max-width': '400px' }),
      media: {
        resourceId: '2e0c21c4-44f1-4e53-8daa-ff796d722049',
        kind: 'image',
        alt: '红色素材',
        width: 64,
        height: 48,
      },
    };

    await renderer.render(
      {
        kind: 'component',
        content: mediaContent,
        baseContent: mediaContent,
        media: {
          dataUri: `data:image/png;base64,${redPng.toString('base64')}`,
          mimeType: 'image/png',
          kind: 'image',
        },
        baseMedia: null,
      },
      'media-render-test',
    );

    const preview = [...writes.entries()].find(
      ([key]) => key.startsWith('design-previews/') && key.endsWith('-desktop.png'),
    );
    expect(preview).toBeDefined();
    const { data, info } = await sharp(preview![1])
      .raw()
      .toBuffer({ resolveWithObject: true });
    let sawRed = false;
    for (let index = 0; index + 2 < data.length; index += info.channels) {
      if (data[index] > 160 && data[index + 1] < 90 && data[index + 2] < 90) {
        sawRed = true;
        break;
      }
    }
    expect(sawRed).toBe(true);
  }, 60_000);

  it('renders an animation as a single side-by-side frame strip', async () => {
    const renderer = new ControlledRendererService(createStorage());
    const result = await renderer.render(
      {
        kind: 'animation',
        content: animationContent('translateY(24px)'),
        baseContent: animationContent('translateY(4px)'),
      },
      'animation-test',
    );
    expect(result.outputs).toHaveLength(3);
    // 一页一图：产物数量与非动画资产一致，前端栅格无需改动
    expect(result.outputs.every((item) => item.changedPixels > 0)).toBe(true);
  }, 120_000);

  it('emits a filmstrip whose frames are laid out side by side, not stacked', async () => {
    const writes = new Map<string, Buffer>();
    const renderer = new ControlledRendererService(createStorage(writes));
    await renderer.render(
      {
        kind: 'animation',
        content: animationContent('translateY(24px)'),
        baseContent: animationContent('translateY(24px)'),
      },
      'filmstrip-test',
    );
    const preview = [...writes.entries()].find(
      ([key]) => key.startsWith('design-previews/') && key.endsWith('-desktop.png'),
    );
    expect(preview).toBeDefined();
    const meta = await sharp(preview![1]).metadata();
    // 桌面视口 1440x960：6 帧并排必须仍在单屏宽度内（即没有被撑成多行或超宽）
    expect(meta.width).toBeLessThanOrEqual(1440);
    expect(meta.height).toBeLessThanOrEqual(960);
  }, 120_000);
});
