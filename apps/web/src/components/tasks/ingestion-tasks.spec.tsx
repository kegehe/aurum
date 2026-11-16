import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IngestionJobStatus, IngestionJobType } from '@aurum/shared-types';

const mocks = vi.hoisted(() => ({
  listIngestionJobs: vi.fn(),
  getIngestionJobStats: vi.fn(),
  cancelIngestionJob: vi.fn(),
  clearIngestionJobs: vi.fn(),
  deleteIngestionJob: vi.fn(),
  retryIngestionJob: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock('@/lib/api/ingestion', () => ({
  listIngestionJobs: mocks.listIngestionJobs,
  getIngestionJobStats: mocks.getIngestionJobStats,
  cancelIngestionJob: mocks.cancelIngestionJob,
  clearIngestionJobs: mocks.clearIngestionJobs,
  deleteIngestionJob: mocks.deleteIngestionJob,
  retryIngestionJob: mocks.retryIngestionJob,
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => mocks.searchParams,
}));

import IngestionTasks from './ingestion-tasks';

const stats = { pending: 0, processing: 0, completed: 0, failed: 0, canceled: 0 };

function makeJobs(count: number, offset: number) {
  return Array.from({ length: count }, (_, index) => {
    const id = offset + index;
    return {
      id: `job-${id}`,
      sourceId: null,
      resourceId: null,
      jobType: IngestionJobType.import_url,
      status: IngestionJobStatus.completed,
      request: JSON.stringify({ url: `https://example.com/${id}` }),
      result: null,
      retryCount: 0,
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: null,
      resource: null,
      source: null,
    };
  });
}

describe('IngestionTasks 分页', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getIngestionJobStats.mockResolvedValue(stats);
  });

  // 与处理任务同一个坑：清空/删除后当前页可能越界，不能卡在空页。
  it('当前页越界时自动回到最后一个有效页', async () => {
    let total = 25;
    mocks.listIngestionJobs.mockImplementation(({ page }: { page: number; pageSize: number }) => {
      const start = (page - 1) * 20;
      const count = Math.max(0, Math.min(20, total - start));
      return Promise.resolve({
        items: makeJobs(count, start),
        total,
        page,
        pageSize: 20,
        totalPages: Math.ceil(total / 20),
      });
    });

    render(<IngestionTasks />);
    expect(await screen.findByText('共 25 个任务')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(await screen.findByText('2 / 2')).toBeInTheDocument();

    total = 5;
    await userEvent.click(screen.getByRole('button', { name: '刷新' }));

    await waitFor(() => expect(screen.getByText('1 / 1')).toBeInTheDocument());
    expect(screen.getByText('共 5 个任务')).toBeInTheDocument();
    expect(screen.queryByText('暂无导入任务')).not.toBeInTheDocument();
    // 不能只改页码：必须真的重新拉取第 1 页，且第 2 页的旧行不能残留
    expect(mocks.listIngestionJobs).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }));
    expect(await screen.findByText('https://example.com/0')).toBeInTheDocument();
    expect(screen.queryByText('https://example.com/20')).not.toBeInTheDocument();
  });
});

describe('IngestionTasks 停止任务', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getIngestionJobStats.mockResolvedValue({ ...stats, pending: 1, processing: 1 });
  });

  // 后端 cancelJob 允许 pending 与 processing；排队中的任务不能只能干等。
  it('待处理与处理中的任务都能取消，且调用取消接口', async () => {
    const pending = {
      ...makeJobs(1, 0)[0],
      id: 'job-pending',
      status: IngestionJobStatus.pending,
      jobType: IngestionJobType.download_file,
    };
    const processing = {
      ...makeJobs(1, 1)[0],
      id: 'job-processing',
      status: IngestionJobStatus.processing,
      jobType: IngestionJobType.sync_source,
    };
    mocks.listIngestionJobs.mockResolvedValue({
      items: [pending, processing],
      total: 2,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });
    mocks.cancelIngestionJob.mockResolvedValue({
      ...pending,
      status: IngestionJobStatus.canceled,
    });

    render(<IngestionTasks />);

    // 处理中沿用「停止任务」，待处理新增「取消排队」
    expect(await screen.findByRole('button', { name: '停止任务' })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: '取消排队' }));

    await waitFor(() => expect(mocks.cancelIngestionJob).toHaveBeenCalledWith('job-pending'));
  });
});
