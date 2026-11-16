import { describe, expect, it } from 'vitest';
import { collectColorTokens, colorInputValue, setColorTokenValue } from './token-colors';

const content = {
  tokenSchemaVersion: 'aurum.tokens.v1',
  tokens: {
    color: {
      primary: { $type: 'color', $value: '#2563eb' },
      surface: { $type: 'color', $value: '#ffffff' },
    },
    space: { md: { $type: 'dimension', $value: '12px' } },
  },
};

describe('token-colors', () => {
  it('collects color tokens only', () => {
    expect(collectColorTokens(content)).toEqual([
      { path: 'color.primary', value: '#2563eb' },
      { path: 'color.surface', value: '#ffffff' },
    ]);
  });

  it('updates a nested color without mutating the original', () => {
    const next = setColorTokenValue(content, 'color.primary', '#1d4ed8');
    expect(collectColorTokens(next).find((item) => item.path === 'color.primary')?.value).toBe(
      '#1d4ed8',
    );
    expect(collectColorTokens(content).find((item) => item.path === 'color.primary')?.value).toBe(
      '#2563eb',
    );
  });

  it('normalizes short hex for the color input', () => {
    expect(colorInputValue('#abc')).toBe('#aabbcc');
    expect(colorInputValue('rgba(0, 0, 0, 0.5)')).toBeNull();
  });
});
