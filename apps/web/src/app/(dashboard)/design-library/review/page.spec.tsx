import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Candidate, DesignDocument, DesignKind } from '@/lib/api/design';
import {
  createDesignDocument,
  createDraft,
  getDesignDocument,
  listCandidatePreviews,
  listCandidates,
  listDesignDocuments,
  listDesignTasks,
  listReadyDrafts,
} from '@/lib/api/design';
import ReviewPage from './page';

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

vi.mock('@/lib/api/design', () => ({
  cancelDesignTask: vi.fn(),
  createCandidate: vi.fn(),
  createChangeSet: vi.fn(),
  createDesignDocument: vi.fn(),
  createDraft: vi.fn(),
  deleteCandidate: vi.fn(),
  exportDesignDocument: vi.fn(),
  getCandidatePreviewUrl: (id: string) => '/preview/' + id,
  getDesignDocument: vi.fn(),
  listCandidatePreviews: vi.fn(),
  listCandidates: vi.fn(),
  listDesignDocuments: vi.fn(),
  listDesignTasks: vi.fn(),
  listReadyDrafts: vi.fn(),
  publishChangeSet: vi.fn(),
  publishDraft: vi.fn(),
  queueAiCandidates: vi.fn(),
  renderAndValidateCandidate: vi.fn(),
  restoreDesignVersion: vi.fn(),
  retryDesignTask: vi.fn(),
  selectCandidate: vi.fn(),
}));

function makeDocument(id: string, name: string, kind: DesignKind): DesignDocument {
  return {
    id,
    slug: id,
    name,
    kind,
    status: 'published',
    currentPublishedVersionId: 'v-' + id,
    currentPublishedVersion: {
      id: 'v-' + id,
      versionNumber: 1,
      content: '{}',
      publishedAt: '2026-01-01T00:00:00.000Z',
    },
    versions: [],
  };
}

const THEME = makeDocument('doc-theme', '松石主题', 'theme');
const COMPONENT = makeDocument('doc-component', '玻璃卡片', 'component');

function mockCatalog(documents: DesignDocument[]) {
  vi.mocked(listDesignDocuments).mockResolvedValue(documents);
  vi.mocked(getDesignDocument).mockImplementation(async (id: string) =>
    documents.find((item) => item.id === id)!,
  );
  vi.mocked(listReadyDrafts).mockResolvedValue([]);
  vi.mocked(listDesignTasks).mockResolvedValue([]);
  vi.mocked(listCandidates).mockResolvedValue([]);
  vi.mocked(listCandidatePreviews).mockResolvedValue([]);
  vi.mocked(createDraft).mockResolvedValue({ id: 'draft-1' });
}

describe('审核台类型筛选', () => {
  beforeEach(() => {
    mockCatalog([THEME, COMPONENT]);
  });

  it('切换类型后右侧与按钮一起切到该类型的资产', async () => {
    render(<ReviewPage />);

    expect(await screen.findByRole('heading', { name: '松石主题' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '组件' }));

    expect(await screen.findByRole('heading', { name: '玻璃卡片' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '松石主题' })).not.toBeInTheDocument();

    // 关键：按钮操作的是新类型资产，不是切走前的那个
    await userEvent.click(screen.getByRole('button', { name: /创建草稿/ }));
    await waitFor(() => expect(vi.mocked(createDraft)).toHaveBeenCalledWith('doc-component'));
    expect(vi.mocked(createDraft)).not.toHaveBeenCalledWith('doc-theme');
  });

  it('切到没有资产的类型时右侧清空，不残留上一个类型的资产', async () => {
    render(<ReviewPage />);

    await screen.findByRole('heading', { name: '松石主题' });
    await userEvent.click(screen.getByRole('button', { name: '动画' }));

    expect(await screen.findByText(/该类型下还没有资产/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '松石主题' })).not.toBeInTheDocument();
    expect(screen.getByText('选择或新建设计资产')).toBeInTheDocument();
  });

  it('首屏没有当前筛选类型的资产时，筛选跟着数据切过去', async () => {
    mockCatalog([COMPONENT]);

    render(<ReviewPage />);

    expect(await screen.findByRole('heading', { name: '玻璃卡片' })).toBeInTheDocument();
  });

  it('切走草稿后到达的旧候选不会写进新草稿', async () => {
    let release: (value: Candidate[]) => void = () => undefined;
    let call = 0;
    vi.mocked(listCandidates).mockImplementation(() => {
      call += 1;
      return call === 1
        ? new Promise<Candidate[]>((resolve) => {
            release = resolve;
          })
        : Promise.resolve([]);
    });
    vi.mocked(createDraft)
      .mockResolvedValueOnce({ id: 'draft-theme' })
      .mockResolvedValueOnce({ id: 'draft-component' });

    render(<ReviewPage />);
    await screen.findByRole('heading', { name: '松石主题' });

    await userEvent.click(screen.getByRole('button', { name: /创建草稿/ }));
    expect(await screen.findByText('草稿候选')).toBeInTheDocument();

    // 切到另一个类型：草稿面板应整体消失，旧的轮询请求仍在途中
    await userEvent.click(screen.getByRole('button', { name: '组件' }));
    await screen.findByRole('heading', { name: '玻璃卡片' });
    expect(screen.queryByText('草稿候选')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /创建草稿/ }));
    expect(await screen.findByText('草稿候选')).toBeInTheDocument();

    // 旧草稿的候选晚到，不能出现在新草稿的候选列表里
    await act(async () => {
      release([{ id: 'old-candidate', label: '旧草稿候选', patch: '{}', status: 'validated' }]);
    });
    expect(screen.queryByText('旧草稿候选')).not.toBeInTheDocument();
  });

  it('新建表单保持打开时的类型，不随左栏切换而变', async () => {
    vi.mocked(createDesignDocument).mockResolvedValue(makeDocument('doc-new', '新主题', 'theme'));

    render(<ReviewPage />);
    await screen.findByRole('heading', { name: '松石主题' });

    await userEvent.click(screen.getByRole('button', { name: /新建（专业模式）/ }));
    await userEvent.click(screen.getByRole('button', { name: '组件' }));

    expect(screen.getByText('新建主题资产')).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('名称'), '新主题');
    await userEvent.type(screen.getByPlaceholderText('唯一 slug（小写连字符）'), 'new-theme');
    await userEvent.click(screen.getByRole('button', { name: /创建并发布初始版本/ }));

    await waitFor(() =>
      expect(vi.mocked(createDesignDocument)).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'theme', name: '新主题' }),
      ),
    );
  });
});

