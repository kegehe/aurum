import { describe, expect, it } from 'vitest';
import { collectWithFixtureDependencies } from './design-css';
import {
  buildAnimationExport,
  buildBundle,
  buildComponentExport,
  buildTokenCss,
  flattenTokenLeaves,
} from './design-export';
import type { JsonRecord } from './design.types';

const THEME: JsonRecord = {
  tokenSchemaVersion: 'aurum.tokens.v1',
  tokens: {
    color: {
      action: { primary: { $type: 'color', $value: '#1769aa' } },
      text: { onPrimary: { $type: 'color', $value: '#ffffff' } },
      link: { $type: 'color', $value: '{color.action.primary}' },
    },
    space: { md: { $type: 'dimension', $value: '8px' } },
    radius: { md: { $type: 'dimension', $value: '6px' } },
    duration: { fast: { $type: 'duration', $value: '200ms' } },
    easing: { out: { $type: 'cubicBezier', $value: [0.2, 0, 0, 1] } },
    shadow: {
      card: {
        $type: 'shadow',
        $value: { color: '#00000033', offsetX: '0px', offsetY: '2px', blur: '8px', spread: '0px' },
      },
    },
    typography: { body: { $type: 'typography', $value: { fontSize: '16px', fontWeight: 400 } } },
  },
};

const UUID = '0e0c21c4-44f1-4e53-8daa-ff796d722049';
const UUID_V = '1e0c21c4-44f1-4e53-8daa-ff796d722049';

function withDependencies(content: JsonRecord): JsonRecord {
  return {
    ...content,
    __aurumFixtureDependencies: [{ documentId: UUID, versionId: UUID_V, content: THEME }],
  };
}

describe('flattenTokenLeaves', () => {
  it('keeps $type, which the old flattenTokens dropped', () => {
    const leaves = flattenTokenLeaves(THEME.tokens);
    expect(leaves.find((leaf) => leaf.path === 'easing.out')?.type).toBe('cubicBezier');
    expect(leaves.find((leaf) => leaf.path === 'shadow.card')?.type).toBe('shadow');
  });

  it('indexes nested groups with dotted paths', () => {
    expect(flattenTokenLeaves(THEME.tokens).map((leaf) => leaf.path)).toContain('space.md');
  });
});

describe('buildTokenCss', () => {
  it('serializes the types the old exporter silently dropped', () => {
    // 原 buildCssExport 只保留 string/number 标量：cubicBezier（数组）与
    // shadow（对象）直接消失，连报错都没有。
    const { css } = buildTokenCss([THEME]);
    expect(css).toContain('--easing-out: cubic-bezier(0.2, 0, 0, 1);');
    expect(css).toContain('--shadow-card: 0px 2px 8px 0px #00000033;');
    expect(css).toContain('--color-action-primary: #1769aa;');
    expect(css).toContain('--duration-fast: 200ms;');
  });

  it('emits aliases as variable references rather than expanding them', () => {
    expect(buildTokenCss([THEME]).css).toContain('--color-link: var(--color-action-primary);');
  });

  it('reports compound types it cannot serialize instead of dropping them', () => {
    const result = buildTokenCss([THEME]);
    expect(result.skipped.join()).toContain('typography.body');
  });

  it('flags two token paths that normalize to the same variable name', () => {
    // `space.md` 与 `space-md` 都归一化成 --space-md；不报的话后写的会静默
    // 覆盖先写的，而别名引用恰好指向被覆盖的名字。
    const colliding = {
      tokenSchemaVersion: 'aurum.tokens.v1',
      tokens: {
        space: { md: { $type: 'dimension', $value: '8px' } },
        'space-md': { $type: 'dimension', $value: '16px' },
      },
    };
    const result = buildTokenCss([colliding]);
    expect(result.collisions).toHaveLength(1);
  });

  it('returns empty css when there are no tokens', () => {
    expect(buildTokenCss([{ schemaVersion: 'aurum.layout.v1', regions: [] }]).css).toBe('');
  });
});

