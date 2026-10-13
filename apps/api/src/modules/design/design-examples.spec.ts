import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectTokenTable, validateAssetAgainstTokens } from './design-css';
import { validateDesignContent } from './design-schema';
import type { DesignKind, JsonRecord } from './design.types';

/**
 * 界面上"新建设计资产"用的示例，必须自己先过得去校验与门禁。
 *
 * 这条测试是有由来的：组件示例里曾经写了 `outline: '2px solid {color.primary}'`，
 * 而白名单当时不支持 outline 简写——于是**任何基于内置示例的候选都会卡在门禁**，
 * 而单测全绿，因为没有任何测试读过那份示例。示例是运营看到的第一份内容，
 * 它跑不通就等于功能不可用。
 *
 * 这些示例现在只服务于审核台里"专业模式"的 JSON 起点；面向外行的创建向导
 * 走的是服务端的 `design-recipes.ts`，那批配方由 design-recipes.spec.ts 守。
 */
const PAGE_PATH = join(
  __dirname,
  '../../../../web/src/app/(dashboard)/design-library/review/page.tsx',
);

/** 从页面源码里抽出 EXAMPLES 对象字面量（避免手抄导致测的和发出去的不是同一份） */
function loadExamples(): Record<DesignKind, JsonRecord> {
  const source = readFileSync(PAGE_PATH, 'utf8');
  const marker = 'const EXAMPLES: Record<DesignKind, Record<string, unknown>> = {';
  const start = source.indexOf(marker);
  expect(start, '页面里找不到 EXAMPLES').toBeGreaterThan(-1);

  const bodyStart = start + marker.length - 1;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return eval(`(${source.slice(bodyStart, index + 1)})`) as Record<DesignKind, JsonRecord>;
      }
    }
  }
  throw new Error('EXAMPLES 对象没有闭合');
}

const EXAMPLES = loadExamples();
const THEME = EXAMPLES.theme;
const PINNED: DesignKind[] = ['component', 'animation', 'style_pack'];
const DOCUMENT_ID = '0e0c21c4-44f1-4e53-8daa-ff796d722049';
const VERSION_ID = '1e0c21c4-44f1-4e53-8daa-ff796d722049';

/** 与新建表单一致：依赖在提交时注入 */
function asSubmitted(kind: DesignKind, content: JsonRecord): JsonRecord {
  if (!PINNED.includes(kind)) return content;
  return { ...content, dependencies: [{ documentId: DOCUMENT_ID, versionId: VERSION_ID }] };
}

function skipUnresolvable(foreground: string, background: string, options: { largeText: boolean }) {
  // 示例里的对比度只要不"失败"即可；无法判定不算问题
  void foreground;
  void background;
  void options;
  return { status: 'undetermined' } as const;
}

describe('示例资产', () => {
  const kinds = Object.keys(EXAMPLES) as DesignKind[];

  it('covers every design kind the console offers', () => {
    expect(kinds.sort()).toEqual(
      ['animation', 'component', 'foundation', 'layout', 'style_pack', 'theme'].sort(),
    );
  });

  it.each(kinds)('%s 示例能通过结构校验', (kind) => {
    expect(() => validateDesignContent(kind, asSubmitted(kind, EXAMPLES[kind]))).not.toThrow();
  });

  it('主题示例提供了示例组件与动画引用到的全部 token', () => {
    // 示例之间的引用必须是闭合的：组件声明 `{color.primary}` 就得真有这个 token，
    // 否则渲染阶段才报错，而那时已经创建了文档、发了版本。
    const tokens = collectTokenTable([THEME]);
    for (const path of ['color.primary', 'radius.md', 'space.md', 'duration.fast', 'easing.out']) {
      expect(tokens.has(path), `主题示例缺少 ${path}`).toBe(true);
    }
  });

  it.each(['component', 'animation'] as DesignKind[])(
    '%s 示例的声明能全部解析（不留门禁必失败的内容）',
    (kind) => {
      const content = asSubmitted(kind, EXAMPLES[kind]);
      // 注入依赖内容，模拟渲染期的 token 解析
      const resolved: JsonRecord = {
        ...content,
        __aurumFixtureDependencies: [
          { documentId: DOCUMENT_ID, versionId: VERSION_ID, content: THEME },
        ],
      };
      const validation = validateAssetAgainstTokens(
        kind,
        resolved,
        collectTokenTable([resolved, THEME]),
        skipUnresolvable,
      );
      expect(validation.errors).toEqual([]);
    },
  );

  it('示例里的对比度配对真实可达 AA', () => {
    // 与上一条的区别：这条用真实判定，确认示例不是靠"无法判定"蒙混过去的
    const content = asSubmitted('component', EXAMPLES.component);
    const resolved: JsonRecord = {
      ...content,
      __aurumFixtureDependencies: [
        { documentId: DOCUMENT_ID, versionId: VERSION_ID, content: THEME },
      ],
    };
    const validation = validateAssetAgainstTokens(
      'component',
      resolved,
      collectTokenTable([resolved, THEME]),
      (foreground, background, options) => {
        // 直接内联一份最小实现，避免这条测试依赖 common/color 的导出形状
        const luminance = (hex: string) => {
          const value = hex.replace('#', '');
          const channels = [0, 2, 4].map(
            (offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255,
          );
          const [r, g, b] = channels.map((channel) =>
            channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
          );
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        if (!/^#[0-9a-f]{6}$/i.test(foreground) || !/^#[0-9a-f]{6}$/i.test(background)) {
          return { status: 'undeterminable', reason: '非纯 hex，跳过' };
        }
        const left = luminance(foreground);
        const right = luminance(background);
        const ratio = (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
        const threshold = options.largeText ? 3 : 4.5;
        return { status: ratio >= threshold ? 'pass' : 'fail', ratio, threshold };
      },
    );
    expect(validation.errors).toEqual([]);
  });
});
