import { describe, expect, it } from 'vitest';
import { evaluateContrast } from '../../common/color/contrast';
import {
  collectContrastPairs,
  collectTokenTable,
  resolveDeclarations,
  tokenValueToCss,
  validateAssetAgainstTokens,
} from './design-css';
import type { JsonRecord } from './design.types';

const THEME: JsonRecord = {
  tokenSchemaVersion: 'aurum.tokens.v1',
  tokens: {
    color: {
      action: { primary: { $type: 'color', $value: '#1f6feb' } },
      text: {
        onPrimary: { $type: 'color', $value: '#ffffff' },
        faint: { $type: 'color', $value: 'rgba(255, 255, 255, 0.35)' },
        body: { $type: 'color', $value: '#172033' },
      },
    },
    space: {
      md: { $type: 'dimension', $value: '8px' },
      lg: { $type: 'dimension', $value: '16px' },
    },
    radius: { md: { $type: 'dimension', $value: '6px' } },
    easing: { out: { $type: 'cubicBezier', $value: [0.2, 0, 0, 1] } },
    shadow: {
      card: {
        $type: 'shadow',
        $value: { color: '#00000033', offsetX: '0px', offsetY: '2px', blur: '8px', spread: '0px' },
      },
    },
    alias: {
      // 别名链：alias.action -> color.action.primary
      action: { $type: 'color', $value: '{color.action.primary}' },
    },
  },
};

function tokens() {
  return collectTokenTable([THEME]);
}

function resolve(declarations: JsonRecord) {
  return resolveDeclarations(declarations, tokens(), 'declarations');
}

describe('tokenValueToCss', () => {
  it('serializes the types the old exporter silently dropped', () => {
    // 原 buildCssExport 只保留 string/number 标量，下面两类直接消失。
    expect(tokenValueToCss('cubicBezier', [0.2, 0, 0, 1])).toBe('cubic-bezier(0.2, 0, 0, 1)');
    expect(
      tokenValueToCss('shadow', {
        color: '#00000033',
        offsetX: '0px',
        offsetY: '2px',
        blur: '8px',
        spread: '0px',
      }),
    ).toBe('0px 2px 8px 0px #00000033');
  });

  it('serializes scalar types as-is', () => {
    expect(tokenValueToCss('color', '#1769aa')).toBe('#1769aa');
    expect(tokenValueToCss('dimension', '8px')).toBe('8px');
    expect(tokenValueToCss('number', 12)).toBe('12');
  });

  it('returns null for compound types that cannot collapse to one value', () => {
    expect(tokenValueToCss('typography', { fontSize: '16px' })).toBeNull();
  });
});

describe('collectTokenTable', () => {
  it('resolves alias chains to concrete values', () => {
    const table = tokens();
    expect(table.get('alias.action')?.value).toBe('#1f6feb');
    expect(table.get('color.action.primary')?.value).toBe('#1f6feb');
  });

  it('indexes nested groups with dotted paths', () => {
    expect(tokens().get('space.md')?.type).toBe('dimension');
  });
});

