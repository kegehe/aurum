import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { AcquisitionMode, ProcessingStatus, ResourceType } from '@aurum/shared-types';
import type { ResourceListItem } from '@/lib/types';
import { ResourceCard } from './resource-card';

// next/link 依赖 App Router 上下文，单测里替换成普通 <a>（保留 title/aria 等属性）
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

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

function makeVideo(overrides: Partial<ResourceListItem> = {}): ResourceListItem {
  return makeResource({
    resourceType: ResourceType.video,
    mimeType: 'video/mp4',
    originalFilename: 'clip.mp4',
    extension: 'mp4',
    ...overrides,
  });
}

/** 前景图（模糊铺底层带 aria-hidden，不能按顺序取 img） */
function foreground(container: HTMLElement): HTMLImageElement | null {
  return container.querySelector('img:not([aria-hidden="true"])');
}

/**
 * 用可手动触发的假 IntersectionObserver 替换全局实现。
 * jsdom 没有 IntersectionObserver，不替换的话组件会走“直接播放”的兜底分支，
 * 视口门禁就测不到了。
 */
function stubIntersectionObserver() {
  const instances: Array<{
    margin: string;
    callback: (entries: Array<{ isIntersecting: boolean }>) => void;
  }> = [];
  const stub = {
    observe: vi.fn(),
    disconnect: vi.fn(),
    /** 当前 observer 收到的阈值，用来验证迟滞的两档切换 */
    margins: () => instances.map((instance) => instance.margin),
    /** 触发最近一次创建的 observer 回调（切换阈值后会换成新的） */
    notify: (isIntersecting: boolean) => {
      instances[instances.length - 1]?.callback([{ isIntersecting }]);
    },
  };

  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        instances.push({
          margin: options?.rootMargin ?? '',
          callback: (entries) =>
            callback(
              entries as IntersectionObserverEntry[],
              this as unknown as IntersectionObserver,
            ),
        });
      }
      observe = stub.observe;
      unobserve() {}
      disconnect = stub.disconnect;
      takeRecords() {
        return [];
      }
    },
  );

  return stub;
}

