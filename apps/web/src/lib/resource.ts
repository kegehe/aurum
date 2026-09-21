import { AcquisitionMode } from '@aurum/shared-types';

/** 判断是否为外部链接资源（仅保存 URL，无本地文件） */
export function isLinkResource(resource: { acquisitionMode?: AcquisitionMode }): boolean {
  return resource.acquisitionMode === AcquisitionMode.link_only;
}

/** 判断是否为仅保存元数据的远程资源（无本地文件） */
export function isRemoteResource(resource: { acquisitionMode?: AcquisitionMode }): boolean {
  return resource.acquisitionMode === AcquisitionMode.metadata_only;
}

/**
 * 判断资源是否有本地缩略图。
 * 外链/仅元数据资源没有本地文件，不应发起缩略图请求。
 * 缺失获取方式字段时按本地文件处理，保持向后兼容。
 */
export function hasLocalThumbnail(resource: { acquisitionMode?: AcquisitionMode }): boolean {
  if (!resource.acquisitionMode) return true;
  return !isLinkResource(resource) && !isRemoteResource(resource);
}
