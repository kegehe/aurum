import { describe, expect, it } from 'vitest';
import { collectTokenTable } from './design-css';
import { RECIPES } from './design-recipes';
import { attachPinnedDependencies, extractDesignPalette } from './design-palette';
import type { JsonRecord } from './design.types';

const indigo = RECIPES.find((recipe) => recipe.id === 'palette-indigo');
const gradient = RECIPES.find((recipe) => recipe.id === 'button-gradient');

describe('extractDesignPalette', () => {
  it('按主题文档里的颜色 token 取色，不把阴影色算进色板', () => {
    expect(indigo).toBeTruthy();
    const palette = extractDesignPalette(indigo!.sample(new Map()));
    expect(palette.colors).toEqual([
      '#1f6feb',
      '#1450b3',
      '#ffffff',
      '#f7f9fc',
      '#d8e0ea',
      '#0f172a',
      '#5b6b7f',
    ]);
    expect(palette.colors).not.toContain('rgba(15, 23, 42, 0.22)');
    expect(palette.tokens).toContain('color.primary');
    expect(palette.tokens).toContain('color.surface');
  });

  it('把同一份文档里的颜色别名解析成字面量', () => {
    const palette = extractDesignPalette({
      tokens: {
        color: {
          primary: { $type: 'color', $value: '#112233' },
          action: { $type: 'color', $value: '{color.primary}' },
        },
      },
    });
    expect(palette.colors).toEqual(['#112233']);
    expect(palette.tokens).toEqual(['color.primary', 'color.action']);
  });

  it('组件声明里的别名会解析到钉住的主题，而不是倒出整套主题', () => {
    expect(indigo && gradient).toBeTruthy();
    const theme = indigo!.sample(new Map());
    const button = gradient!.sample(collectTokenTable([theme]));
    const pinned = {
      ...button,
      dependencies: [{ documentId: 'theme-doc', versionId: 'theme-v1' }],
    };
    const palette = extractDesignPalette(
      attachPinnedDependencies(pinned, new Map([['theme-v1', theme]])),
    );

    expect(palette.colors).toEqual([
      '#1f6feb',
      '#1450b3',
      '#ffffff',
      'rgba(20, 80, 179, 0.30)',
      'rgba(20, 80, 179, 0.38)',
    ]);
    expect(palette.colors).not.toContain('#f7f9fc');
  });

  it('依赖版本缺失时仍保留声明里的字面色', () => {
    const palette = extractDesignPalette(
      attachPinnedDependencies(
        {
          dependencies: [{ documentId: 'missing', versionId: 'missing' }],
          variants: {
            default: {
              declarations: {
                color: '{color.primary}',
                'background-color': 'rgba(1, 2, 3, 0.5)',
              },
            },
          },
        },
        new Map(),
      ),
    );
    expect(palette.colors).toEqual(['rgba(1, 2, 3, 0.5)']);
    expect(palette.tokens).toEqual([]);
  });

  it('资产包不扫描声明文本', () => {
    const palette = extractDesignPalette(
      { description: '按钮用 #1f6feb', variants: { default: { declarations: { color: '#112233' } } } },
      { scanReferences: false },
    );
    expect(palette.colors).toEqual([]);
  });

  it('短十六进制会展开，透明色不进色板', () => {
    const palette = extractDesignPalette({
      variants: {
        default: {
          declarations: { color: '#abc', background: 'transparent', border: '#aabbcc' },
        },
      },
    });
    expect(palette.colors).toEqual(['#aabbcc']);
  });

  it('别名环不会把依赖展开死循环', () => {
    const self: JsonRecord = {
      dependencies: [{ documentId: 'doc', versionId: 'self' }],
      tokens: { color: { primary: { $type: 'color', $value: '#112233' } } },
    };
    const resolved = attachPinnedDependencies(self, new Map([['self', self]]));
    expect(extractDesignPalette(resolved).colors).toEqual(['#112233']);
  });
});