describe('buildComponentExport', () => {
  const component = withDependencies({
    schemaVersion: 'aurum.component.v2',
    componentType: 'glass-card',
    appliesTo: 'container',
    variants: {
      default: {
        declarations: {
          'background-color': '{color.action.primary}',
          color: '{color.text.onPrimary}',
          'border-radius': '{radius.md}',
          padding: '{space.md}',
        },
        states: { hover: { 'border-radius': '10px' } },
        pseudo: { after: { content: "''", 'border-radius': '6px' } },
      },
    },
  });

  it('compiles declarations to scoped CSS using variable references', () => {
    const exported = buildComponentExport(component, collectWithFixtureDependencies(component));
    expect(exported.css).toContain('.aurum-glass-card-default {');
    expect(exported.css).toContain('background-color: var(--color-action-primary);');
    // 导出走 var 模式：别名换成变量引用，方便消费方换肤
    expect(exported.css).toContain('padding: var(--space-md);');
  });

  it('emits real pseudo-classes for states and pseudo-elements for pseudo', () => {
    const exported = buildComponentExport(component, collectWithFixtureDependencies(component));
    // 导出物是给真实项目用的，所以用 :hover 而不是预览用的 .is-hover
    expect(exported.css).toContain('.aurum-glass-card-default:hover {');
    expect(exported.css).toContain('.aurum-glass-card-default::after {');
    expect(exported.css).toContain("content: '';");
  });

  it('produces a paste-ready element skeleton and a token usage list', () => {
    const exported = buildComponentExport(component, collectWithFixtureDependencies(component));
    expect(exported.html).toContain('class="aurum-glass-card-default"');
    expect(exported.tokensUsed).toEqual([
      'color.action.primary',
      'color.text.onPrimary',
      'radius.md',
      'space.md',
    ]);
  });

  it('prefers the default variant for the skeleton even when another key comes first', () => {
    // 模型经常按 active/default/hover 的顺序返回；盲取第一个会让实时预览只挂上
    // `.active` 的那条 transform，按钮的尺寸、底色、圆角全部丢失。
    const exported = buildComponentExport(
      {
        schemaVersion: 'aurum.component.v2',
        componentType: 'lime-pill-button',
        appliesTo: 'element',
        variants: {
          active: { declarations: { transform: 'scale(0.97)' } },
          default: { declarations: { 'background-color': 'rgb(161, 255, 20)' } },
          hover: { declarations: { 'background-color': 'rgb(192, 255, 20)' } },
        },
      },
      {},
    );
    expect(exported.html).toContain('class="aurum-lime-pill-button-default"');
    expect(exported.html).not.toContain('aurum-lime-pill-button-active');
  });
});

describe('buildAnimationExport', () => {
  const animation = withDependencies({
    schemaVersion: 'aurum.animation.v1',
    animationType: 'fade-slide-in',
    trigger: 'on-enter',
    keyframes: [
      { at: 'from', declarations: { opacity: 0, transform: 'translateY(8px)' } },
      { at: 'to', declarations: { opacity: 1, transform: 'translateY(0)' } },
    ],
    timing: { duration: '{duration.fast}', easing: '{easing.out}', iterationCount: 1 },
    reducedMotion: { declarations: { opacity: 1, transform: 'translateY(0)' } },
  });

  it('resolves timing from tokens and emits keyframes plus a utility class', () => {
    const exported = buildAnimationExport(animation, collectWithFixtureDependencies(animation));
    expect(exported.css).toContain('@keyframes aurum-fade-slide-in {');
    expect(exported.css).toContain('animation-duration: 200ms;');
    expect(exported.css).toContain('animation-timing-function: cubic-bezier(0.2, 0, 0, 1);');
    expect(exported.css).toContain('animation-fill-mode: both;');
  });

  it('always emits a prefers-reduced-motion block', () => {
    const exported = buildAnimationExport(animation, collectWithFixtureDependencies(animation));
    expect(exported.reducedMotion).toContain('@media (prefers-reduced-motion: reduce)');
    expect(exported.reducedMotion).toContain('opacity: 1;');
  });
});

