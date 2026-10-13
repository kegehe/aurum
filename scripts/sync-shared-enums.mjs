#!/usr/bin/env node
/**
 * 从 packages/shared-types 生成 API 侧的枚举常量文件。
 *
 * 为什么是生成，而不是让 API 直接依赖 @aurum/shared-types：
 *   shared-types 只暴露裸 TS 源码（main/types 都指向 src/index.ts），web 靠 Next 的
 *   transpile 可以直接消费；但 API 走 tsc 构建，tsconfig 只 include `src/**`，吃不了
 *   node_modules 里的裸 TS。若给它加构建产物，又会让 api / web / worker 三个包都多出
 *   一条构建顺序依赖（参考 apps/worker 依赖 @aurum/api/dist 的 TS2307 陷阱），而且在
 *   watch 模式下改 shared-types 不会触发 API 侧重新编译，会静默用旧产物。
 *   生成一份到 API 的 src 下，既消除了漂移，又不改变构建图，还让 API 的 watcher
 *   天然感知到变更。
 *
 * 用法：
 *   node scripts/sync-shared-enums.mjs           写入
 *   node scripts/sync-shared-enums.mjs --check   只校验是否同步（CI 用）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(repoRoot, 'packages/shared-types/src/enums.ts');
const targetPath = path.join(repoRoot, 'apps/api/src/common/constants/enums.ts');
const relativeSource = 'packages/shared-types/src/enums.ts';
const relativeTarget = 'apps/api/src/common/constants/enums.ts';

const HEADER = `/**
 * 后端本地枚举常量 —— 自动生成，请勿手动编辑。
 *
 * 来源：${relativeSource}
 * 重新生成：\`pnpm sync:enums\`；同步校验：\`pnpm check:enums\`（CI 会跑）。
 *
 * 为什么是生成而不是直接引用：开发阶段 SQLite 不支持 Prisma enum，这些字段在 DB 中
 * 存为 String，由应用层用本文件常量约束。API 走 tsc 构建，无法直接消费 shared-types
 * 的裸 TS 源码；给它加构建产物又会引入跨包构建顺序依赖。详见 scripts/sync-shared-enums.mjs。
 */
`;

/** 去掉 shared-types 源文件顶部的文件级注释块，只保留枚举定义本体。 */
function stripLeadingBlockComment(text) {
  return text.replace(/^\s*\/\*\*[\s\S]*?\*\/\s*/, '');
}

function render() {
  const body = stripLeadingBlockComment(readFileSync(sourcePath, 'utf8'));
  return `${HEADER}\n${body.trimEnd()}\n`;
}

/** 找出第一处不同的行，给出可定位的提示。 */
function describeDifference(expected, actual) {
  const expectedLines = expected.split('\n');
  const actualLines = actual ? actual.split('\n') : [];
  const max = Math.max(expectedLines.length, actualLines.length);

  for (let index = 0; index < max; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      const lineNumber = index + 1;
      return [
        `首个差异在第 ${lineNumber} 行：`,
        `  期望: ${expectedLines[index] ?? '(文件结束)'}`,
        `  实际: ${actualLines[index] ?? '(文件结束)'}`,
      ].join('\n');
    }
  }

  return '（内容一致，可能是行尾或编码差异）';
}

const expected = render();
const isCheck = process.argv.includes('--check');

if (!isCheck) {
  writeFileSync(targetPath, expected);
  console.log(`[enums] 已生成 ${relativeTarget}（来源 ${relativeSource}）`);
  process.exit(0);
}

if (!existsSync(targetPath)) {
  console.error(`[enums] ${relativeTarget} 不存在。请运行 pnpm sync:enums`);
  process.exit(1);
}

const actual = readFileSync(targetPath, 'utf8');

if (actual === expected) {
  console.log(`[enums] ${relativeTarget} 与 ${relativeSource} 已同步`);
  process.exit(0);
}

console.error(
  [
    `[enums] ${relativeTarget} 与 ${relativeSource} 不同步。`,
    describeDifference(expected, actual),
    '改枚举请改 shared-types，然后运行 pnpm sync:enums',
  ].join('\n'),
);
process.exit(1);
