import { describe, expect, it } from 'vitest';
import { diffHunks } from './line-diff';

describe('diffHunks', () => {
  it('returns no hunks for identical text', () => {
    expect(diffHunks('a\nb', 'a\nb')).toEqual([]);
  });

  it('groups a changed line with context', () => {
    const hunks = diffHunks('one\ntwo\nthree', 'one\nTWO\nthree');
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines.map((line) => line.type)).toContain('remove');
    expect(hunks[0].lines.map((line) => line.type)).toContain('add');
    expect(hunks[0].lines.find((line) => line.text === 'one')?.type).toBe('context');
  });

  it('detects insertions', () => {
    const hunks = diffHunks('one\nthree', 'one\ntwo\nthree');
    expect(hunks.flatMap((hunk) => hunk.lines).some((line) => line.type === 'add')).toBe(true);
  });

  it('keeps distant changes in separate hunks', () => {
    const before = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n');
    const after = before.replace('line 1', 'line one').replace('line 28', 'line twenty-eight');
    const hunks = diffHunks(before, after, 2);
    expect(hunks.length).toBeGreaterThanOrEqual(2);
  });
});
