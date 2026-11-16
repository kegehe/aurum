import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'aurum.resources.view-mode';

/** 模块级 store：每个用例重新加载模块，避免上一个用例的状态泄漏 */
async function loadStore() {
  vi.resetModules();
  return import('./resource-view-mode');
}

describe('resource-view-mode', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('没有记忆时默认网格视图', async () => {
    const store = await loadStore();
    expect(store.getResourceViewMode()).toBe('grid');
  });

  it('初始化时读取上次的视图', async () => {
    window.localStorage.setItem(KEY, 'table');
    const store = await loadStore();
    expect(store.getResourceViewMode()).toBe('table');
  });

  it('存储里是脏值时回落到网格', async () => {
    window.localStorage.setItem(KEY, 'whatever');
    const store = await loadStore();
    expect(store.getResourceViewMode()).toBe('grid');
  });

  it('切换后通知订阅组件并写回 localStorage', async () => {
    const store = await loadStore();
    function Probe() {
      return <span data-testid="mode">{store.useResourceViewMode()}</span>;
    }

    render(<Probe />);
    expect(screen.getByTestId('mode').textContent).toBe('grid');

    act(() => store.setResourceViewMode('table'));

    expect(screen.getByTestId('mode').textContent).toBe('table');
    expect(window.localStorage.getItem(KEY)).toBe('table');
  });

  it('切到相同值不重复通知', async () => {
    const store = await loadStore();
    let renders = 0;
    function Probe() {
      renders += 1;
      return <span>{store.useResourceViewMode()}</span>;
    }

    render(<Probe />);
    const before = renders;

    act(() => store.setResourceViewMode('grid'));

    expect(renders).toBe(before);
  });

  it('localStorage 读取抛错（隐私模式）时回落网格', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const store = await loadStore();
    expect(store.getResourceViewMode()).toBe('grid');
  });

  it('localStorage 写入抛错（配额超限）时切换仍然生效', async () => {
    const store = await loadStore();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });

    expect(() => store.setResourceViewMode('table')).not.toThrow();
    expect(store.getResourceViewMode()).toBe('table');
  });
});
