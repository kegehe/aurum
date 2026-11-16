import { NAV_ITEMS } from './constants';

/** 所有导航项 href，用于判断路径归属 */
const NAV_HREFS: readonly string[] = NAV_ITEMS.flatMap((group) =>
  group.items.map((item) => item.href),
);

/**
 * 判断导航项是否处于选中态。
 * 单个导航项的子路径会归属到该项，但若存在更具体的导航项匹配同一路径，
 * 则让位给更具体的那一项（例如 /design-library/review 不应同时点亮 /design-library）。
 */
export function isNavItemActive(pathname: string, href: string): boolean {
  const matched = pathname === href || (href !== '/dashboard' && pathname.startsWith(`${href}/`));
  if (!matched) return false;

  return !NAV_HREFS.some(
    (other) =>
      other.length > href.length &&
      other.startsWith(`${href}/`) &&
      (pathname === other || pathname.startsWith(`${other}/`)),
  );
}
