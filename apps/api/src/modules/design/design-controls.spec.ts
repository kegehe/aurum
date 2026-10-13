import { describe, expect, it } from 'vitest';
import { collectTokenTable } from './design-css';
import { applyControlEdits, describeControls, type DesignControl } from './design-controls';
import { validateDesignContent } from './design-schema';
import type { JsonRecord } from './design.types';

/**
 * 反推控件。
 *
 * 守的是两条主张：
 * 1. AI 产出能变成滑块/色板/档位——所以精调不花 AI 调用、也不需要词汇；
 * 2. 控件**改不动结构**：只改已存在声明的值，且取值必须命中它自己给出的选项。
 */
const DOCUMENT_ID = '0e0c21c4-44f1-4e53-8daa-ff796d722049';
const VERSION_ID = '1e0c21c4-44f1-4e53-8daa-ff796d722049';

const THEME: JsonRecord = {
  tokenSchemaVersion: 'aurum.tokens.v1',
  tokens: {
    color: {
      primary: { $type: 'color', $value: '#1f6feb' },
      surface: { $type: 'color', $value: '#ffffff' },
      text: { $type: 'color', $value: '#0f172a' },
    },
    radius: {
      sm: { $type: 'dimension', $value: '4px' },
      md: { $type: 'dimension', $value: '6px' },
      lg: { $type: 'dimension', $value: '12px' },
    },
  },
};

const TOKENS = collectTokenTable([THEME]);

function component(declarations: JsonRecord, states?: JsonRecord): JsonRecord {
  return {
    schemaVersion: 'aurum.component.v2',
    componentType: 'glass-card',
    appliesTo: 'container',
    dependencies: [{ documentId: DOCUMENT_ID, versionId: VERSION_ID }],
    variants: { default: { declarations, ...(states ? { states } : {}) } },
  };
}

function find(controls: DesignControl[], property: string, key?: string): DesignControl {
  const found = controls.filter((control) => control.property === property);
  const control = key ? found.find((item) => item.key === key) : found[0];
  expect(control, `没有为 ${property} 生成控件`).toBeDefined();
  return control!;
}

