import { describe, expect, it } from 'vitest';
import { checkTokenContrast } from './design-token-contrast';

function tokenDoc(primary: string, primaryAlias = false) {
  return {
    tokenSchemaVersion: 'aurum.tokens.v1',
    tokens: {
      color: {
        text: { $type: 'color', $value: '#0f172a' },
        page: { $type: 'color', $value: '#ffffff' },
        surface: { $type: 'color', $value: '#ffffff' },
        onPrimary: { $type: 'color', $value: '#ffffff' },
        primary: { $type: 'color', $value: primaryAlias ? '{color.base}' : primary },
        base: { $type: 'color', $value: primary },
        muted: { $type: 'color', $value: '#5b6b7f' },
        'on-primary': { $type: 'color', $value: '{color.onPrimary}' },
      },
    },
  };
}

describe('checkTokenContrast', () => {
  it('passes accessible text and primary pairs', () => {
    const report = checkTokenContrast(tokenDoc('#1d4ed8'));
    expect(report.status).toBe('pass');
    expect(report.checks.length).toBe(4);
  });

  it('fails when button text has low contrast', () => {
    const report = checkTokenContrast(tokenDoc('#0ea5e9'));
    expect(report.status).toBe('fail');
    expect(report.checks.some((check) => check.verdict.status === 'fail')).toBe(true);
  });

  it('resolves aliases before evaluating', () => {
    const report = checkTokenContrast(tokenDoc('#1d4ed8', true));
    expect(report.status).toBe('pass');
  });
});
