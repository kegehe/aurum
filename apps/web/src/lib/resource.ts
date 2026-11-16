import { AcquisitionMode, ProcessingStatus, ResourceType } from '@aurum/shared-types';

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

/** 能否作为设计素材：只有图片/视频。 */
export function isDesignMediaType(resource: { resourceType: string }): boolean {
  return resource.resourceType === ResourceType.image || resource.resourceType === ResourceType.video;
}

export function designMediaHref(id: string): string {
  return `/design-library?resource=${encodeURIComponent(id)}`;
}

interface DesignMediaCandidate {
  resourceType: string;
  acquisitionMode?: AcquisitionMode | null;
  processingStatus?: ProcessingStatus | string | null;
  deletedAt?: string | null;
  files?: Array<{ fileRole: string }> | null;
}

/**
 * 素材能否直接进入设计。
 *
 * 只支持本地图片/视频；视频必须有封面帧，图片至少有原文件或缩略图。
 * 列表项没有 files 时按获取方式和处理状态给出保守判断，详情页再精确校验。
 */
export function designMediaIssue(resource: DesignMediaCandidate): string | null {
  if (!isDesignMediaType(resource)) return '只有图片或视频可以作为设计素材';
  if (resource.deletedAt) return '资源已在回收站，恢复后才能用于设计';
  const mode = { acquisitionMode: resource.acquisitionMode ?? undefined };
  if (isLinkResource(mode) || isRemoteResource(mode)) {
    return '这个资源还没有本地文件，请先在资源详情下载到本地';
  }

  const files = resource.files;
  const hasOriginal = files ? files.some((file) => file.fileRole === 'original') : null;
  const hasThumbnail = files ? files.some((file) => file.fileRole === 'thumbnail') : null;

  if (resource.resourceType === ResourceType.video) {
    if (hasThumbnail === false) return '视频封面还没生成，请等处理完成或点「重新处理」后再试';
    if (hasThumbnail === null && resource.processingStatus !== ProcessingStatus.completed) {
      return '视频封面还没生成，请等处理完成后再试';
    }
    return null;
  }

  if (hasOriginal === false && hasThumbnail === false) {
    return '图片原文件缺失，请重新处理后再试';
  }
  return null;
}
