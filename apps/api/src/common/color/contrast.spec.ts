import { describe, expect, it } from 'vitest';
import {
  WCAG_AA_LARGE_TEXT,
  WCAG_AA_NORMAL_TEXT,
  compositeOver,
  contrastRatio,
  evaluateContrast,
  isLargeText,
  meetsWcagAA,
  parseColor,
  relativeLuminance,
} from './contrast';

describe('parseColor', () => {
  it('parses every hex length that CSS actually defines', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#ffff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#1769aa')).toEqual({ r: 23, g: 105, b: 170, a: 1 });
    expect(parseColor('#1769aaff')).toEqual({ r: 23, g: 105, b: 170, a: 1 });
    expect(parseColor('#1769aa80')?.a).toBeCloseTo(128 / 255, 5);
  });

  it('rejects 5- and 7-digit hex instead of silently misreading them', () => {
    // 这两个写法能通过 design-schema 的 ^#[0-9a-f]{3,8}$，但浏览器会丢弃整条
    // 声明。若这里当成黑色，门禁测量的就是一个不存在的颜色。
    expect(parseColor('#12345')).toBeNull();
    expect(parseColor('#1234567')).toBeNull();
  });

  it('keeps transparent determinable but currentColor undeterminable', () => {
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseColor('currentColor')).toBeNull();
  });

  it('accepts rgb()/hsl() with case and whitespace variance', () => {
    const expected = { r: 23, g: 105, b: 170 };
    expect(parseColor('rgb(23, 105, 170)')).toEqual({ ...expected, a: 1 });
    expect(parseColor('RGB(23 , 105 , 170)')).toEqual({ ...expected, a: 1 });
    expect(parseColor('rgb(23 105 170 / 50%)')?.a).toBeCloseTo(0.5, 5);
    expect(parseColor('hsla(210, 76%, 38%, 0.5)')?.a).toBeCloseTo(0.5, 5);
  });

  it('matches the equivalent rgb() within rounding for hsl()', () => {
    // hsl 与 hex 不必逐位相等（整数舍入），但必须落在同一颜色附近。
    const fromHsl = parseColor('hsl(210, 76%, 38%)');
    const fromHex = parseColor('#1769aa');
    expect(fromHsl).not.toBeNull();
    for (const channel of ['r', 'g', 'b'] as const) {
      expect(Math.abs(fromHsl![channel] - fromHex![channel])).toBeLessThanOrEqual(8);
    }
  });

  it('clamps out-of-range channels the way CSS does', () => {
    // rgb(999,0,0) 通过 design-schema 的 \d{1,3}，CSS 会 clamp 到 255
    expect(parseColor('rgb(999, 0, 0)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it('returns null for values it cannot resolve', () => {
    expect(parseColor('red')).toBeNull();
    expect(parseColor('oklch(0.5 0.2 200)')).toBeNull();
    expect(parseColor('color-mix(in srgb, red, blue)')).toBeNull();
    expect(parseColor('calc(255px)')).toBeNull();
    expect(parseColor('')).toBeNull();
  });
});

describe('relativeLuminance and contrastRatio', () => {
  it('computes the WCAG extremes', () => {
    const white = { r: 255, g: 255, b: 255 };
    const black = { r: 0, g: 0, b: 0 };
    expect(relativeLuminance(white)).toBeCloseTo(1, 5);
    expect(relativeLuminance(black)).toBeCloseTo(0, 5);
    expect(contrastRatio(white, black)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
  });

  it('is symmetric in argument order', () => {
    const a = { r: 23, g: 105, b: 170 };
    const b = { r: 255, g: 255, b: 255 };
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });
});

describe('evaluateContrast', () => {
  it('composites a translucent foreground before measuring', () => {
    // 这是会让结论反向的情形：忽略 alpha 会判通过，实际是失败。
    const verdict = evaluateContrast('rgba(255, 255, 255, 0.35)', '#1f6feb');
    expect(verdict.status).toBe('fail');
    if (verdict.status === 'fail') expect(verdict.ratio).toBeLessThan(4.5);

    const opaque = evaluateContrast('#ffffff', '#1f6feb');
    expect(opaque.status).toBe('pass');
    if (opaque.status === 'pass') expect(opaque.ratio).toBeGreaterThan(4.5);
  });

  it('reports a translucent background as undeterminable rather than guessing', () => {
    const verdict = evaluateContrast('#172033', 'rgba(255, 255, 255, 0.1)');
    expect(verdict.status).toBe('undeterminable');
  });

  it('reports unparseable colors as undeterminable', () => {
    expect(evaluateContrast('currentColor', '#ffffff').status).toBe('undeterminable');
    expect(evaluateContrast('#12345', '#ffffff').status).toBe('undeterminable');
  });

  it('applies the 3:1 large-text threshold', () => {
    // #767676 on white ≈ 4.54:1；选一对介于 3 与 4.5 之间的颜色
    const ratio = contrastRatio({ r: 130, g: 130, b: 130 }, { r: 255, g: 255, b: 255 });
    expect(ratio).toBeGreaterThan(WCAG_AA_LARGE_TEXT);
    expect(ratio).toBeLessThan(WCAG_AA_NORMAL_TEXT);
    expect(evaluateContrast('#828282', '#ffffff').status).toBe('fail');
    expect(evaluateContrast('#828282', '#ffffff', { largeText: true }).status).toBe('pass');
  });
});

describe('isLargeText', () => {
  it('follows the WCAG 2.2 definition', () => {
    expect(isLargeText(24, 400)).toBe(true);
    expect(isLargeText(23.9, 400)).toBe(false);
    expect(isLargeText(19, 700)).toBe(true);
    expect(isLargeText(19, 400)).toBe(false);
    expect(isLargeText(18, 700)).toBe(false);
    expect(isLargeText(null, null)).toBe(false);
  });
});

describe('meetsWcagAA', () => {
  it('uses 4.5 for body text and 3 for large text', () => {
    expect(meetsWcagAA(4.5)).toBe(true);
    expect(meetsWcagAA(4.49)).toBe(false);
    expect(meetsWcagAA(3, { largeText: true })).toBe(true);
    expect(meetsWcagAA(2.99, { largeText: true })).toBe(false);
  });
});

describe('compositeOver', () => {
  it('returns the background when the foreground is fully transparent', () => {
    expect(compositeOver({ r: 255, g: 0, b: 0, a: 0 }, { r: 10, g: 20, b: 30 })).toEqual({
      r: 10,
      g: 20,
      b: 30,
    });
  });

  it('returns the foreground when it is fully opaque', () => {
    expect(compositeOver({ r: 255, g: 0, b: 0, a: 1 }, { r: 10, g: 20, b: 30 })).toEqual({
      r: 255,
      g: 0,
      b: 0,
    });
  });
});
