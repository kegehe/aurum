import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { AcquisitionMode, ProcessingStatus, ResourceType } from '@aurum/shared-types';
import type { ResourceListItem } from '@/lib/types';
import { ResourcePreview } from './resource-preview';

function makeResource(overrides: Partial<ResourceListItem> = {}): ResourceListItem {
  return {
    id: 'res-1',
    title: '示例图片',
    description: null,
    originalFilename: 'sample.png',
    resourceType: ResourceType.image,
    mimeType: 'image/png',
    extension: 'png',
    sizeBytes: '2048',
    sha256: null,
    categoryId: null,
    source: null,
    author: null,
    isFavorite: false,
    processingStatus: ProcessingStatus.completed,
    duplicateOfId: null,
    width: 800,
    height: 600,
    durationSeconds: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

describe('ResourcePreview 表格缩略图', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('compact 只渲染静态缩略图，不挂视频、不解码动图', () => {
    const { container } = render(
      <ResourcePreview
        resource={makeResource({
          resourceType: ResourceType.video,
          mimeType: 'video/mp4',
          originalFilename: 'clip.mp4',
          extension: 'mp4',
        })}
        variant="compact"
      />,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toContain('/thumbnail');
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('compact 缩略图失败时回退类型图标', () => {
    const { container } = render(<ResourcePreview resource={makeResource()} variant="compact" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

/** 与组件内的退避表保持一致：2/5/10/20/30 + 三个 60s 台阶 */
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000, 60_000, 60_000];

describe('ResourcePreview 缩略图重试', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('缩略图 404 后按退避重试，生成完成后能自动显示', () => {
    vi.useFakeTimers();
    const { container } = render(
      <ResourcePreview resource={makeResource({ processingStatus: ProcessingStatus.pending })} />,
    );
    const first = container.querySelector('img:not([aria-hidden="true"])')!;
    expect(first.getAttribute('src')).not.toContain('v=');

    fireEvent.error(first);
    // 退避窗口内先收起坏图
    expect(container.querySelector('img:not([aria-hidden="true"])')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    const retried = container.querySelector('img:not([aria-hidden="true"])');
    expect(retried?.getAttribute('src')).toContain('v=1');
  });

  it('重试预算用尽后回退类型图标，避免无限请求', () => {
    vi.useFakeTimers();
    const { container } = render(<ResourcePreview resource={makeResource()} />);
    for (const delay of RETRY_DELAYS_MS) {
      fireEvent.error(container.querySelector('img:not([aria-hidden="true"])')!);
      act(() => {
        vi.advanceTimersByTime(delay);
      });
    }
    fireEvent.error(container.querySelector('img:not([aria-hidden="true"])')!);
    expect(container.querySelector('img:not([aria-hidden="true"])')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('资源从远端预览变成本地镜像后重置失败状态，重新请求缩略图', () => {
    const remote = makeResource({
      acquisitionMode: AcquisitionMode.metadata_only,
      previewUrl: 'https://example.com/a.png',
    });
    const { container, rerender } = render(<ResourcePreview resource={remote} />);
    fireEvent.error(container.querySelector('img:not([aria-hidden="true"])')!);
    // 远端预览失败与生成队列无关，直接进终态
    expect(container.querySelector('img:not([aria-hidden="true"])')).toBeNull();

    rerender(
      <ResourcePreview resource={makeResource({ acquisitionMode: AcquisitionMode.mirror_file })} />,
    );
    const img = container.querySelector('img:not([aria-hidden="true"])');
    expect(img?.getAttribute('src')).toContain('/thumbnail');
    expect(img?.getAttribute('src')).not.toContain('v=');
  });

  it('重新处理后重置重试预算，已回退图标的卡片能恢复', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <ResourcePreview resource={makeResource({ processingStatus: ProcessingStatus.completed })} />,
    );
    for (const delay of RETRY_DELAYS_MS) {
      fireEvent.error(container.querySelector('img:not([aria-hidden="true"])')!);
      act(() => {
        vi.advanceTimersByTime(delay);
      });
    }
    fireEvent.error(container.querySelector('img:not([aria-hidden="true"])')!);
    expect(container.querySelector('img:not([aria-hidden="true"])')).toBeNull();

    rerender(
      <ResourcePreview resource={makeResource({ processingStatus: ProcessingStatus.pending })} />,
    );
    const img = container.querySelector('img:not([aria-hidden="true"])');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).not.toContain('v=');
  });
});

describe('ResourcePreview 动图循环', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('支持 ImageDecoder 时用 canvas 自己逐帧播放，不依赖文件的 loop count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(16) })),
    );
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    const closeFrame = vi.fn();
    vi.stubGlobal(
      'ImageDecoder',
      class {
        tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 2 } };
        decode = vi.fn(async () => ({
          image: {
            displayWidth: 8,
            displayHeight: 8,
            // 10 秒的帧间隔：用例结束前不会排到第二帧，避免定时器越界
            duration: 10_000_000,
            close: closeFrame,
          },
        }));
        close = vi.fn();
      },
    );

    const { container } = render(
      <ResourcePreview
        resource={makeResource({
          originalFilename: 'anim.gif',
          mimeType: 'image/gif',
          extension: 'gif',
        })}
      />,
    );

    await waitFor(() =>
      expect(container.querySelector('canvas')?.className).toContain('opacity-100'),
    );
    expect(drawImage).toHaveBeenCalledTimes(1);
    // 首帧画出来后前景 <img> 让位给 canvas
    expect(container.querySelector('img:not([aria-hidden="true"])')).toBeNull();
  });
});
