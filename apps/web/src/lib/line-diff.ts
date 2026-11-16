export type DiffLineType = 'context' | 'add' | 'remove';

export interface DiffLine {
  type: DiffLineType;
  text: string;
  beforeLine: number | null;
  afterLine: number | null;
}

export interface DiffHunk {
  beforeStart: number;
  beforeCount: number;
  afterStart: number;
  afterCount: number;
  lines: DiffLine[];
}

type Op = DiffLine;

const MAX_DIFF_CELLS = 1_000_000;

/**
 * 行级 unified diff。
 *
 * 只给前端展示用；不做 AST diff。超大文件直接退化为整段替换，避免 DP 矩阵过大。
 */
export function diffHunks(before: string, after: string, context = 3): DiffHunk[] {
  if (before === after) return [];
  const a = before.split('\n');
  const b = after.split('\n');
  const ops =
    a.length * b.length > MAX_DIFF_CELLS || Math.max(a.length, b.length) > 5_000
      ? fallbackOps(a, b)
      : lcsOps(a, b);
  return groupOps(ops, context);
}

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({
        type: 'context',
        text: a[i],
        beforeLine: i + 1,
        afterLine: j + 1,
      });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'remove', text: a[i], beforeLine: i + 1, afterLine: null });
      i += 1;
    } else {
      ops.push({ type: 'add', text: b[j], beforeLine: null, afterLine: j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: 'remove', text: a[i], beforeLine: i + 1, afterLine: null });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: 'add', text: b[j], beforeLine: null, afterLine: j + 1 });
    j += 1;
  }
  return ops;
}

function fallbackOps(a: string[], b: string[]): Op[] {
  return [
    ...a.map((text, index) => ({
      type: 'remove' as const,
      text,
      beforeLine: index + 1,
      afterLine: null,
    })),
    ...b.map((text, index) => ({
      type: 'add' as const,
      text,
      beforeLine: null,
      afterLine: index + 1,
    })),
  ];
}

function groupOps(ops: Op[], context: number): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let index = 0;
  while (index < ops.length) {
    while (index < ops.length && ops[index].type === 'context') index += 1;
    if (index >= ops.length) break;
    const firstChange = index;
    let lastChange = index;
    let cursor = index + 1;
    while (cursor < ops.length) {
      if (ops[cursor].type !== 'context') {
        lastChange = cursor;
        cursor += 1;
        continue;
      }
      let runEnd = cursor;
      while (runEnd < ops.length && ops[runEnd].type === 'context') runEnd += 1;
      if (runEnd === ops.length || runEnd - cursor > context * 2) break;
      cursor = runEnd;
    }

    const start = Math.max(0, firstChange - context);
    const end = Math.min(ops.length, lastChange + context + 1);
    const lines = ops.slice(start, end);
    const beforeLines = lines.filter((line) => line.beforeLine !== null);
    const afterLines = lines.filter((line) => line.afterLine !== null);
    const beforeStart = beforeLines[0]?.beforeLine ?? afterLines[0]?.afterLine ?? 1;
    const afterStart = afterLines[0]?.afterLine ?? beforeLines[0]?.beforeLine ?? 1;
    hunks.push({
      beforeStart,
      beforeCount: beforeLines.length,
      afterStart,
      afterCount: afterLines.length,
      lines,
    });
    index = end;
  }
  return hunks;
}
