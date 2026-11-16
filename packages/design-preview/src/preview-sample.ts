import type { PreviewFile, PreviewManifest } from './preview-compiler.service';

const BUTTON_CLASSES = [
  'inline-flex',
  'items-center',
  'justify-center',
  'rounded-xl',
  'bg-sky-500',
  'px-6',
  'py-3',
  'text-sm',
  'font-semibold',
  'text-white',
  'shadow-lg',
  'shadow-sky-500/30',
  'transition',
  'hover:-translate-y-0.5',
  'hover:bg-sky-400',
  'focus-visible:outline',
  'focus-visible:outline-2',
  'focus-visible:outline-offset-2',
  'focus-visible:outline-sky-300',
  'active:translate-y-0',
];

const COMPONENT = `'use client';

import * as React from 'react';

export default function GlassButton() {
  const [count, setCount] = React.useState(0);

  return (
    <div className="aurum-preview">
      <button
        type="button"
        data-part="root"
        onClick={() => setCount((value) => value + 1)}
        className="inline-flex items-center justify-center rounded-xl bg-sky-500 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-sky-500/30 transition hover:-translate-y-0.5 hover:bg-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300 active:translate-y-0"
      >
        <span data-part="label">开始使用 {count}</span>
      </button>
      <p className="aurum-hint">点一下按钮，预览里的 React 状态会更新。</p>
    </div>
  );
}
`;

const PREVIEW = `import GlassButton from '../files/glass-button';

export default function Preview() {
  return <GlassButton />;
}
`;

const CSS = `.aurum-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 32px;
}

.aurum-hint {
  margin: 0;
  color: #64748b;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
}
`;

export const SAMPLE_PREVIEW_MANIFEST: PreviewManifest = {
  schemaVersion: 'aurum.asset.v1',
  slug: 'glass-button',
  name: '玻璃按钮',
  kind: 'component',
  subtype: 'button',
  description: '半透明玻璃质感的主操作按钮，适合深色或图片背景。',
  whenToUse: '需要悬浮在图片/渐变背景上的主操作；不适合大面积表单。',
  tags: ['玻璃', '按钮', '深色'],
  source: 'manual',
  preview: { entry: 'preview/preview.tsx' },
  files: [
    {
      path: 'files/glass-button.tsx',
      target: 'components/ui/glass-button.tsx',
      type: 'registry:ui',
      language: 'tsx',
    },
    {
      path: 'files/glass-button.css',
      target: 'components/ui/glass-button.css',
      type: 'registry:file',
      language: 'css',
    },
  ],
  states: ['default', 'hover', 'focus-visible', 'active'],
  parts: [
    { id: 'root', name: '按钮', selector: '[data-part=root]' },
    { id: 'label', name: '文字', selector: '[data-part=label]' },
  ],
  tokens: ['color.primary', 'radius.md', 'shadow.glass'],
  tailwindClasses: BUTTON_CLASSES,
  ai: {
    summary: '玻璃拟态主按钮，强调半透明、内高光和细边框。',
    usage: '在深色背景或图片上作为主 CTA；通过 variant 切换主/次样式。',
    examples: ['<GlassButton>开始使用</GlassButton>'],
    antiPatterns: ['不要放在纯白大段文字中，会失去层次'],
  },
};

export const SAMPLE_PREVIEW_FILES: PreviewFile[] = [
  {
    path: 'files/glass-button.tsx',
    target: 'components/ui/glass-button.tsx',
    type: 'registry:ui',
    language: 'tsx',
    content: COMPONENT,
  },
  {
    path: 'files/glass-button.css',
    target: 'components/ui/glass-button.css',
    type: 'registry:file',
    language: 'css',
    content: CSS,
  },
  {
    path: 'preview/preview.tsx',
    type: 'asset:preview',
    language: 'tsx',
    content: PREVIEW,
  },
];
