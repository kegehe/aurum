import { describe, expect, it } from 'vitest';
import { resolveResourceProcessingStatus } from './resource-status.util';
import { JobStatus, JobType, ProcessingStatus } from '../../common/constants/enums';

function job(jobType: JobType, status: JobStatus, createdAt: string) {
  return {
    id: `${jobType}-${status}-${createdAt}`,
    jobType,
    status,
    createdAt: new Date(createdAt),
  };
}

describe('resolveResourceProcessingStatus', () => {
  it('任一任务在跑时资源为 processing', () => {
    expect(
      resolveResourceProcessingStatus([
        job(JobType.detect_metadata, JobStatus.completed, '2026-01-01T00:00:00Z'),
        job(JobType.generate_video_cover, JobStatus.processing, '2026-01-01T00:01:00Z'),
      ]),
    ).toBe(ProcessingStatus.processing);
  });

  it('有待处理任务时优先于终态失败', () => {
    expect(
      resolveResourceProcessingStatus([
        job(JobType.generate_video_cover, JobStatus.failed, '2026-01-01T00:00:00Z'),
        job(JobType.generate_video_cover, JobStatus.pending, '2026-01-01T00:05:00Z'),
      ]),
    ).toBe(ProcessingStatus.pending);
  });

  it('元数据成功但封面永久失败时资源为 failed', () => {
    expect(
      resolveResourceProcessingStatus([
        job(JobType.detect_metadata, JobStatus.completed, '2026-01-01T00:00:00Z'),
        job(JobType.generate_video_cover, JobStatus.failed, '2026-01-01T00:01:00Z'),
      ]),
    ).toBe(ProcessingStatus.failed);
    // 与任务排列顺序无关
    expect(
      resolveResourceProcessingStatus([
        job(JobType.generate_video_cover, JobStatus.failed, '2026-01-01T00:01:00Z'),
        job(JobType.detect_metadata, JobStatus.completed, '2026-01-01T00:00:00Z'),
      ]),
    ).toBe(ProcessingStatus.failed);
  });

  it('重新处理后旧的封面失败记录不再压着资源', () => {
    expect(
      resolveResourceProcessingStatus([
        job(JobType.detect_metadata, JobStatus.completed, '2026-01-01T00:00:00Z'),
        job(JobType.generate_video_cover, JobStatus.failed, '2026-01-01T00:01:00Z'),
        job(JobType.generate_video_cover, JobStatus.completed, '2026-01-01T00:05:00Z'),
      ]),
    ).toBe(ProcessingStatus.completed);
  });

  it('重新处理后的新任务再次失败时资源为 failed', () => {
    expect(
      resolveResourceProcessingStatus([
        job(JobType.generate_video_cover, JobStatus.completed, '2026-01-01T00:00:00Z'),
        job(JobType.generate_video_cover, JobStatus.failed, '2026-01-01T00:05:00Z'),
      ]),
    ).toBe(ProcessingStatus.failed);
  });

  it('取消与成功并存时仍为 completed', () => {
    expect(
      resolveResourceProcessingStatus([
        job(JobType.detect_metadata, JobStatus.canceled, '2026-01-01T00:01:00Z'),
        job(JobType.generate_thumbnail, JobStatus.completed, '2026-01-01T00:00:00Z'),
      ]),
    ).toBe(ProcessingStatus.completed);
  });

  it('只有取消任务时为 failed', () => {
    expect(
      resolveResourceProcessingStatus([
        job(JobType.detect_metadata, JobStatus.canceled, '2026-01-01T00:00:00Z'),
      ]),
    ).toBe(ProcessingStatus.failed);
  });

  it('没有任何任务时为 failed', () => {
    expect(resolveResourceProcessingStatus([])).toBe(ProcessingStatus.failed);
  });
});
