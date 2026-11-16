import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import type { DesignDocument, DesignRecipeSummary } from '@/lib/api/design';
import {
  composeDesignGenerate,
  composeDesignRecipe,
  getDesignTask,
  listDesignDocuments,
  listDesignRecipes,
} from '@/lib/api/design';
import DesignWizardPage from './page';

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
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/lib/api/style', () => ({ analyzeStyle: vi.fn() }));

vi.mock('@/lib/api/design', () => ({
  listDesignDocuments: vi.fn(),
  listDesignRecipes: vi.fn(),
  composeDesignRecipe: vi.fn(),
  composeDesignPreview: vi.fn(),
  composeDesignGenerate: vi.fn(),
  composeDesignPublish: vi.fn(),
  getDesignTask: vi.fn(),
}));

function makeTheme(id: string, name: string): DesignDocument {
  return {
    id,
    slug: id,
    name,
    kind: 'theme',
    status: 'published',
    currentPublishedVersionId: 'v-' + id,
    currentPublishedVersion: {
      id: 'v-' + id,
      versionNumber: 1,
      content: '{}',
      publishedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

const PALETTE_RECIPE: DesignRecipeSummary = {
  id: 'aurora',
  name: '极光',
  blurb: '冷色渐变',
  category: 'palette',
  kind: 'theme',
};

/** 「现成的效果」里的配方芯片与「内置配色」里的同名芯片重名，按区块定位。 */
function recipeList() {
  const section = screen.getByText('现成的效果').closest('section');
  if (!section) throw new Error('找不到“现成的效果”区块');
  return within(section as HTMLElement);
}

describe('高级模式默认配色', () => {
  beforeEach(() => {
    vi.mocked(listDesignDocuments).mockResolvedValue([
      makeTheme('t1', '暖阳'),
      makeTheme('t2', '冷夜'),
    ]);
    vi.mocked(listDesignRecipes).mockResolvedValue([PALETTE_RECIPE]);
    vi.mocked(composeDesignGenerate).mockResolvedValue({ taskId: 'task-1' });
    vi.mocked(getDesignTask).mockResolvedValue({
      id: 'task-1',
      taskType: 'generate',
      status: 'failed',
      retryCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      errorMessage: '测试里不跑生成',
    });
  });

  it('资产库里已有配色时自动选中第一套，不再误报"还没有配色"', async () => {
    render(<DesignWizardPage />);

    expect(await screen.findByRole('button', { name: '暖阳' })).toBeInTheDocument();
    // 数据已到位，此刻就该没有红字——用 waitFor 会掩盖"先闪一下再消失"的回归。
    expect(screen.queryByText(/还没有配色/)).not.toBeInTheDocument();
    expect(screen.getByText(/颜色、圆角、间距都从这套配色里取/)).toBeInTheDocument();
  });

  it('不用手动点配色芯片也能直接生成', async () => {
    render(<DesignWizardPage />);

    await screen.findByRole('button', { name: '暖阳' });
    await userEvent.type(screen.getByPlaceholderText(/做一个毛玻璃卡片/), '磨砂卡片');
    await userEvent.click(screen.getByRole('button', { name: /生成 3 个方案/ }));

    await waitFor(() => {
      expect(composeDesignGenerate).toHaveBeenCalledWith(
        expect.objectContaining({ intent: '磨砂卡片', themeDocumentId: 't1' }),
      );
    });
  });

  it('配色没挑配方时先讲清怎么起手，不把注定失败的请求发出去', async () => {
    render(<DesignWizardPage />);

    await screen.findByRole('button', { name: '暖阳' });
    await userEvent.click(screen.getByRole('button', { name: '配色' }));

    // 提示摆在按钮上方：用户点之前就知道要先去挑一个配方
    expect(screen.getByText(/「现成的效果」里选中的配方为起点/)).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText(/做一个毛玻璃卡片/), '一套冷色调');
    await userEvent.click(screen.getByRole('button', { name: /生成 3 个方案/ }));

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(expect.stringContaining('点一个配方'));
    expect(composeDesignGenerate).not.toHaveBeenCalled();
  });

  it('挑了配方就能生成配色，且不把当前配色钉成依赖', async () => {
    vi.mocked(composeDesignRecipe).mockResolvedValue({
      content: {},
      css: '',
      html: '',
      tokensUsed: [],
      skippedTokens: [],
      controls: [],
      applied: [],
      skipped: [],
      gate: { passed: true, errors: [], contrasts: [], undeterminable: [] },
      kind: 'theme',
    });

    render(<DesignWizardPage />);

    await screen.findByRole('button', { name: '暖阳' });
    await userEvent.click(screen.getByRole('button', { name: '配色' }));
    await userEvent.click(recipeList().getByRole('button', { name: '极光' }));

    await waitFor(() => {
      expect(screen.queryByText(/「现成的效果」里选中的配方为起点/)).not.toBeInTheDocument();
    });

    await userEvent.type(screen.getByPlaceholderText(/做一个毛玻璃卡片/), '一套冷色调');
    await userEvent.click(screen.getByRole('button', { name: /生成 3 个方案/ }));

    await waitFor(() => {
      expect(composeDesignGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'theme',
          recipeId: 'aurora',
          themeDocumentId: undefined,
        }),
      );
    });
  });

  it('列表还在加载时不抢先报"还没有配色"，点生成也给出加载中的说法', async () => {
    vi.mocked(listDesignDocuments).mockReturnValue(new Promise(() => {}));
    vi.mocked(listDesignRecipes).mockReturnValue(new Promise(() => {}));

    render(<DesignWizardPage />);

    expect(screen.queryByText(/还没有配色/)).not.toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText(/做一个毛玻璃卡片/), '磨砂卡片');
    await userEvent.click(screen.getByRole('button', { name: /生成 3 个方案/ }));

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(expect.stringContaining('还没加载出来'));
    expect(composeDesignGenerate).not.toHaveBeenCalled();
  });

  it('库里一套配色都没有时才提示去安装', async () => {
    vi.mocked(listDesignDocuments).mockResolvedValue([]);

    render(<DesignWizardPage />);

    expect(await screen.findByText(/还没有配色/)).toBeInTheDocument();
  });
});
