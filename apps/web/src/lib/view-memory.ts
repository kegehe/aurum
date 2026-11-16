/**
 * 资源库列表的位置记忆。
 * 只存会话级（sessionStorage）：记录「筛选签名 + 页码 + 滚动距离」，
 * 用于从详情页返回或刷新后回到原来的浏览位置。
 */

const VIEW_MEMORY_KEY = 'aurum.resources.view';

export type ViewMemory = { query: string; page: number; scrollY: number };

/** 读取上次离开列表时的位置；无记录或格式不合法时返回 null */
export function readViewMemory(): ViewMemory | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(VIEW_MEMORY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ViewMemory>;
    if (
      typeof parsed.query !== 'string' ||
      typeof parsed.page !== 'number' ||
      typeof parsed.scrollY !== 'number'
    ) {
      return null;
    }
    return { query: parsed.query, page: parsed.page, scrollY: parsed.scrollY };
  } catch {
    return null;
  }
}

/** 写入位置记忆；存储不可用（隐私模式、配额超限）时静默降级 */
export function writeViewMemory(memory: ViewMemory): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(VIEW_MEMORY_KEY, JSON.stringify(memory));
  } catch {
    // 位置记忆属于增强能力，写入失败不影响主流程
  }
}
