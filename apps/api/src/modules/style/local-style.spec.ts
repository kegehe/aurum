/**
 * 本地确定性样式分析（local-style）单元测试
 *
 * 验证：色板角色分配、近似命名、档案完整性、单色板边界、变体模板自包含性。
 */
import { describe, expect, it } from 'vitest';
import { approxColorName, buildLocalProfile, buildLocalVariations } from './local-style';

function palette(colors: string[]) {
  return { colors, width: 100, height: 100, format: 'png' };
}

describe('buildLocalProfile', () => {
  it('从多色板生成完整档案，角色已分配', () => {
    const profile = buildLocalProfile(
      palette(['#1a237e', '#ffffff', '#ec407a', '#90a4ae', '#37474f']),
    );

    expect(profile.colorPalette.primary.hex).toBeTruthy();
    expect(profile.colorPalette.background.hex).toBeTruthy();
    expect(profile.colorPalette.accent.hex).toBeTruthy();
    // scale 原样保留像素色板
    expect(profile.colorPalette.scale).toEqual([
      '#1a237e',
      '#ffffff',
      '#ec407a',
      '#90a4ae',
      '#37474f',
    ]);

    // 必备结构齐全
    expect(profile.typography.hierarchy.length).toBeGreaterThan(0);
    expect(profile.typography.weights.length).toBeGreaterThan(0);
    expect(['compact', 'comfortable', 'loose']).toContain(profile.spacing.density);
    expect(profile.layout.regions.length).toBeGreaterThan(0);
    expect(profile.textureMood.keywords.length).toBeGreaterThan(0);
    expect(profile.styleGuideText.length).toBeGreaterThan(10);
  });

  it('角色来自输入色板，不自行发明 HEX', () => {
    const colors = ['#1a237e', '#ffffff', '#ec407a'];
    const profile = buildLocalProfile(palette(colors));
    const roles = [
      profile.colorPalette.primary.hex,
      profile.colorPalette.background.hex,
      profile.colorPalette.accent.hex,
    ];
    for (const hex of roles) {
      expect(colors).toContain(hex);
    }
  });

  it('处理单色板不崩溃', () => {
    const profile = buildLocalProfile(palette(['#ff0000']));
    expect(profile.colorPalette.primary.hex).toBe('#ff0000');
    expect(profile.colorPalette.background.hex).toBe('#ff0000');
    expect(profile.colorPalette.accent.hex).toBe('#ff0000');
    expect(profile.styleGuideText.length).toBeGreaterThan(10);
  });

  it('深色/浅色基调推断排版方向（暗图建议浅色文字）', () => {
    const dark = buildLocalProfile(palette(['#000000', '#111111', '#222222']));
    // 低明度 → dark tone → 高对比无衬线
    expect(dark.typography.familyTrait).toContain('无衬线');
    expect(dark.colorPalette.mood).toContain('深');
  });

  it('近似颜色名对常见色返回稳定名称', () => {
    expect(approxColorName('#ffffff')).toBe('白色');
    expect(approxColorName('#000000')).toBe('黑色');
    expect(approxColorName('#e53935')).toBe('红色');
    expect(approxColorName('#1e88e5')).toBe('蓝色');
  });

  it('强调色与背景亮度过近时回退到高对比候选（避免"白上加白"）', () => {
    // 近白色 #fff0f3 饱和度最高，但与白色背景亮度几乎一致 → 应回退为深色 #111111
    const profile = buildLocalProfile(palette(['#ffffff', '#f0f0f0', '#fff0f3', '#111111']));
    expect(profile.colorPalette.accent.hex).toBe('#111111');
  });
});

describe('buildLocalVariations', () => {
  const profile = buildLocalProfile(palette(['#1a237e', '#ffffff', '#ec407a', '#90a4ae']));

  it('返回 4 个不同构图的变体', () => {
    const variations = buildLocalVariations(profile);
    expect(variations).toHaveLength(4);
    const names = new Set(variations.map((v) => v.name));
    expect(names.size).toBe(4);
    for (const v of variations) {
      expect(v.name.length).toBeGreaterThan(0);
      expect(v.composition.length).toBeGreaterThan(0);
      expect(v.html).toContain('<html');
    }
  });

  it('每个变体自包含：无外部资源与脚本', () => {
    for (const v of buildLocalVariations(profile)) {
      expect(v.html).not.toContain('<script');
      expect(v.html).not.toContain('<link');
      expect(v.html).not.toMatch(/\s(src|href)\s*=\s*["']?https?:/i);
    }
  });

  it('无衬线档案的变体使用无衬线字体栈（不被"衬线"子串误判）', () => {
    const html = buildLocalVariations(profile)[0].html;
    expect(html).toContain('--font:system-ui');
    expect(html).not.toContain('Georgia');
  });

  it('变体使用档案色板变量', () => {
    const html = buildLocalVariations(profile)[0].html;
    expect(html).toContain('var(--primary)');
    expect(html).toContain(profile.colorPalette.primary.hex);
  });
});
