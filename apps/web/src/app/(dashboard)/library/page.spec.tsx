import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AssetSummary } from '@/lib/api/assets';
import { listAssets } from '@/lib/api/assets';
import LibraryPage from './page';

// next/link 依赖 App Router 上下文，单测里替换成普通 <a>
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

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/lib/api/assets', () => ({
  listAssets: vi.fn(),
  listAssetVersions: vi.fn(),
  getAsset: vi.fn(),
  getAssetPreview: vi.fn(),
  getAssetExport: vi.fn(),
  diffAssetVersions: vi.fn(),
  archiveAsset: vi.fn(),
  captureAssetSnapshot: vi.fn(),
  seedSampleAsset: vi.fn(),
  toggleAssetFavorite: vi.fn(),
  assetCoverUrl: (id: string) => '/covers/' + id,
}));

function makeAsset(id: string, name: string): AssetSummary {
  return {
    id,
    slug: id,
    name,
    kind: 'component',
    subtype: null,
    description: null,
    format: 'package',
    status: 'published',
    favorite: false,
    tags: [],
    hasCover: false,
    coverStatus: 'succeeded',
    coverError: null,
    palette: [],
    states: [],
    tokens: [],
    version: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const FIRST_PAGE = Array.from({ length: 24 }, (_, index) =>
  makeAsset('a' + index, 'Asset ' + index),
);

function mockPages() {
  vi.mocked(listAssets).mockImplementation(async (params) => {
    if (!params.cursor) return { items: FIRST_PAGE, nextCursor: 'a23' };
    return { items: [makeAsset('b1', 'Asset 第25个')], nextCursor: null };
  });
}

describe('资产库分页', () => {
  beforeEach(() => {
    mockPages();
  });

  it('超过 24 个资产时可以继续加载', async () => {
    render(<LibraryPage />);

    expect(await screen.findAllByText('Asset 0')).not.toHaveLength(0);
    expect(screen.queryAllByText('Asset 第25个')).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: /加载更多/ }));

    expect(await screen.findAllByText('Asset 第25个')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: /加载更多/ })).not.toBeInTheDocument();
    expect(vi.mocked(listAssets).mock.calls.map((call) => call[0].cursor)).toEqual([
      undefined,
      'a23',
    ]);
  });

  it('打开只看收藏后请求带 favorite=true，并重置游标', async () => {
    render(<LibraryPage />);
    await screen.findAllByText('Asset 0');

    await userEvent.click(screen.getByRole('button', { name: /只看收藏/ }));

    await waitFor(() => {
      const lastCall = vi.mocked(listAssets).mock.calls.at(-1)?.[0];
      expect(lastCall?.favorite).toBe('true');
      expect(lastCall?.cursor).toBeUndefined();
    });
  });

  it('切换筛选后从第一页重新开始，不会沿用旧游标', async () => {
    render(<LibraryPage />);

    await screen.findAllByText('Asset 0');
    await userEvent.click(screen.getByRole('button', { name: /加载更多/ }));
    await screen.findAllByText('Asset 第25个');

    await userEvent.type(screen.getByPlaceholderText('搜索名称、slug、描述'), '按钮');

    await waitFor(() => {
      const lastCall = vi.mocked(listAssets).mock.calls.at(-1)?.[0];
      expect(lastCall?.cursor).toBeUndefined();
      expect(lastCall?.q).toBe('按钮');
    });
    expect(await screen.findByRole('button', { name: /加载更多/ })).toBeInTheDocument();
  });

  it('封面轮询刷新时保留已加载的分页，不会截回第一页', async () => {
    vi.mocked(listAssets).mockImplementation(async (params) => {
      if (!params.cursor) {
        return {
          items: [{ ...FIRST_PAGE[0], coverStatus: 'pending' as const }, ...FIRST_PAGE.slice(1)],
          nextCursor: 'a23',
        };
      }
      return { items: [makeAsset('b1', 'Asset 第25个')], nextCursor: null };
    });

    render(<LibraryPage />);

    await screen.findAllByText('Asset 0');
    await userEvent.click(screen.getByRole('button', { name: /加载更多/ }));
    await screen.findAllByText('Asset 第25个');

    // 轮询会把已加载的两页都刷一遍（第二次带 cursor 的请求来自静默刷新）
    await waitFor(
      () => {
        const cursorCalls = vi
          .mocked(listAssets)
          .mock.calls.filter((call) => call[0].cursor === 'a23');
        expect(cursorCalls.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 4000 },
    );
    expect(screen.getAllByText('Asset 第25个')).not.toHaveLength(0);
  });
});
