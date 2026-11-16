import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JobStatus, JobType } from '@aurum/shared-types';

const mocks = vi.hoisted(() => ({
  listProcessingJobs: vi.fn(),
  getProcessingStats: vi.fn(),
  cancelProcessingJob: vi.fn(),
  clearProcessingJobs: vi.fn(),
  deleteProcessingJob: vi.fn(),
  retryJob: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock('@/lib/api/processing', () => ({
  listProcessingJobs: mocks.listProcessingJobs,
  getProcessingStats: mocks.getProcessingStats,
  cancelProcessingJob: mocks.cancelProcessingJob,
  clearProcessingJobs: mocks.clearProcessingJobs,
  deleteProcessingJob: mocks.deleteProcessingJob,
  retryJob: mocks.retryJob,
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => mocks.searchParams,
}));

import ProcessingTasks from './processing-tasks';

const stats = { pending: 0, processing: 0, completed: 0, failed: 0, canceled: 0 };

function makeJobs(count: number, offset: number) {
  return Array.from({ length: count }, (_, index) => {
    const id = offset + index;
    return {
      id: `job-${id}`,
      // 列表里展示 resourceId 的前 8 位，用这个前缀区分第 1/2 页的数据
      resourceId: `res-${String(id).padStart(4, '0')}`,
      jobType: JobType.detect_metadata,
      status: JobStatus.completed,
      errorMessage: null,
      retryCount: 0,
      startedAt: null,
      finishedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  });
}

describe('ProcessingTasks 分页', () => {
  beforeEach(() => {
    mocks.getProcessingStats.mockResolvedValue(stats);
  });

  // 清空/删除后总数变少，当前页可能越界。此前会停在空页且分页栏消失，
  // 表现为「任务还在，但列表显示暂无任务」。
  it('当前页越界时自动回到最后一个有效页', async () => {
    let total = 25;
    mocks.listProcessingJobs.mockImplementation(({ page }: { page: number; pageSize: number }) => {
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

    render(<ProcessingTasks />);
    expect(await screen.findByText('共 25 个任务')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(await screen.findByText('2 / 2')).toBeInTheDocument();

    // 模拟清空/删除后第 2 页已经没有数据，但第 1 页仍有 5 条
    total = 5;
    await userEvent.click(screen.getByRole('button', { name: '刷新' }));

    await waitFor(() => expect(screen.getByText('1 / 1')).toBeInTheDocument());
    expect(screen.getByText('共 5 个任务')).toBeInTheDocument();
    expect(screen.queryByText('暂无处理任务')).not.toBeInTheDocument();
    // 不能只改页码：必须真的重新拉取第 1 页，且第 2 页的旧行不能残留
    expect(mocks.listProcessingJobs).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }));
    expect(await screen.findByText('res-0000')).toBeInTheDocument();
    expect(screen.queryByText('res-0020')).not.toBeInTheDocument();
  });
});
