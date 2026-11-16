import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatByteString,
  formatCompactNumber,
  formatDate,
  formatDateTime,
  formatDurationMs,
} from './format';

describe('formatBytes', () => {
  it('0 与负数都归零', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
  });

  it('非法数值归零', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });

  it('按 1024 进制换算', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
  });

  it('小于 10 保留一位小数，否则取整', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(15 * 1024)).toBe('15 KB');
  });

  it('超出单位表时停在最大单位，不出现 undefined', () => {
    const result = formatBytes(1024 ** 7);
    expect(result).toContain('PB');
    expect(result).not.toContain('undefined');
  });
});

describe('formatByteString', () => {
  it('解析后端 BigInt 字符串', () => {
    expect(formatByteString('1024')).toBe('1.0 KB');
    expect(formatByteString('0')).toBe('0 B');
    expect(formatByteString('-5')).toBe('0 B');
  });

  it('非法输入归零而不抛异常', () => {
    expect(formatByteString('abc')).toBe('0 B');
    expect(formatByteString('')).toBe('0 B');
  });

  it('字节级返回整数，不带小数', () => {
    expect(formatByteString('512')).toBe('512 B');
  });

  it('进位正确：小数四舍五入到整后不再带 .0', () => {
    // 1997 / 1024 = 1.950... → 四舍五入为 2，进位后走整数字符串
    expect(formatByteString('1997')).toBe('2 KB');
  });

  it('大数不丢精度（这是引入 BigInt 的原因）', () => {
    // 9 PB = 9 * 1024^5 = 10133099161583616，已超过 Number.MAX_SAFE_INTEGER，
    // 用 Number 换算会失真，BigInt 路径必须仍然准确。
    const ninePb = (BigInt(1024) ** BigInt(5) * BigInt(9)).toString();
    expect(Number(ninePb) > Number.MAX_SAFE_INTEGER).toBe(true);
    expect(formatByteString(ninePb)).toBe('9.0 PB');
  });

  it('单位表最大到 PB，超出后以更大的 PB 数值表示', () => {
    // 与 formatBytes 同样是 6 个单位（B..PB），EB 及以上不单独成单位。
    const oneEb = (BigInt(1024) ** BigInt(6)).toString();
    expect(formatByteString(oneEb)).toBe('1024 PB');
  });

  it('与 formatBytes 在 1 KB 以上结论一致', () => {
    for (const bytes of [0, 1023, 1024, 1536, 10 * 1024, 1024 ** 3, 5 * 1024 ** 4]) {
      expect(formatByteString(String(bytes))).toBe(formatBytes(bytes));
    }
  });

  // 记录一处真实的（纯外观的）差异：format ByteString 对个位数字节输出 "1 B"，
  // 而 formatBytes 走 toFixed(1) 输出 "1.0 B"。format.ts 的注释称"与 formatBytes
  // 行为一致"，实际仅在 1–9 字节这个区间不成立。这里锁住现状，避免无意中改变展示。
  it('个位数字节与 formatBytes 的已知差异', () => {
    expect(formatByteString('1')).toBe('1 B');
    expect(formatBytes(1)).toBe('1.0 B');
    expect(formatByteString('9')).toBe('9 B');
    expect(formatBytes(9)).toBe('9.0 B');
  });
});

describe('formatDate / formatDateTime', () => {
  it('无法解析时原样返回，不抛异常也不显示 Invalid Date', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date');
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });

  it('合法 ISO 字符串输出中文格式', () => {
    const result = formatDate('2026-09-29T10:30:00.000Z');
    expect(result).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
  });

  it('formatDateTime 含时分', () => {
    const result = formatDateTime('2026-09-29T10:30:00.000Z');
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe('formatCompactNumber', () => {
  it('小于一千返回整数', () => {
    expect(formatCompactNumber(0)).toBe('0');
    expect(formatCompactNumber(999)).toBe('999');
  });

  it('万级使用紧凑单位', () => {
    expect(formatCompactNumber(12345)).toBe('1.2万');
  });

  it('非法值归零', () => {
    expect(formatCompactNumber(Number.NaN)).toBe('0');
  });
});

describe('formatDurationMs', () => {
  it('小于一秒显示毫秒', () => {
    expect(formatDurationMs(0)).toBe('0 ms');
    expect(formatDurationMs(500)).toBe('500 ms');
  });

  it('超过一秒保留一位小数', () => {
    expect(formatDurationMs(1500)).toBe('1.5 s');
  });
});
