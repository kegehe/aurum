import { describe, expect, it } from 'vitest';
import { AcquisitionMode, ProcessingStatus, ResourceType } from '@aurum/shared-types';
import {
  designMediaHref,
  designMediaIssue,
  hasLocalThumbnail,
  isDesignMediaType,
  isLinkResource,
  isRemoteResource,
} from './resource';

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

describe('design media eligibility', () => {
  it('only images and videos are design media', () => {
    expect(isDesignMediaType({ resourceType: ResourceType.image })).toBe(true);
    expect(isDesignMediaType({ resourceType: ResourceType.video })).toBe(true);
    expect(isDesignMediaType({ resourceType: ResourceType.audio })).toBe(false);
  });

  it('resources in the trash cannot be used for design', () => {
    expect(
      designMediaIssue({
        resourceType: ResourceType.image,
        acquisitionMode: AcquisitionMode.local_upload,
        deletedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toContain('回收站');
  });

  it('remote-only resources must be downloaded first', () => {
    expect(
      designMediaIssue({
        resourceType: ResourceType.image,
        acquisitionMode: AcquisitionMode.metadata_only,
      }),
    ).toContain('下载到本地');
  });

  it('video requires the generated cover in detail data', () => {
    expect(
      designMediaIssue({
        resourceType: ResourceType.video,
        acquisitionMode: AcquisitionMode.local_upload,
        files: [{ fileRole: 'original' }],
      }),
    ).toContain('视频封面');
    expect(
      designMediaIssue({
        resourceType: ResourceType.video,
        acquisitionMode: AcquisitionMode.local_upload,
        files: [{ fileRole: 'original' }, { fileRole: 'thumbnail' }],
      }),
    ).toBeNull();
  });

  it('video list items use processing status when files are not loaded', () => {
    expect(
      designMediaIssue({
        resourceType: ResourceType.video,
        acquisitionMode: AcquisitionMode.local_upload,
        processingStatus: ProcessingStatus.pending,
      }),
    ).toContain('视频封面');
  });

  it('image is usable with an original or a thumbnail', () => {
    expect(
      designMediaIssue({
        resourceType: ResourceType.image,
        acquisitionMode: AcquisitionMode.mirror_file,
        files: [{ fileRole: 'thumbnail' }],
      }),
    ).toBeNull();
  });

  it('builds an encoded design handoff URL', () => {
    expect(designMediaHref('res 1')).toBe('/design-library?resource=res%201');
  });
});
