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

/**
 * 格式化日期（ISO 字符串 → 中文短格式）
 */
export function formatDate(dateStr: string): string {
  const d = safeDate(dateStr);
  if (!d) return dateStr;
  return d.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/**
 * 格式化日期时间
 */
export function formatDateTime(dateStr: string): string {
  const d = safeDate(dateStr);
  if (!d) return dateStr;
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
