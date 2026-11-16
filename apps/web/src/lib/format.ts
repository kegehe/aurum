/**
 * 格式化文件大小（bytes → 可读字符串）
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/**
 * 格式化后端 BigInt 字符串形式的字节数，避免大文件库统计丢精度。
 * 小数部分四舍五入到 1 位，与 formatBytes 行为一致。
 */
export function formatByteString(bytesStr: string): string {
  let bytes: bigint;
  try {
    bytes = BigInt(bytesStr);
  } catch {
    return '0 B';
  }
  if (bytes <= BigInt(0)) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const base = BigInt(1024);
  let unitIndex = 0;
  let divisor = BigInt(1);
  while (unitIndex < units.length - 1 && bytes >= divisor * base) {
    divisor *= base;
    unitIndex++;
  }

  if (unitIndex === 0) return `${bytes.toString()} B`;

  const whole = bytes / divisor;
  const remainder = bytes % divisor;
  // 四舍五入到 1 位小数：remainder * 10 / divisor + 5 / 10（即 +0.5 后截断）
  const decimalRaw = Number((remainder * BigInt(10) + divisor / BigInt(2)) / divisor);
  // decimalRaw 可能是 10（进位），如 0.95 → 1.0
  if (decimalRaw >= 10) {
    const rounded = whole + BigInt(1);
    return `${rounded.toString()} ${units[unitIndex]}`;
  }
  const value = whole < BigInt(10) ? `${whole.toString()}.${decimalRaw}` : whole.toString();
  return `${value} ${units[unitIndex]}`;
}

/**
 * 安全解析日期字符串，失败时返回原始值
 */
function safeDate(dateStr: string): Date | null {
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

// Intl 格式化器的构造远贵于 format()：列表里每张卡片每次渲染都新建一个，
// 一页 50 条就要多花 ~7ms。格式化器本身与数据无关，模块级复用即可。
const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const dateTimeCompactFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const numberFormatter = new Intl.NumberFormat('zh-CN');
const compactNumberFormatter = new Intl.NumberFormat('zh-CN', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/**
 * 格式化日期（ISO 字符串 → 中文短格式）
 */
export function formatDate(dateStr: string): string {
  const d = safeDate(dateStr);
  if (!d) return dateStr;
  return dateFormatter.format(d);
}

/**
 * 格式化日期时间
 */
export function formatDateTime(dateStr: string): string {
  const d = safeDate(dateStr);
  if (!d) return dateStr;
  return dateTimeFormatter.format(d);
}

/**
 * 紧凑数字（999 → 999，12345 → 1.2万，1234567 → 123.5万）
 * 用于指标卡等空间有限的位置；明细表仍用 formatNumber 展示精确值。
 */
export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) < 1000) return String(Math.round(value));
  return compactNumberFormatter.format(value);
}

/** 精确整数（千分位） */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return numberFormatter.format(value);
}

/** 毫秒 → 可读耗时（<1s 显示毫秒，否则保留一位小数的秒） */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 ms';
  // 先取整再判断单位，避免 999.6ms 显示成 "1000 ms" 而不是 "1.0 s"
  const rounded = Math.round(ms);
  if (rounded < 1000) return `${rounded} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** 短日期时间（MM-DD HH:mm），用于紧凑列表 */
export function formatDateTimeCompact(dateStr: string): string {
  const d = safeDate(dateStr);
  if (!d) return dateStr;
  return dateTimeCompactFormatter.format(d);
}
