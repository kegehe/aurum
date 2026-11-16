import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => {
  const replace = vi.fn();
  const push = vi.fn();
  const back = vi.fn();
  return {
    replace,
    push,
    back,
    router: { replace, push, back },
    searchParams: new URLSearchParams(''),
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => mocks.router,
  usePathname: () => '/resources',
  useSearchParams: () => mocks.searchParams,
}));

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

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/lib/api/resources', () => ({
  listResources: vi.fn(),
  listResourceIds: vi.fn(),
  batchDeleteResources: vi.fn(),
  batchMirrorResources: vi.fn(),
  batchSetResourceCategory: vi.fn(),
  batchSetResourceFavorite: vi.fn(),
  canStreamZipToDisk: () => false,
  downloadResourcesZip: vi.fn(),
  restoreResource: vi.fn(),
  softDeleteResource: vi.fn(),
}));

vi.mock('@/lib/api/categories', () => ({
  listCategories: vi.fn(),
  createCategory: vi.fn(),
  deleteCategory: vi.fn(),
  updateCategory: vi.fn(),
}));

import { batchMirrorResources, listResourceIds, listResources } from '@/lib/api/resources';
import { listCategories } from '@/lib/api/categories';
import { toast } from 'sonner';
import { filterSignature, filtersFromSearchParams } from '@/lib/resource-filters';
import { writeViewMemory } from '@/lib/view-memory';
import ResourcesPage from './page';

describe('资源库只看收藏', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchParams = new URLSearchParams('');
    window.sessionStorage.clear();
    // 空结果：只验证筛选参数的传递，不触发缩略图/预览等重资源
    vi.mocked(listResources).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 50,
      totalPages: 0,
    });
    vi.mocked(listCategories).mockResolvedValue({ items: [] });
  });

  it('开启后请求带 isFavorite，并写进可分享的 URL', async () => {
    render(<ResourcesPage />);

    await waitFor(() => expect(listResources).toHaveBeenCalled());
    expect(vi.mocked(listResources).mock.calls.at(-1)?.[0]?.isFavorite).toBeUndefined();

    await userEvent.click(screen.getByRole('button', { name: /只看收藏/ }));

    await waitFor(() => {
      expect(vi.mocked(listResources).mock.calls.at(-1)?.[0]).toMatchObject({
        isFavorite: true,
        page: 1,
      });
    });
    // 收藏跨文件夹：URL 明确落到全库，刷新/分享后不会退回根目录
    await waitFor(() => {
      expect(mocks.replace).toHaveBeenCalled();
      const [url, options] = mocks.replace.mock.calls.at(-1) as [string, { scroll?: boolean }];
      const params = new URLSearchParams(url.replace(/^\?/, ''));
      expect(params.get('favorite')).toBe('true');
      expect(params.get('scope')).toBe('all');
      expect(options).toEqual({ scroll: false });
    });
  });

  it('在文件夹里开启时清掉文件夹筛选，退出后回到原文件夹', async () => {
    mocks.searchParams = new URLSearchParams('categoryId=c1');
    render(<ResourcesPage />);

    // 进入的是文件夹 A
    await waitFor(() =>
      expect(vi.mocked(listResources).mock.calls.at(-1)?.[0]).toMatchObject({ categoryId: 'c1' }),
    );

    await userEvent.click(screen.getByRole('button', { name: /只看收藏/ }));

    // 收藏视图必须跨文件夹：只带 isFavorite，不再带 categoryId / uncategorized，
    // 否则只能看到文件夹 A 里的收藏（用户会以为其它收藏丢了）。
    await waitFor(() => {
      const params = vi.mocked(listResources).mock.calls.at(-1)?.[0];
      expect(params).toMatchObject({ isFavorite: true, page: 1 });
      expect(params?.categoryId).toBeUndefined();
      expect(params?.uncategorized).toBeUndefined();
    });
    await waitFor(() => {
      const [url] = mocks.replace.mock.calls.at(-1) as [string, { scroll?: boolean }];
      const params = new URLSearchParams(url.replace(/^\?/, ''));
      expect(params.get('favorite')).toBe('true');
      expect(params.get('scope')).toBe('all');
      expect(params.get('categoryId')).toBeNull();
    });

    // 退出收藏视图：回到进入前的文件夹，而不是把用户丢在全库视图
    await userEvent.click(screen.getByRole('button', { name: /只看收藏/ }));
    await waitFor(() => {
      const params = vi.mocked(listResources).mock.calls.at(-1)?.[0];
      expect(params).toMatchObject({ categoryId: 'c1' });
      expect(params?.isFavorite).toBeUndefined();
    });
  });
});

