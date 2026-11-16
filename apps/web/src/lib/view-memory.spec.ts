import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readViewMemory, writeViewMemory } from './view-memory';

const KEY = 'aurum.resources.view';

describe('view-memory', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('没有记录时返回 null', () => {
    expect(readViewMemory()).toBeNull();
  });

  it('写入后能原样读回筛选签名、页码与滚动距离', () => {
    writeViewMemory({ query: 'categoryId=c1|50', page: 3, scrollY: 1200 });
    expect(readViewMemory()).toEqual({ query: 'categoryId=c1|50', page: 3, scrollY: 1200 });
  });

  it('JSON 损坏时返回 null 而不是抛错', () => {
    window.sessionStorage.setItem(KEY, '{not-json');
    expect(readViewMemory()).toBeNull();
  });

  // 脏数据（被别处写坏、旧版本结构）不能让列表页崩掉
  it('字段缺失或类型不对时返回 null', () => {
    window.sessionStorage.setItem(KEY, JSON.stringify({ query: 'x', page: '3', scrollY: 10 }));
    expect(readViewMemory()).toBeNull();
    window.sessionStorage.setItem(KEY, JSON.stringify({ query: 'x', page: 3 }));
    expect(readViewMemory()).toBeNull();
  });

  it('sessionStorage 读取抛错（隐私模式）时返回 null', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readViewMemory()).toBeNull();
    spy.mockRestore();
  });

  it('sessionStorage 写入抛错（配额超限）时不向外抛', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => writeViewMemory({ query: '', page: 1, scrollY: 0 })).not.toThrow();
    spy.mockRestore();
  });
});
