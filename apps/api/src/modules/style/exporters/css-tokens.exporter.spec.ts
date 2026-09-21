/**
 * CSS Design Tokens 导出器单元测试
 *
 * 重点覆盖字体回退：familyTrait 为"无衬线"（含子串"衬线"）时不得误判为衬线。
 */
import { describe, expect, it } from 'vitest';
import { buildCssTokens } from './css-tokens.exporter';
import type { StyleProfile } from '../types';

function profile(familyTrait: string, suggestedFont?: string): StyleProfile {
  return {
    colorPalette: {
      primary: { hex: '#111111', role: '主色' },
      background: { hex: '#ffffff', role: '背景' },
      accent: { hex: '#333333', role: '强调色' },
      scale: ['#111111', '#ffffff'],
      mood: '',
    },
    typography: {
      familyTrait,
      suggestedFont,
      weights: [400],
      hierarchy: [{ role: 'body', sizePx: 16, weight: 400 }],
      lineHeight: 1.6,
    },
    spacing: { unit: 8, scale: [4, 8, 16], density: 'comfortable' },
    layout: { composition: '', regions: ['main'], grid: null, balance: '' },
    textureMood: {
      radius: '8px',
      shadow: 'none',
      gradient: null,
      density: 'comfortable',
      keywords: [],
    },
    styleGuideText: '',
  } as StyleProfile;
}

describe('buildCssTokens 字体回退', () => {
  it('无衬线 familyTrait 回退到无衬线字体栈', () => {
    const css = buildCssTokens(profile('现代无衬线', 'Inter'));
    expect(css).toContain('sans-serif');
    expect(css).not.toContain('Georgia');
    expect(css).toContain('"Inter"');
  });

  it('衬线 familyTrait 回退到衬线字体栈', () => {
    const css = buildCssTokens(profile('衬线 / 宋体气质'));
    expect(css).toContain('Georgia');
    expect(css).toContain('serif');
  });

  it('等宽 familyTrait 回退到等宽字体栈', () => {
    const css = buildCssTokens(profile('几何等宽'));
    expect(css).toContain('monospace');
  });

  it('缺省 familyTrait 使用无衬线默认栈', () => {
    const css = buildCssTokens(profile(''));
    expect(css).toContain('sans-serif');
  });
});