describe('buildBundle', () => {
  it('bundles token definitions with the component CSS so it works standalone', () => {
    const component = withDependencies({
      schemaVersion: 'aurum.component.v2',
      componentType: 'badge',
      variants: { default: { declarations: { color: '{color.text.onPrimary}' } } },
    });
    const bundle = buildBundle('component', component, collectWithFixtureDependencies(component));
    expect(bundle.css).toContain(':root {');
    // 变量名保留 token 路径的原始大小写（自定义属性名大小写敏感，两侧一致）
    expect(bundle.css).toContain('--color-text-onPrimary: #ffffff;');
    expect(bundle.css).toContain('.aurum-badge-default {');
    expect(bundle.html).toContain('<button');
    expect(bundle.json).toBe(component);
    // 组件没有降级块，copyCss 等于 css
    expect(bundle.copyCss).toBe(bundle.css);
  });

  it('includes the reduced motion block for animations', () => {
    const animation = withDependencies({
      schemaVersion: 'aurum.animation.v1',
      animationType: 'pulse',
      trigger: 'continuous',
      keyframes: [
        { at: 'from', declarations: { opacity: 0.4 } },
        { at: 'to', declarations: { opacity: 1 } },
      ],
      timing: { duration: '600ms', iterationCount: 'infinite' },
      reducedMotion: { declarations: { opacity: 1 } },
    });
    const bundle = buildBundle('animation', animation, collectWithFixtureDependencies(animation));
    expect(bundle.reducedMotion).toContain('prefers-reduced-motion');
    expect(bundle.css).toContain('animation-iteration-count: infinite;');
    // copyCss 是"该粘贴什么"的唯一定义：必须自动带上降级块，
    // 否则运营复制出去的动画对开了"减少动态效果"的用户就是无障碍负债
    expect(bundle.copyCss).toContain('animation-iteration-count: infinite;');
    expect(bundle.copyCss).toContain('prefers-reduced-motion');
  });

  it('exports a style pack through its pinned dependencies', () => {
    // 样式包自身没有 tokens 字段，旧实现因此永远只输出一句"不含 token"的注释
    const stylePack = withDependencies({
      schemaVersion: 'aurum.style-pack.v1',
      dependencies: [{ documentId: UUID, versionId: UUID_V }],
    });
    const bundle = buildBundle('style_pack', stylePack, collectWithFixtureDependencies(stylePack));
    expect(bundle.css).toContain('--color-action-primary: #1769aa;');
    expect(bundle.css).toContain('--easing-out: cubic-bezier(0.2, 0, 0, 1);');
  });
});

describe('buildBundle media material', () => {
  const mediaComponent = withDependencies({
    schemaVersion: 'aurum.component.v2',
    componentType: 'media-showcase',
    appliesTo: 'container',
    dependencies: [{ documentId: UUID, versionId: UUID_V }],
    media: {
      resourceId: '2e0c21c4-44f1-4e53-8daa-ff796d722049',
      kind: 'image',
      alt: '示例图片',
      width: 800,
      height: 600,
    },
    variants: { default: { declarations: { color: '{color.text.onPrimary}' } } },
  });

  it('embeds the resolved data URI in the exported HTML only', () => {
    const bundle = buildBundle(
      'component',
      mediaComponent,
      collectWithFixtureDependencies(mediaComponent),
      {
        dataUri: 'data:image/png;base64,AAAA',
        mimeType: 'image/png',
        kind: 'image',
      },
    );
    expect(bundle.html).toContain('<img');
    expect(bundle.html).toContain('src="data:image/png;base64,AAAA"');
    expect(bundle.html).toContain('alt="示例图片"');
    // JSON 导出保留资源引用，不把 base64 写进版本内容
    expect(bundle.json).toBe(mediaComponent);
    expect(JSON.stringify(bundle.json)).not.toContain('data:image');
  });

  it('renders a placeholder when the media cannot be resolved', () => {
    const bundle = buildBundle(
      'component',
      mediaComponent,
      collectWithFixtureDependencies(mediaComponent),
      null,
    );
    expect(bundle.html).toContain('素材不可用');
    expect(bundle.html).not.toContain('<img');
  });
});
