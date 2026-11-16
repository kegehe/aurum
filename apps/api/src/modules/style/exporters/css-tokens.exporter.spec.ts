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

describe('buildCssTokens 字体层级 token', () => {
  it('--font-* 必须是合法的 font 简写：带字体族，不能留 normal 占位', () => {
    const css = buildCssTokens(profile('无衬线', 'Inter'));
    expect(css).toContain('--font-body: 400 16px/1.6 var(--font-family);');
    // 旧写法 `400 16px/1.6 normal` 能通过解析，但 computed font-family 会变成字面量
    // "normal"（Chromium 实测），等于把字体重置成浏览器默认，而不是继承页面字体
    expect(css).not.toMatch(/--font-body: [^;]*\snormal;/);
  });

  it('letter-spacing 单独出 token，不塞进 font 简写', () => {
    const p = profile('无衬线');
    p.typography.hierarchy = [
      { role: 'display', sizePx: 96, weight: 800, letterSpacing: '-0.02em' },
      { role: 'body', sizePx: 16, weight: 400 },
    ];

    const css = buildCssTokens(p);

    expect(css).toContain('--font-display: 800 96px/1.6 var(--font-family);');
    expect(css).toContain('--font-display-letter-spacing: -0.02em;');
    // 塞进简写会让整条声明失效（CSS.supports('font', …) 实测 false）
    expect(css).not.toContain('96px/1.6 -0.02em');
    // 没有字距的层级不出多余 token
    expect(css).not.toContain('--font-body-letter-spacing');
  });

  it('中文 role 仍按 role-N 回退，字距 token 用同一个 id', () => {
    const p = profile('无衬线');
    p.typography.hierarchy = [
      { role: '大标题', sizePx: 56, weight: 700, letterSpacing: '-0.01em' },
    ];

    const css = buildCssTokens(p);

    expect(css).toContain('--font-level-0: 700 56px/1.6 var(--font-family);');
    expect(css).toContain('--font-level-0-letter-spacing: -0.01em;');
  });
});
