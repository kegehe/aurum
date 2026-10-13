import { describe, expect, it } from 'vitest';
import { AcquisitionMode } from '@aurum/shared-types';
import { hasLocalThumbnail, isLinkResource, isRemoteResource } from './resource';

describe('资源获取方式判断', () => {
  it('link_only 判为外链资源', () => {
    expect(isLinkResource({ acquisitionMode: AcquisitionMode.link_only })).toBe(true);
    expect(isRemoteResource({ acquisitionMode: AcquisitionMode.link_only })).toBe(false);
  });

  it('metadata_only 判为仅元数据资源', () => {
    expect(isRemoteResource({ acquisitionMode: AcquisitionMode.metadata_only })).toBe(true);
    expect(isLinkResource({ acquisitionMode: AcquisitionMode.metadata_only })).toBe(false);
  });

  it('本地获取方式两者都不是', () => {
    for (const mode of [
      AcquisitionMode.local_upload,
      AcquisitionMode.mirror_file,
      AcquisitionMode.archive_snapshot,
    ]) {
      expect(isLinkResource({ acquisitionMode: mode })).toBe(false);
      expect(isRemoteResource({ acquisitionMode: mode })).toBe(false);
    }
  });
});

describe('hasLocalThumbnail', () => {
  it('外链与仅元数据资源没有本地缩略图（不应发起缩略图请求）', () => {
    expect(hasLocalThumbnail({ acquisitionMode: AcquisitionMode.link_only })).toBe(false);
    expect(hasLocalThumbnail({ acquisitionMode: AcquisitionMode.metadata_only })).toBe(false);
  });

  it('本地资源有缩略图', () => {
    expect(hasLocalThumbnail({ acquisitionMode: AcquisitionMode.local_upload })).toBe(true);
    expect(hasLocalThumbnail({ acquisitionMode: AcquisitionMode.mirror_file })).toBe(true);
  });

  // 向后兼容：老数据可能没有该字段，此时按本地文件处理，避免缩略图突然全部消失。
  it('缺失 acquisitionMode 时按本地文件处理', () => {
    expect(hasLocalThumbnail({})).toBe(true);
    expect(hasLocalThumbnail({ acquisitionMode: undefined })).toBe(true);
  });
});