const PENDING_TASK = {
  id: 'task-1',
  taskType: 'render_validate',
  status: 'pending',
  retryCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('审核台轮询成本', () => {
  beforeEach(() => {
    mockCatalog([THEME]);
  });

  it('任务都结束后停止每 3 秒的轮询', async () => {
    vi.useFakeTimers();
    let taskCalls = 0;
    vi.mocked(listDesignTasks).mockImplementation(async () => {
      taskCalls += 1;
      // 前两次仍是 pending（草稿刚创建 + 一次轮询），之后全部结束
      return taskCalls <= 2 ? [PENDING_TASK] : [];
    });

    try {
      render(<ReviewPage />);
      await act(async () => {});

      fireEvent.click(screen.getByRole('button', { name: /创建草稿/ }));
      await act(async () => {});
      expect(screen.getByText('草稿候选')).toBeInTheDocument();

      // 有活跃任务：3 秒后应再拉一次
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(listDesignTasks).toHaveBeenCalledTimes(2);

      // 这一次拿到空任务列表，应该停掉轮询
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(listDesignTasks).toHaveBeenCalledTimes(3);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(listDesignTasks).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('预览只在候选校验结果变化时重取', async () => {
    vi.mocked(listCandidates).mockResolvedValue([
      {
        id: 'candidate-1',
        label: '候选 A',
        patch: '{}',
        status: 'validated',
        validationRuns: [
          { id: 'run-1', status: 'succeeded', createdAt: '2026-01-01T00:00:00.000Z' },
        ],
      },
    ]);
    vi.mocked(listCandidatePreviews).mockResolvedValue([]);

    render(<ReviewPage />);
    await screen.findByRole('heading', { name: '松石主题' });
    await userEvent.click(screen.getByRole('button', { name: /创建草稿/ }));
    await screen.findByText('草稿候选');
    await waitFor(() => expect(listCandidatePreviews).toHaveBeenCalledTimes(1));

    // 校验结果没变：手动刷新只重拉候选，不再逐个候选请求预览
    await userEvent.click(screen.getByRole('button', { name: '刷新任务' }));
    await waitFor(() => expect(listCandidates).toHaveBeenCalledTimes(2));
    expect(listCandidatePreviews).toHaveBeenCalledTimes(1);
  });

  it('预览请求失败不会写进缓存，下一次刷新会重试', async () => {
    vi.mocked(listCandidates).mockResolvedValue([
      {
        id: 'candidate-1',
        label: '候选 A',
        patch: '{}',
        status: 'validated',
        validationRuns: [
          { id: 'run-1', status: 'succeeded', createdAt: '2026-01-01T00:00:00.000Z' },
        ],
      },
    ]);
    vi.mocked(listCandidatePreviews)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue([]);

    render(<ReviewPage />);
    await screen.findByRole('heading', { name: '松石主题' });
    await userEvent.click(screen.getByRole('button', { name: /创建草稿/ }));
    await screen.findByText('草稿候选');
    await waitFor(() => expect(listCandidatePreviews).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: '刷新任务' }));
    await waitFor(() => expect(listCandidatePreviews).toHaveBeenCalledTimes(2));
  });
});
