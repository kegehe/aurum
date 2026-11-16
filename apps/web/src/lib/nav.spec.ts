import { describe, expect, it } from 'vitest';
import { isNavItemActive } from './nav';

describe('侧边栏选中态判断', () => {
  it('审核台激活时不再同时点亮 AI 新建', () => {
    expect(isNavItemActive('/design-library/review', '/design-library/review')).toBe(true);
    expect(isNavItemActive('/design-library/review', '/design-library')).toBe(false);
  });

  it('审核台子路径同样只点亮审核台', () => {
    expect(isNavItemActive('/design-library/review/abc', '/design-library/review')).toBe(true);
    expect(isNavItemActive('/design-library/review/abc', '/design-library')).toBe(false);
  });

  it('AI 新建自身及其它子路径仍保持选中', () => {
    expect(isNavItemActive('/design-library', '/design-library')).toBe(true);
    expect(isNavItemActive('/design-library/new', '/design-library')).toBe(true);
  });

  it('同级导航项互不干扰', () => {
    expect(isNavItemActive('/settings', '/settings')).toBe(true);
    expect(isNavItemActive('/settings', '/design-library')).toBe(false);
    expect(isNavItemActive('/library', '/library')).toBe(true);
    expect(isNavItemActive('/library', '/design-library')).toBe(false);
  });

  it('仪表盘不因子路径而选中', () => {
    expect(isNavItemActive('/dashboard', '/dashboard')).toBe(true);
    expect(isNavItemActive('/dashboard/detail', '/dashboard')).toBe(false);
  });
});
