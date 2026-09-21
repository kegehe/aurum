import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { validateDesignContent } from './design-schema';

describe('design schema validation', () => {
  it('accepts the fixed internal token subset', () => {
    expect(
      validateDesignContent('theme', {
        tokenSchemaVersion: 'aurum.tokens.v1',
        tokens: { color: { primary: { $type: 'color', $value: '#1769aa' } } },
      }),
    ).toMatchObject({ tokenSchemaVersion: 'aurum.tokens.v1' });
  });

  it('accepts safe DTCG token aliases', () => {
    expect(
      validateDesignContent('theme', {
        tokenSchemaVersion: 'aurum.tokens.v1',
        tokens: {
          color: {
            primary: { $type: 'color', $value: '#1769aa' },
            link: { $type: 'color', $value: '{color.primary}' },
          },
        },
      }),
    ).toMatchObject({ tokenSchemaVersion: 'aurum.tokens.v1' });
  });

  it('rejects aliases whose target does not exist', () => {
    expect(() =>
      validateDesignContent('theme', {
        tokenSchemaVersion: 'aurum.tokens.v1',
        tokens: { color: { link: { $type: 'color', $value: '{color.missing}' } } },
      }),
    ).toThrow('Token alias target does not exist');
  });

  it('rejects aliases with incompatible token types', () => {
    expect(() =>
      validateDesignContent('theme', {
        tokenSchemaVersion: 'aurum.tokens.v1',
        tokens: {
          color: { primary: { $type: 'color', $value: '#1769aa' } },
          dimension: { gap: { $type: 'dimension', $value: '{color.primary}' } },
        },
      }),
    ).toThrow('Token alias type must match');
  });

  it('rejects circular token aliases', () => {
    expect(() =>
      validateDesignContent('theme', {
        tokenSchemaVersion: 'aurum.tokens.v1',
        tokens: {
          color: {
            primary: { $type: 'color', $value: '{color.secondary}' },
            secondary: { $type: 'color', $value: '{color.primary}' },
          },
        },
      }),
    ).toThrow('Token alias cycle detected');
  });

  it('rejects unversioned token documents', () => {
    expect(() => validateDesignContent('foundation', { tokens: {} })).toThrow(BadRequestException);
  });

  it('rejects executable content before it can enter a candidate', () => {
    expect(() =>
      validateDesignContent('component', {
        schemaVersion: 'aurum.component.v1',
        componentType: 'button',
        variants: { default: '<script>alert(1)</script>' },
      }),
    ).toThrow('不允许包含脚本');
  });

  it('requires fixed version references in a style pack', () => {
    expect(() =>
      validateDesignContent('style_pack', {
        schemaVersion: 'aurum.style-pack.v1',
        dependencies: [{ documentId: 'theme', versionId: 'latest' }],
      }),
    ).toThrow('documentId 和 versionId');
  });

  it('rejects two pinned versions of the same style-pack dependency document', () => {
    expect(() =>
      validateDesignContent('style_pack', {
        schemaVersion: 'aurum.style-pack.v1',
        dependencies: [
          {
            documentId: '0e0c21c4-44f1-4e53-8daa-ff796d722049',
            versionId: '1e0c21c4-44f1-4e53-8daa-ff796d722049',
          },
          {
            documentId: '0e0c21c4-44f1-4e53-8daa-ff796d722049',
            versionId: '2e0c21c4-44f1-4e53-8daa-ff796d722049',
          },
        ],
      }),
    ).toThrow('同一设计文档的多个版本');
  });

  it('rejects CSS rule escapes and remote URLs in token values', () => {
    expect(() =>
      validateDesignContent('theme', {
        tokenSchemaVersion: 'aurum.tokens.v1',
        tokens: {
          color: {
            primary: {
              $type: 'color',
              $value: 'red; } body { background: url(https://example.test/a)',
            },
          },
        },
      }),
    ).toThrow(BadRequestException);
  });
});