describe('describeControls', () => {
  it('turns a token-aliased radius into an ordered 档位 selector', () => {
    const controls = describeControls(component({ 'border-radius': '{radius.md}' }), TOKENS);

    const control = find(controls, 'border-radius');
    expect(control.type).toBe('scale');
    // 按数值排序，所以 sm/md/lg 自然排成小→大，而不是按书写顺序碰运气
    expect(control.options?.map((option) => option.value)).toEqual([
      '{radius.sm}',
      '{radius.md}',
      '{radius.lg}',
    ]);
    expect(control.value).toBe('{radius.md}');
  });

  it('turns a blur into a slider and preserves the rest of the filter list', () => {
    const controls = describeControls(
      component({ 'backdrop-filter': 'blur(12px) saturate(140%)' }),
      TOKENS,
    );

    const control = find(controls, 'backdrop-filter');
    expect(control.type).toBe('range');
    // numeric 用来把滑轨定位到现状；没有它前端只能猜
    expect(control).toMatchObject({ min: 0, max: 32, step: 1, numeric: 12 });

    const result = applyControlEdits(
      component({ 'backdrop-filter': 'blur(12px) saturate(140%)' }),
      TOKENS,
      { [control.key]: 24 },
    );
    const declarations = declarationsOf(result.content);
    // 只动数值，函数名、单位、后面的 saturate 都要原样留着
    expect(declarations['backdrop-filter']).toBe('blur(24px) saturate(140%)');
  });

  it('offers the whitelisted keywords for a keyword property', () => {
    const controls = describeControls(component({ 'text-align': 'left' }), TOKENS);

    const control = find(controls, 'text-align');
    expect(control.type).toBe('choose');
    expect(control.options?.map((option) => option.value)).toContain('center');
  });

  it('offers the theme palette for a colour and keeps an off-palette literal visible', () => {
    const fromToken = find(
      describeControls(component({ 'background-color': '{color.surface}' }), TOKENS),
      'background-color',
    );
    expect(fromToken.type).toBe('color');
    expect(fromToken.options?.map((option) => option.value)).toEqual([
      '{color.primary}',
      '{color.surface}',
      '{color.text}',
    ]);

    const literal = find(
      describeControls(component({ 'background-color': '#ff0000' }), TOKENS),
      'background-color',
    );
    // 模型直接给了 hex 时，当前值必须出现在第一位，否则用户看不到自己现在是什么色
    expect(literal.options?.[0]).toEqual({ label: '当前', value: '#ff0000', swatch: '#ff0000' });
    // 色块要能画出来：前端拿不到 token 表，所以服务端得把色值带上
    expect(literal.options?.every((option) => option.swatch)).toBe(true);
  });

  it('names the state a control belongs to', () => {
    const controls = describeControls(
      component(
        { 'background-color': '{color.surface}' },
        { hover: { 'background-color': '{color.primary}' } },
      ),
      TOKENS,
    );

    const hovered = find(controls, 'background-color', 'state:default.hover/background-color');
    expect(hovered.label).toBe('悬停 · 底色');
    // 同一个属性在不同块里必须是不同的控件，否则改悬停会连默认态一起改
    expect(find(controls, 'background-color', 'variant:default/background-color')).toBeDefined();
  });

  it('gives animation keyframes their own controls', () => {
    const animation: JsonRecord = {
      schemaVersion: 'aurum.animation.v1',
      animationType: 'fade-slide-in',
      trigger: 'on-enter',
      dependencies: [{ documentId: DOCUMENT_ID, versionId: VERSION_ID }],
      keyframes: [
        { at: 'from', declarations: { opacity: '0', transform: 'translateY(8px)' } },
        { at: 'to', declarations: { opacity: '1', transform: 'translateY(0px)' } },
      ],
      timing: { duration: '300ms', fillMode: 'both' },
      reducedMotion: { declarations: { opacity: '1' } },
    };

    const controls = describeControls(animation, TOKENS);
    expect(controls.map((control) => control.key)).toEqual(
      expect.arrayContaining(['keyframe:from/opacity', 'keyframe:to/opacity']),
    );

    const slide = find(controls, 'transform', 'keyframe:from/transform');
    const result = applyControlEdits(animation, TOKENS, { [slide.key]: -4 });
    expect(result.content.keyframes).toEqual([
      { at: 'from', declarations: { opacity: '0', transform: 'translateY(-4px)' } },
      { at: 'to', declarations: { opacity: '1', transform: 'translateY(0px)' } },
    ]);
  });
});

describe('applyControlEdits', () => {
  it('refuses a value the control never offered', () => {
    const content = component({ 'border-radius': '{radius.md}' });
    const control = find(describeControls(content, TOKENS), 'border-radius');

    const result = applyControlEdits(content, TOKENS, { [control.key]: '999px' });

    // 这是"控件改不动结构"的核心论证：允许的取值集合由服务端自己给出，
    // 客户端不能借这个端点往内容里塞任意值。
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([{ key: control.key, reason: '取值不在该控件的可选范围内' }]);
    expect(declarationsOf(result.content)['border-radius']).toBe('{radius.md}');
  });

  it('leaves other declarations untouched', () => {
    const content = component({
      'border-radius': '{radius.md}',
      'background-color': '{color.surface}',
      'backdrop-filter': 'blur(12px)',
    });
    const radius = find(describeControls(content, TOKENS), 'border-radius');

    const result = applyControlEdits(content, TOKENS, { [radius.key]: '{radius.lg}' });

    expect(result.applied).toEqual([radius.key]);
    expect(declarationsOf(result.content)).toEqual({
      'border-radius': '{radius.lg}',
      'background-color': '{color.surface}',
      'backdrop-filter': 'blur(12px)',
    });
  });

  it('produces content that still passes the schema', () => {
    const content = component(
      { 'border-radius': '{radius.md}', 'background-color': '{color.surface}' },
      { hover: { 'backdrop-filter': 'blur(4px)' } },
    );
    const controls = describeControls(content, TOKENS);
    const radius = find(controls, 'border-radius');
    const blur = find(controls, 'backdrop-filter');

    const result = applyControlEdits(content, TOKENS, {
      [radius.key]: '{radius.sm}',
      [blur.key]: 16,
    });

    expect(result.applied).toHaveLength(2);
    expect(() => validateDesignContent('component', result.content)).not.toThrow();
  });
});

function declarationsOf(content: JsonRecord): JsonRecord {
  const variants = content.variants as Record<string, { declarations: JsonRecord }>;
  return variants.default.declarations;
}