describe('resolveDeclarations', () => {
  it('resolves aliases, including those mixed with other content', () => {
    const result = resolve({
      padding: '{space.md} {space.lg}',
      'border-radius': '{radius.md}',
      'background-image': 'linear-gradient(90deg, {color.action.primary}, {color.text.onPrimary})',
    });
    expect(result.errors).toEqual([]);
    expect(result.css.padding).toBe('8px 16px');
    expect(result.css['border-radius']).toBe('6px');
    expect(result.css['background-image']).toBe('linear-gradient(90deg, #1f6feb, #ffffff)');
  });

  it('resolves a shadow token referenced as a whole value', () => {
    const result = resolve({ 'box-shadow': '{shadow.card}' });
    expect(result.errors).toEqual([]);
    expect(result.css['box-shadow']).toBe('0px 2px 8px 0px #00000033');
  });

  it('rejects unknown custom properties with an explicit reason', () => {
    const result = resolve({ '--primary': '#fff' });
    expect(result.css).toEqual({});
    expect(result.errors[0]).toContain('自定义属性');
  });

  it('rejects excluded properties with the reason rather than a generic message', () => {
    expect(resolve({ animation: 'spin 1s' }).errors[0]).toContain('animation 资产');
    expect(resolve({ background: '#fff' }).errors[0]).toContain('background-color');
    expect(resolve({ content: '"x"' }).errors[0]).toContain('::before');
  });

  it('rejects values that reference external resources', () => {
    // url() 已在 design-schema 的字符黑名单里被拦，这里是纵深防御
    const result = resolve({ 'background-image': 'linear-gradient(#fff, #000)' });
    expect(result.errors).toEqual([]);
    const withUrl = resolve({ 'background-image': 'url(//evil.test/a.png)' });
    expect(withUrl.css['background-image']).toBeUndefined();
  });

  it('reports a missing alias instead of silently emitting a broken value', () => {
    const result = resolve({ 'border-radius': '{radius.missing}' });
    expect(result.unresolvedAliases).toEqual(['radius.missing']);
    expect(result.errors[0]).toContain('token 不存在');
  });

  it('rejects a token whose type does not fit the property', () => {
    // radius.md 是 dimension，不能当颜色用
    const result = resolve({ 'background-color': '{radius.md}' });
    expect(result.css['background-color']).toBeUndefined();
    expect(result.errors[0]).toContain('不是合法的颜色值');
  });

  it('rejects unknown enum values and lists the allowed ones', () => {
    const result = resolve({ display: 'inline-table' });
    expect(result.errors[0]).toContain('可用');
  });

  it('accepts position and z-index', () => {
    const result = resolve({ position: 'absolute', 'z-index': 40 });
    expect(result.errors).toEqual([]);
    expect(result.css).toEqual({ position: 'absolute', 'z-index': '40' });
  });

  it('rejects transform functions outside the whitelist', () => {
    expect(resolve({ transform: 'translateY(-2px)' }).errors).toEqual([]);
    expect(resolve({ transform: 'matrix(1,0,0,1,0,0)' }).errors[0]).toContain('不允许函数');
  });

  it('accepts whitelisted filter functions', () => {
    const result = resolve({ 'backdrop-filter': 'blur(12px) saturate(140%)' });
    expect(result.errors).toEqual([]);
    expect(result.css['backdrop-filter']).toBe('blur(12px) saturate(140%)');
  });

  it('requires transition to use longhands', () => {
    expect(resolve({ 'transition-duration': '{easing.out}' }).errors.length).toBeGreaterThan(0);
    const timing = resolve({ 'transition-timing-function': '{easing.out}' });
    expect(timing.css['transition-timing-function']).toBe('cubic-bezier(0.2, 0, 0, 1)');
  });
});

