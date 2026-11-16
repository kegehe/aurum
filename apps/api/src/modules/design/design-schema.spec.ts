import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { validateDesignContent } from './design-schema';

const UUID_A = '0e0c21c4-44f1-4e53-8daa-ff796d722049';
const UUID_B = '1e0c21c4-44f1-4e53-8daa-ff796d722049';
const UUID_C = '2e0c21c4-44f1-4e53-8daa-ff796d722049';

const ANIMATION = {
  schemaVersion: 'aurum.animation.v1',
  animationType: 'fade-slide-in',
  trigger: 'on-enter',
  dependencies: [{ documentId: UUID_A, versionId: UUID_B }],
  keyframes: [
    { at: 'from', declarations: { opacity: 0, translate: '0 8px' } },
    { at: 'to', declarations: { opacity: 1, translate: '0 0' } },
  ],
  timing: { duration: '200ms', easing: 'ease-out', delay: '0ms', iterationCount: 1 },
  reducedMotion: { declarations: { opacity: 1, translate: '0 0' } },
};

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

  it('allows token aliases mixed with other content in a value', () => {
    // 别名 + 其它内容。曾经被字符黑名单的 `{`/`}` 误伤——isTokenAlias 只赦免
    // 「整串就是一个别名」，所以 `{space.md} {space.lg}` 这类多值写法全被拒。
    // 复合类型（shadow 等接受任意对象）的内部字符串是唯一能构造出
    // 「语法合法 + 含花括号」的位置：string/fontFamily 的类型正则本身禁花括号。
    expect(() =>
      validateDesignContent('theme', {
        tokenSchemaVersion: 'aurum.tokens.v1',
        tokens: {
          shadow: {
            card: {
              $type: 'shadow',
              $value: { color: '#00000033', blur: '{space.md} {space.lg}' },
            },
          },
        },
      }),
    ).not.toThrow();
  });

  it('still rejects an incomplete alias that would smuggle a brace past the filter', () => {
    expect(() =>
      validateDesignContent('theme', {
        tokenSchemaVersion: 'aurum.tokens.v1',
        tokens: {
          shadow: {
            card: { $type: 'shadow', $value: { blur: 'a{b' } },
          },
        },
      }),
    ).toThrow(BadRequestException);
  });

  it('dispatches the animation kind instead of falling through to style pack', () => {
    // 这条用例守着一个真实缺陷：validateDesignContent 原先最后一行是
    // `return validateStylePack(content)`，新增 kind 忘了加分支时会被当成样式包
    // 校验，报错信息完全误导，而 TS 的穷尽检查也不会提示。
    expect(() => validateDesignContent('animation', ANIMATION)).not.toThrow();
    expect(() =>
      validateDesignContent('animation', {
        schemaVersion: 'aurum.style-pack.v1',
        dependencies: [{ documentId: UUID_A, versionId: UUID_B }],
      }),
    ).toThrow('aurum.animation.v1');
  });

  it('requires both endpoints of an animation', () => {
    expect(() =>
      validateDesignContent('animation', {
        ...ANIMATION,
        keyframes: [
          { at: 'from', declarations: { opacity: 0 } },
          { at: '50%', declarations: { opacity: 1 } },
        ],
      }),
    ).toThrow('起点');
  });

  it('requires reduced motion on an animation', () => {
    const { reducedMotion: _omitted, ...withoutReducedMotion } = ANIMATION;
    expect(() => validateDesignContent('animation', withoutReducedMotion)).toThrow('reducedMotion');
  });

  it('rejects an animation fillMode the exporter will not honour', () => {
    expect(() =>
      validateDesignContent('animation', {
        ...ANIMATION,
        timing: { ...(ANIMATION.timing as Record<string, unknown>), fillMode: 'forwards' },
      }),
    ).toThrow('fillMode 只支持 both');
  });

  it('requires pinned dependencies on component v2 and animation', () => {
    expect(() =>
      validateDesignContent('component', {
        schemaVersion: 'aurum.component.v2',
        componentType: 'card',
        variants: { default: { declarations: { color: '#000000' } } },
      }),
    ).toThrow('至少固定一个依赖版本');
  });

  it('rejects two pinned versions of the same document on component v2', () => {
    // 原先这套去重只写在 validateStylePack 里；组件漏掉会撞 @@unique 抛未捕获的 P2002
    expect(() =>
      validateDesignContent('component', {
        schemaVersion: 'aurum.component.v2',
        componentType: 'card',
        dependencies: [
          { documentId: UUID_A, versionId: UUID_B },
          { documentId: UUID_A, versionId: UUID_C },
        ],
        variants: { default: { declarations: { color: '#000000' } } },
      }),
    ).toThrow('同一设计文档的多个版本');
  });

  it('deep-validates component v2 declarations', () => {
    expect(() =>
      validateDesignContent('component', {
        schemaVersion: 'aurum.component.v2',
        componentType: 'card',
        dependencies: [{ documentId: UUID_A, versionId: UUID_B }],
        variants: { 'Not-Kebab-Case': { declarations: { color: '#000000' } } },
      }),
    ).toThrow('kebab-case');

    expect(() =>
      validateDesignContent('component', {
        schemaVersion: 'aurum.component.v2',
        componentType: 'card',
        dependencies: [{ documentId: UUID_A, versionId: UUID_B }],
        variants: { default: { declarations: {} } },
      }),
    ).toThrow('不能为空');
  });

  it('keeps accepting v1 component documents', () => {
    expect(() =>
      validateDesignContent('component', {
        schemaVersion: 'aurum.component.v1',
        componentType: 'button',
        variants: { primary: { tone: 'brand', size: 'md' } },
      }),
    ).not.toThrow();
  });
});

describe('design component media', () => {
  function mediaComponent(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 'aurum.component.v2',
      componentType: 'media-showcase',
      appliesTo: 'container',
      dependencies: [{ documentId: UUID_A, versionId: UUID_B }],
      media: {
        resourceId: UUID_C,
        kind: 'image',
        alt: '示例图片',
        width: 800,
        height: 600,
      },
      variants: { default: { declarations: { color: '#ffffff' } } },
      ...overrides,
    };
  }

  it('accepts media on a v2 container component', () => {
    expect(() => validateDesignContent('component', mediaComponent())).not.toThrow();
  });

  it('rejects media on v1 components', () => {
    expect(() =>
      validateDesignContent(
        'component',
        mediaComponent({ schemaVersion: 'aurum.component.v1' }),
      ),
    ).toThrow('只支持 aurum.component.v2');
  });

  it('requires a container skeleton for media components', () => {
    expect(() =>
      validateDesignContent('component', mediaComponent({ appliesTo: 'element' })),
    ).toThrow('appliesTo: container');
  });

  it('rejects unsafe alt text and unknown media fields', () => {
    expect(() =>
      validateDesignContent(
        'component',
        mediaComponent({
          media: { resourceId: UUID_C, kind: 'image', alt: 'a < b' },
        }),
      ),
    ).toThrow();
    expect(() =>
      validateDesignContent(
        'component',
        mediaComponent({
          media: { resourceId: UUID_C, kind: 'image', alt: 'x', url: 'https://x' },
        }),
      ),
    ).toThrow('不支持字段');
  });
});
