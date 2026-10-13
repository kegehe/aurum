import { describe, expect, it } from 'vitest';
import { evaluateContrast } from '../../common/color/contrast';
import { collectTokenTable, validateAssetAgainstTokens } from './design-css';
import { RECIPES, describeRecipesForPrompt, listRecipes } from './design-recipes';
import { validateDesignContent } from './design-schema';
import type { DesignRecipe } from './design-recipes';
import type { JsonRecord } from './design.types';

/**
 * 效果配方必须真的能发布。
 *
 * 这条约束是刻意加的：配方的全部价值在于"按它做出来的东西过得去"。写错一个属性名
 * （用 `font` 简写、值里塞 `calc()`、给 `box-shadow` 传字符串）单测全绿，但模型
 * 照着写就被门禁拦下——而这正是本节要修的那类问题。
 *
 * 每个配方都对着**每一套配色**跑一遍，而不是对着合并后的 token 表跑。合并会让
 * 后写的配色覆盖先写的，于是"某个配方配某套配色过不了门禁"被掩盖——青色的
 * `on-primary` 就是这么漏掉的（#0d9488 配白字只有 3.74:1）。
 */
const DOCUMENT_ID = '0e0c21c4-44f1-4e53-8daa-ff796d722049';
const VERSION_ID = '1e0c21c4-44f1-4e53-8daa-ff796d722049';

const PALETTES = RECIPES.filter((recipe) => recipe.kind === 'theme');
const COMPONENTS = RECIPES.filter((recipe) => recipe.kind !== 'theme');

function pin(content: JsonRecord): JsonRecord {
  if (content.schemaVersion === undefined) return content;
  return { ...content, dependencies: [{ documentId: DOCUMENT_ID, versionId: VERSION_ID }] };
}

const GATE_CASES = COMPONENTS.flatMap((recipe) =>
  PALETTES.map((palette) => [`${recipe.id} × ${palette.id}`, recipe, palette] as const),
);

describe('效果配方', () => {
  it('每个配方都有可展示的名称与说明', () => {
    for (const recipe of RECIPES) {
      expect(recipe.name.length, recipe.id).toBeGreaterThan(1);
      expect(recipe.blurb.length, recipe.id).toBeGreaterThan(4);
      expect(recipe.technique.length, recipe.id).toBeGreaterThan(10);
    }
    expect(new Set(RECIPES.map((recipe) => recipe.id)).size).toBe(RECIPES.length);
  });

  it('覆盖了向导要展示的每一类', () => {
    expect(new Set(RECIPES.map((recipe) => recipe.category))).toEqual(
      new Set(['palette', 'button', 'card', 'text', 'motion']),
    );
  });

  it.each(RECIPES.map((recipe) => [recipe.id, recipe] as const))(
    '%s 的样例能通过结构校验',
    (_id, recipe) => {
      const tokens = collectTokenTable([PALETTES[0].sample(new Map())]);
      expect(() => validateDesignContent(recipe.kind, pin(recipe.sample(tokens)))).not.toThrow();
    },
  );

  it.each(GATE_CASES)('%s 的样例能通过发布门禁', (_label, recipe, palette) => {
    const theme = palette.sample(new Map());
    const content = pin(recipe.sample(collectTokenTable([theme])));
    const tokens = collectTokenTable([content, theme]);
    const validation = validateAssetAgainstTokens(recipe.kind, content, tokens, evaluateContrast);

    // 别名解析失败、类型不匹配、对比度不足都会落进 errors
    expect(validation.errors).toEqual([]);
  });

  it.each(PALETTES.map((palette) => [palette.id, palette] as const))(
    '%s 自带组件配方引用到的全部 token',
    (_id, palette) => {
      const tokens = collectTokenTable([palette.sample(new Map())]);
      for (const path of [
        'color.primary',
        'color.primary-strong',
        'color.on-primary',
        'color.text',
        'color.surface',
        'radius.md',
        'space.sm',
      ]) {
        expect(tokens.has(path), `配色缺少 ${path}`).toBe(true);
      }
    },
  );

  it('配色自身的前景/背景组合都达到了 AA', () => {
    for (const palette of PALETTES) {
      const tokens = collectTokenTable([palette.sample(new Map())]);
      const primary = tokens.get('color.primary');
      const onPrimary = tokens.get('color.on-primary');
      const verdict = evaluateContrast(String(onPrimary?.value), String(primary?.value), {
        largeText: false,
      });
      expect(verdict.status, `${palette.id} 的 on-primary / primary`).toBe('pass');
    }
  });
});

describe('describeRecipesForPrompt', () => {
  it('只给出与当前 kind 相关的配方', () => {
    const forComponent = describeRecipesForPrompt('component');
    expect(forComponent).toContain('渐变主按钮');
    expect(forComponent).not.toContain('淡入上移');

    const forAnimation = describeRecipesForPrompt('animation');
    expect(forAnimation).toContain('淡入上移');
    expect(forAnimation).not.toContain('渐变主按钮');
  });

  it('把该 kind 的配方全部带上，不静默截断', () => {
    const componentRecipes = RECIPES.filter((recipe) => recipe.kind === 'component');
    const prompt = describeRecipesForPrompt('component');
    for (const recipe of componentRecipes) expect(prompt).toContain(recipe.name);
  });

  it('没有相关配方时返回空串而不是空标题', () => {
    expect(describeRecipesForPrompt('layout')).toBe('');
  });
});

describe('listRecipes', () => {
  it('不泄漏不可序列化的 sample 与长文本', () => {
    for (const recipe of listRecipes() as Array<Partial<DesignRecipe>>) {
      expect(recipe).not.toHaveProperty('sample');
      expect(recipe).not.toHaveProperty('technique');
    }
  });
});