describe('ResourceCard 缩略图', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('图片资源渲染「模糊铺底 + 完整前景」两层，且前景不裁切', () => {
    const { container } = render(<ResourceCard resource={makeResource()} />);
    const images = container.querySelectorAll('img');
    expect(images).toHaveLength(2);
    // 底层：cover 裁切后模糊，纯装饰
    expect(images[0].getAttribute('aria-hidden')).toBe('true');
    expect(images[0].className).toContain('object-cover');
    expect(images[0].className).toContain('blur-lg');
    // 上层：contain 完整显示
    expect(foreground(container)?.className).toContain('object-contain');
  });

  it('加载完成前显示占位，加载后移除并淡入', () => {
    const { container } = render(<ResourceCard resource={makeResource()} />);
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    const image = foreground(container);
    expect(image?.className).toContain('opacity-0');

    fireEvent.load(image!);

    expect(container.querySelector('.animate-pulse')).toBeNull();
    expect(foreground(container)?.className).toContain('opacity-100');
  });

  it('图片加载失败时回退为类型图标，不残留破图', () => {
    const { container } = render(<ResourceCard resource={makeResource()} />);
    fireEvent.error(foreground(container)!);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('GIF 动图直接用原文件作前景，背景层仍用静态缩略图', () => {
    const { container } = render(
      <ResourceCard
        resource={makeResource({
          originalFilename: 'anim.gif',
          mimeType: 'image/gif',
          extension: 'gif',
        })}
      />,
    );
    const images = container.querySelectorAll('img');
    expect(images).toHaveLength(2);
    expect(images[0].getAttribute('src')).toContain('/thumbnail');
    expect(foreground(container)?.getAttribute('src')).toContain('/preview');
  });

  it('没有 ImageDecoder 的动图用 img 兜底时，加载完成也会结束占位动画', () => {
    const { container } = render(
      <ResourceCard
        resource={makeResource({
          originalFilename: 'anim.gif',
          mimeType: 'image/gif',
          extension: 'gif',
        })}
      />,
    );
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    fireEvent.load(foreground(container)!);
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });

  it('本地 GIF 原图加载失败时退回静态缩略图', () => {
    const { container } = render(
      <ResourceCard
        resource={makeResource({
          originalFilename: 'anim.gif',
          mimeType: 'image/gif',
          extension: 'gif',
        })}
      />,
    );
    // 先加载成功，再让原图失败：前景应切回静态缩略图而不是破图
    fireEvent.error(foreground(container)!);
    const fallback = foreground(container);
    expect(fallback).not.toBeNull();
    expect(fallback?.getAttribute('src')).toContain('/thumbnail');
  });

  it('resourceType 和 MIME 都不可靠时，仍按后缀识别视频并自动播放', () => {
    const { container } = render(
      <ResourceCard
        resource={makeResource({
          resourceType: ResourceType.other,
          mimeType: 'application/octet-stream',
          originalFilename: 'clip.mp4',
          extension: 'mp4',
        })}
      />,
    );
    expect(container.querySelector('video')).not.toBeNull();
  });

  it('文件名不带后缀时，靠独立的 extension 字段识别动图', () => {
    const { container } = render(
      <ResourceCard
        resource={makeResource({
          resourceType: ResourceType.other,
          mimeType: 'application/octet-stream',
          originalFilename: 'asset',
          extension: 'gif',
        })}
      />,
    );
    expect(foreground(container)?.getAttribute('src')).toContain('/preview');
  });

  it('视频进入视口后才挂载，滚出视口卸载，且自动静音循环播放', () => {
    const observer = stubIntersectionObserver();
    const { container } = render(<ResourceCard resource={makeVideo()} />);

    // 还没进入视口：只显示缩略图，不发起视频请求
    expect(container.querySelector('video')).toBeNull();
    expect(observer.observe).toHaveBeenCalledTimes(1);

    act(() => observer.notify(true));

    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('src')).toContain('/preview');
    expect(video?.getAttribute('poster')).toContain('/thumbnail');
    expect(video?.autoplay).toBe(true);
    expect(video?.loop).toBe(true);
    expect(video?.muted).toBe(true);

    act(() => observer.notify(false));
    expect(container.querySelector('video')).toBeNull();
  });

  it('进出视口用两档阈值，贴边慢滚时不会反复挂载卸载', () => {
    const observer = stubIntersectionObserver();
    const { container } = render(<ResourceCard resource={makeVideo()} />);
    expect(observer.margins()).toEqual(['200px 0px']);

    act(() => observer.notify(true));
    expect(container.querySelector('video')).not.toBeNull();
    // 进入后换成更宽的阈值：要退到 600px 外才卸载，200–600px 之间不来回切
    expect(observer.margins()[observer.margins().length - 1]).toBe('600px 0px');

    act(() => observer.notify(false));
    expect(container.querySelector('video')).toBeNull();
    expect(observer.margins()[observer.margins().length - 1]).toBe('200px 0px');
  });

  it('MIME 是图片时不再当视频处理（脏数据防御）', () => {
    const { container } = render(
      <ResourceCard
        resource={makeResource({
          resourceType: ResourceType.video,
          mimeType: 'image/gif',
          originalFilename: 'clip.gif',
          extension: 'gif',
        })}
      />,
    );
    // resourceType 说是视频，但 MIME 是图片：按动图渲染，不能挂 <video>
    expect(container.querySelector('video')).toBeNull();
    expect(foreground(container)?.getAttribute('src')).toContain('/preview');
  });

  it('切换批量编辑模式重建缩略图容器后，会重新观察新节点', () => {
    const observer = stubIntersectionObserver();
    const resource = makeVideo();
    const { container, rerender } = render(<ResourceCard resource={resource} />);
    expect(observer.observe).toHaveBeenCalledTimes(1);

    // selectMode 下缩略图从 <Link> 里被换出来重建，observer 必须跟着换到新节点
    rerender(<ResourceCard resource={resource} selectMode />);
    expect(observer.observe).toHaveBeenCalledTimes(2);
    expect(observer.observe.mock.calls[1][0]).not.toBe(observer.observe.mock.calls[0][0]);
    // 旧节点上的 observer 必须断开，否则每次切换都会留一个孤儿
    expect(observer.disconnect).toHaveBeenCalled();

    act(() => observer.notify(true));
    expect(container.querySelector('video')).not.toBeNull();
  });

  it('视频播放失败时回退到缩略图，不会留下黑框', () => {
    const { container } = render(<ResourceCard resource={makeVideo()} />);
    fireEvent.error(container.querySelector('video')!);
    expect(container.querySelector('video')).toBeNull();
    expect(foreground(container)?.getAttribute('src')).toContain('/thumbnail');
  });

  it('远端 GIF 原图加载失败时回退为类型图标，不会卡在空白占位', () => {
    const { container } = render(
      <ResourceCard
        resource={makeResource({
          originalFilename: 'remote.gif',
          mimeType: 'image/gif',
          extension: 'gif',
          acquisitionMode: AcquisitionMode.metadata_only,
          previewUrl: 'https://cdn.example.com/remote.gif',
        })}
      />,
    );
    // 远端动图没有静态缩略图，只有前景一张图
    fireEvent.error(foreground(container)!);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelector('.animate-pulse')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('没有本地缩略图的视频（远端资源）也能自动播放', () => {
    const { container } = render(
      <ResourceCard
        resource={makeVideo({
          originalFilename: 'remote.mp4',
          acquisitionMode: AcquisitionMode.metadata_only,
          downloadUrl: 'https://cdn.example.com/remote.mp4',
        })}
      />,
    );
    // 远端资源没有本地缩略图，视频元素直接接管缩略图位置
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelector('video')?.getAttribute('src')).toBe(
      'https://cdn.example.com/remote.mp4',
    );
  });

  it('远端视频有独立缩略图时用缩略图作封面、仍用下载地址播放', () => {
    const { container } = render(
      <ResourceCard
        resource={makeVideo({
          originalFilename: 'episode.mp4',
          acquisitionMode: AcquisitionMode.metadata_only,
          previewUrl: 'https://cdn.example.com/episode-thumb.jpg',
          downloadUrl: 'https://cdn.example.com/episode.mp4',
        })}
      />,
    );
    const video = container.querySelector('video');
    // 缩略图是 jpg，不能当视频源；播放仍走真实的下载地址
    expect(video?.getAttribute('src')).toBe('https://cdn.example.com/episode.mp4');
    expect(video?.getAttribute('poster')).toBe('https://cdn.example.com/episode-thumb.jpg');
  });

  it('远端音频有独立缩略图时显示封面图', () => {
    const { container } = render(
      <ResourceCard
        resource={makeResource({
          resourceType: ResourceType.audio,
          mimeType: 'audio/mpeg',
          originalFilename: 'episode.mp3',
          extension: 'mp3',
          acquisitionMode: AcquisitionMode.metadata_only,
          previewUrl: 'https://cdn.example.com/episode-cover.jpg',
          downloadUrl: 'https://cdn.example.com/episode.mp3',
        })}
      />,
    );
    expect(foreground(container)?.getAttribute('src')).toBe(
      'https://cdn.example.com/episode-cover.jpg',
    );
  });

  it('非视觉资源不渲染缩略图，直接显示类型图标', () => {
    const { container } = render(
      <ResourceCard
        resource={makeResource({ resourceType: ResourceType.text, mimeType: 'text/plain' })}
      />,
    );
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('ResourceCard 收藏标记', () => {
  it('已收藏的资源在标题旁显示标记，未收藏不显示', () => {
    const favorited = render(<ResourceCard resource={makeResource({ isFavorite: true })} />);
    expect(favorited.container.querySelector('svg[aria-label="已收藏"]')).not.toBeNull();

    const plain = render(<ResourceCard resource={makeResource()} />);
    expect(plain.container.querySelector('svg[aria-label="已收藏"]')).toBeNull();
  });
});

describe('ResourceCard 用于设计', () => {
  it('图片卡片提供设计入口并指向一句话生成页', () => {
    const { container } = render(<ResourceCard resource={makeResource()} />);
    const link = container.querySelector('a[title="用于设计"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/design-library?resource=res-1');
  });

  it('视频卡片同样提供设计入口', () => {
    const { container } = render(<ResourceCard resource={makeVideo()} />);
    expect(container.querySelector('a[title="用于设计"]')).not.toBeNull();
  });

  it('非图片/视频不显示设计入口', () => {
    const { container } = render(
      <ResourceCard
        resource={makeResource({
          resourceType: ResourceType.audio,
          mimeType: 'audio/mpeg',
          originalFilename: 'sound.mp3',
          extension: 'mp3',
        })}
      />,
    );
    expect(container.querySelector('a[title="用于设计"]')).toBeNull();
  });
});
