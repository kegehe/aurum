import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getConsistencyReport } from '@/lib/api/consistency';
import type { StorageConsistencyReport } from '@/lib/types';
import ConsistencyPage from './page';

vi.mock('@/lib/api/consistency', () => ({
  getConsistencyReport: vi.fn(),
}));

const CHECKED_AT = '2026-10-27T08:00:00.000Z';

const ISSUE_REPORT: StorageConsistencyReport = {
  checkedAt: CHECKED_AT,
  databaseFileCount: 12,
  storageFileCount: 14,
  missingStorageFiles: ['large/2026/10/missing.png'],
  orphanStorageFiles: ['orphan/leftover.bin'],
  expiredTempFiles: ['temp/stale-upload.zip'],
  summary: {
    missingStorageFiles: 1,
    orphanStorageFiles: 1,
    expiredTempFiles: 1,
  },
};

const CLEAN_REPORT: StorageConsistencyReport = {
  checkedAt: CHECKED_AT,
  databaseFileCount: 2,
  storageFileCount: 2,
  missingStorageFiles: [],
  orphanStorageFiles: [],
  expiredTempFiles: [],
  summary: {
    missingStorageFiles: 0,
    orphanStorageFiles: 0,
    expiredTempFiles: 0,
  },
};

describe('存储一致性页面', () => {
  beforeEach(() => {
    vi.mocked(getConsistencyReport).mockResolvedValue(ISSUE_REPORT);
  });

  it('打开页面自动检查并列出三类问题', async () => {
    render(<ConsistencyPage />);

    expect(await screen.findByText('发现 3 个待处理文件')).toBeInTheDocument();
    expect(screen.getByText('large/2026/10/missing.png')).toBeInTheDocument();
    expect(screen.getByText('orphan/leftover.bin')).toBeInTheDocument();
    expect(screen.getByText('temp/stale-upload.zip')).toBeInTheDocument();
    expect(screen.getByText('数据库记录')).toBeInTheDocument();
    expect(screen.getByText('存储文件')).toBeInTheDocument();
    expect(vi.mocked(getConsistencyReport)).toHaveBeenCalledTimes(1);
  });

  it('没有问题时展示一致状态，不渲染问题列表', async () => {
    vi.mocked(getConsistencyReport).mockResolvedValue(CLEAN_REPORT);

    render(<ConsistencyPage />);

    expect(await screen.findByText('未发现不一致')).toBeInTheDocument();
    expect(screen.getByText(/数据库中的 2 条文件记录都能在存储中找到/)).toBeInTheDocument();
    expect(screen.queryByText('所有数据库记录都能在存储中找到对应文件。')).not.toBeInTheDocument();
  });

  it('检查失败时可以重试', async () => {
    vi.mocked(getConsistencyReport)
      .mockRejectedValueOnce(new Error('存储不可用'))
      .mockResolvedValueOnce(CLEAN_REPORT);

    render(<ConsistencyPage />);

    expect(await screen.findByText('存储不可用')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(await screen.findByText('未发现不一致')).toBeInTheDocument();
    expect(vi.mocked(getConsistencyReport)).toHaveBeenCalledTimes(2);
  });

  it('点击重新检查会再次请求', async () => {
    render(<ConsistencyPage />);

    await screen.findByText('发现 3 个待处理文件');
    await userEvent.click(screen.getByRole('button', { name: /重新检查/ }));

    expect(vi.mocked(getConsistencyReport)).toHaveBeenCalledTimes(2);
  });
});