describe('资源库位置记忆', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchParams = new URLSearchParams('');
    window.sessionStorage.clear();
    vi.mocked(listResources).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 50,
      totalPages: 0,
    });
    vi.mocked(listCategories).mockResolvedValue({ items: [] });
  });

  it('URL 未规范化（缺省 scope）时仍能按同一组筛选恢复页码', async () => {
    // 上一次离开时 URL 已被规范化，记忆键基于规范化后的筛选签名。
    const normalized = filtersFromSearchParams(new URLSearchParams('resourceType=image'));
    writeViewMemory({ query: `${filterSignature(normalized)}|50`, page: 3, scrollY: 0 });

    // 这次从只带 resourceType 的入口进入：首帧 URL 与上次不同，但筛选条件等价。
    mocks.searchParams = new URLSearchParams('resourceType=image');
    render(<ResourcesPage />);

    await waitFor(() => {
      expect(vi.mocked(listResources).mock.calls.some(([params]) => params?.page === 3)).toBe(true);
    });
  });
});

describe('资源库批量下载到本地', () => {
  const resourceIds = Array.from({ length: 205 }, (_, index) => `remote-${index}`);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchParams = new URLSearchParams('');
    window.sessionStorage.clear();
    // 列表本身留空，避免渲染大量卡片；全选走独立的 IDs 接口
    vi.mocked(listResources).mockResolvedValue({
      items: [],
      total: resourceIds.length,
      page: 1,
      pageSize: 50,
      totalPages: 5,
    });
    vi.mocked(listCategories).mockResolvedValue({ items: [] });
    vi.mocked(listResourceIds).mockResolvedValue({ ids: resourceIds, total: resourceIds.length });
    vi.mocked(batchMirrorResources).mockImplementation(async (chunk) => ({
      resourceIds: chunk,
      queued: chunk.length,
      skipped: 0,
      skippedResources: [],
    }));
  });

  it('大选择集按分片提交并汇总入队数量', async () => {
    render(<ResourcesPage />);
    await waitFor(() => expect(listResources).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: /批量编辑/ }));
    await userEvent.click(screen.getByRole('button', { name: /全选当前目录/ }));

    await waitFor(() => {
      const button = screen.getByRole('button', { name: /下载到本地/ }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });
    const listCallsBeforeSubmit = vi.mocked(listResources).mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: /下载到本地/ }));

    await waitFor(() => expect(batchMirrorResources).toHaveBeenCalledTimes(3));
    expect(vi.mocked(batchMirrorResources).mock.calls.map(([chunk]) => chunk.length)).toEqual([
      100, 100, 5,
    ]);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('已加入下载队列 205 个资源'));
    // 成功后也要刷新列表
    await waitFor(() =>
      expect(vi.mocked(listResources).mock.calls.length).toBeGreaterThan(listCallsBeforeSubmit),
    );
  });

  it('后续分片失败时保留已入队数量并刷新列表', async () => {
    vi.mocked(batchMirrorResources)
      .mockResolvedValueOnce({
        resourceIds: resourceIds.slice(0, 100),
        queued: 100,
        skipped: 0,
        skippedResources: [],
      })
      .mockRejectedValueOnce(new Error('网络中断'));

    render(<ResourcesPage />);
    await waitFor(() => expect(listResources).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: /批量编辑/ }));
    await userEvent.click(screen.getByRole('button', { name: /全选当前目录/ }));
    await waitFor(() => {
      const button = screen.getByRole('button', { name: /下载到本地/ }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });
    const listCallsBeforeSubmit = vi.mocked(listResources).mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: /下载到本地/ }));

    // 已成功的批次数量要保留，并提示后续批次失败
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        '已加入下载队列 100 个资源，后续批次提交失败',
        expect.objectContaining({ description: expect.stringContaining('网络中断') }),
      ),
    );
    // 失败路径也要刷新列表，让已入队的任务反映出来
    await waitFor(() =>
      expect(vi.mocked(listResources).mock.calls.length).toBeGreaterThan(listCallsBeforeSubmit),
    );
  });
});
