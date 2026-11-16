/**
 * 来源 baseUrl 的范围校验。
 *
 * 这里的逻辑同时被「链接导入」与「设计参考」两条链路使用，抽出来是为了
 * 避免两处各写一份、日后语义漂移（RSS 的 Feed 地址被当成路径前缀正是这样漏掉的）。
 */

/**
 * target 是否位于 base 的同一 origin，且路径等于 base 路径或在其之下。
 * base 为根路径（/）时只校验 origin。
 *
 * 注意：base 的路径前缀按路径段比较，`/assets` 不会放行 `/assets2`。
 */
export function isUrlWithinSourceBase(base: URL, target: URL): boolean {
  if (target.origin !== base.origin) return false;
  const normalizePath = (pathname: string) => pathname.replace(/\/+$/, '') || '/';
  const basePath = normalizePath(base.pathname);
  const targetPath = normalizePath(target.pathname);
  return basePath === '/' || targetPath === basePath || targetPath.startsWith(`${basePath}/`);
}