describe('validateAssetAgainstTokens', () => {
  const component = (variants: JsonRecord, extra: JsonRecord = {}): JsonRecord => ({
    schemaVersion: 'aurum.component.v2',
    componentType: 'card',
    variants,
    ...extra,
  });

  it('passes a component whose foreground and background meet AA', () => {
    const result = validateAssetAgainstTokens(
      'component',
      component({
        default: {
          declarations: {
            color: '{color.text.onPrimary}',
            'background-color': '{color.action.primary}',
          },
        },
      }),
      tokens(),
      evaluateContrast,
    );
    expect(result.errors).toEqual([]);
    expect(result.contrasts).toHaveLength(1);
    expect(result.contrasts[0].ratio).toBeGreaterThan(4.5);
  });

  it('fails a component whose translucent text only looks accessible', () => {
    // 忽略 alpha 会得到约 8.6:1 的假通过；实际低于 4.5
    const result = validateAssetAgainstTokens(
      'component',
      component({
        default: {
          declarations: {
            color: '{color.text.faint}',
            'background-color': '{color.action.primary}',
          },
        },
      }),
      tokens(),
      evaluateContrast,
    );
    expect(result.errors[0]).toContain('对比度');
    expect(result.contrasts).toEqual([]);
  });

  it('applies the 3:1 threshold to large text', () => {
    const result = validateAssetAgainstTokens(
      'component',
      component({
        default: {
          declarations: {
            color: '#828282',
            'background-color': '#ffffff',
            'font-size': '32px',
          },
        },
      }),
      tokens(),
      evaluateContrast,
    );
    expect(result.errors).toEqual([]);
    expect(result.contrasts[0].threshold).toBe(3);
  });

  it('counts undeterminable contrast checks instead of silently passing', () => {
    const result = validateAssetAgainstTokens(
      'component',
      component({
        default: {
          declarations: {
            // 5 位 hex 能过 design-schema 的正则，但浏览器会丢弃整条声明
            color: '#12345',
            'background-color': '#ffffff',
          },
        },
      }),
      tokens(),
      evaluateContrast,
    );
    expect(result.contrasts).toEqual([]);
    expect(result.undeterminable).toHaveLength(1);
  });

  it('rejects an unknown pseudo state and lists the allowed ones', () => {
    const result = validateAssetAgainstTokens(
      'component',
      component({
        default: {
          declarations: { color: '#172033' },
          states: { hovered: { color: '#000000' } },
        },
      }),
      tokens(),
      evaluateContrast,
    );
    expect(result.errors[0]).toContain('不支持的伪类');
  });

  it('requires content on pseudo elements', () => {
    const result = validateAssetAgainstTokens(
      'component',
      component({
        default: {
          declarations: { color: '#172033' },
          pseudo: { after: { background: '#fff' } },
        },
      }),
      tokens(),
      evaluateContrast,
    );
    expect(result.errors.join()).toContain('缺少 content');
  });

  it('validates animation keyframes without applying the contrast gate', () => {
    const animation: JsonRecord = {
      schemaVersion: 'aurum.animation.v1',
      animationType: 'fade-in',
      trigger: 'on-enter',
      dependencies: [{ documentId: 'a'.repeat(8), versionId: 'b'.repeat(8) }],
      keyframes: [
        { at: 'from', declarations: { opacity: 0 } },
        { at: 'to', declarations: { opacity: 1 } },
      ],
      timing: { duration: '{space.md}' },
      reducedMotion: { declarations: { opacity: 1 } },
    };
    const result = validateAssetAgainstTokens('animation', animation, tokens(), evaluateContrast);
    // duration 引用了 dimension 类型的 token，值 '8px' 不是合法时长
    expect(result.errors.join()).toContain('不是合法的时间值');
    expect(result.contrasts).toEqual([]);
  });
});

describe('collectContrastPairs', () => {
  it('pairs color with background-color in the same declaration block', () => {
    const pairs = collectContrastPairs({ color: '#ffffff', 'background-color': '#1f6feb' }, 'x');
    expect(pairs).toHaveLength(1);
    expect(pairs[0].largeText).toBe(false);
  });

  it('flags large text from font-size', () => {
    const pairs = collectContrastPairs(
      { color: '#fff', 'background-color': '#000', 'font-size': '32px' },
      'x',
    );
    expect(pairs[0].largeText).toBe(true);
  });

  it('returns nothing when only one side is declared', () => {
    expect(collectContrastPairs({ color: '#fff' }, 'x')).toEqual([]);
    expect(collectContrastPairs({ 'background-color': '#fff' }, 'x')).toEqual([]);
  });
});

describe('border and outline shorthands', () => {
  const resolve = (declarations: JsonRecord) =>
    resolveDeclarations(declarations, collectTokenTable([THEME]), 'declarations');

  it('accepts a width/style/color combination in any order', () => {
    for (const value of [
      '1px solid #1f6feb',
      'solid 1px #1f6feb',
      '2px solid {color.action.primary}',
    ]) {
      const result = resolve({ border: value });
      expect(result.errors, value).toEqual([]);
      expect(result.css.border, value).toBeDefined();
    }
  });

  it('accepts outline and the per-side variants', () => {
    expect(resolve({ outline: '2px solid {color.action.primary}' }).errors).toEqual([]);
    expect(resolve({ 'border-top': 'thin dashed #000000' }).errors).toEqual([]);
  });

  it('rejects duplicate roles and unrecognized parts', () => {
    expect(resolve({ border: '1px 2px solid' }).errors[0]).toContain('宽度重复');
    expect(resolve({ border: '1px solid dashed' }).errors[0]).toContain('样式重复');
    expect(resolve({ border: 'wobbly' }).errors[0]).toContain('无法识别');
  });

  it('still excludes shorthands that cannot be split safely', () => {
    expect(resolve({ background: '#fff' }).errors[0]).toContain('background-color');
    expect(resolve({ flex: '1 1 auto' }).errors[0]).toContain('flex-grow');
    expect(resolve({ 'border-image': 'linear-gradient(#fff, #000) 1' }).errors[0]).toContain(
      'url()',
    );
  });
});
