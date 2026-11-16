import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { MetadataDetector } from './metadata-detector.processor';
import { ResourceType } from '../../../common/constants/enums';
import type { IStorageService } from '../../storage/interfaces/storage-service.interface';

const { probeMediaMock } = vi.hoisted(() => ({ probeMediaMock: vi.fn() }));
vi.mock('../ffmpeg.util', () => ({ probeMedia: probeMediaMock }));

const RESOURCE_ID = 'resource-1';

function createDetector(resourceType: ResourceType) {
  const storage = {
    getStream: vi.fn(async () => Readable.from([Buffer.from('fake-media-bytes')])),
  };
  const scheduler = { enqueue: vi.fn(async () => ({ id: 'downstream-job' })) };
  const resourceRepo = {
    findById: vi.fn(async () => ({
      id: RESOURCE_ID,
      resourceType,
      mimeType: resourceType === ResourceType.video ? 'video/mp4' : 'audio/mpeg',
    })),
    update: vi.fn(async () => ({})),
    updateProcessingStatus: vi.fn(async () => ({})),
  };
  const fileRepo = {
    findByResourceAndRole: vi.fn(async () => ({ id: 'file-1', storagePath: 'original/abc' })),
  };
  const jobRepo = { findByResourceId: vi.fn(async () => []) };

  const detector = new MetadataDetector(
    storage as unknown as IStorageService,
    scheduler as never,
    resourceRepo as never,
    fileRepo as never,
    jobRepo as never,
  );
  return { detector, scheduler, resourceRepo };
}

describe('MetadataDetector ffprobe 超时', () => {
  it('视频元数据写入探测到的宽高与时长', async () => {
    const { detector, resourceRepo, scheduler } = createDetector(ResourceType.video);
    probeMediaMock.mockResolvedValue({
      streams: [{ codecType: 'video', width: 1920, height: 1080 }],
      durationSeconds: 12.5,
    });

    await detector.process(RESOURCE_ID, 'job-1');

    expect(probeMediaMock).toHaveBeenCalledOnce();
    expect(resourceRepo.update).toHaveBeenCalledWith(RESOURCE_ID, {
      width: 1920,
      height: 1080,
      durationSeconds: 12.5,
    });
    // 探测成功后才会链式创建封面任务
    expect(scheduler.enqueue).toHaveBeenCalledOnce();
  });

  it('音频只写入时长', async () => {
    const { detector, resourceRepo } = createDetector(ResourceType.audio);
    probeMediaMock.mockResolvedValue({ streams: [], durationSeconds: 0 });

    await detector.process(RESOURCE_ID, 'job-1');

    // duration=0 是有效值，不能被当成缺失
    expect(resourceRepo.update).toHaveBeenCalledWith(RESOURCE_ID, { durationSeconds: 0 });
  });

  it('探测超时错误会带上资源上下文并让任务失败，不创建下游任务', async () => {
    const { detector, resourceRepo, scheduler } = createDetector(ResourceType.video);
    probeMediaMock.mockRejectedValue(new Error('ffprobe timed out after 30s and was killed'));

    await expect(detector.process(RESOURCE_ID, 'job-1')).rejects.toThrow(
      /FFprobe failed for resource resource-1: ffprobe timed out after 30s and was killed/,
    );
    expect(resourceRepo.update).not.toHaveBeenCalled();
    expect(scheduler.enqueue).not.toHaveBeenCalled();
  });
});
