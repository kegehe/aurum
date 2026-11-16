import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import type { UploadOptions } from '@/lib/api-client';
import type { BatchUploadResult, UploadResult } from '@/lib/types';
import { uploadBatch, uploadFile } from '@/lib/api/upload';
import UploadPage from './page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/api/categories', () => ({
  listCategories: vi.fn(async () => ({ items: [] })),
  createCategory: vi.fn(),
}));

vi.mock('@/lib/api/upload', () => ({
  uploadFile: vi.fn(),
  uploadBatch: vi.fn(),
}));

/** 选一个文件并点“开始上传” */
async function pickAndUpload(name = 'big.bin', size = 1024) {
  const user = userEvent.setup();
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(input, new File([new Uint8Array(size)], name));
  await user.click(screen.getByRole('button', { name: /开始上传/ }));
  return user;
}

/** 上传替身：把 options 暴露出来，并在信号 abort 时以 AbortError 拒绝 */
function stubPendingUpload() {
  let captured: UploadOptions | undefined;
  vi.mocked(uploadFile).mockImplementation(
    (_file, _meta, options) =>
      new Promise((_resolve, reject) => {
        captured = options;
        options?.signal?.addEventListener('abort', () =>
          reject(new DOMException('上传已取消', 'AbortError')),
        );
      }),
  );
  return () => captured;
}


/** 造一个上传成功返回的资源（只用到 id，其余字段补齐类型） */
function fakeResource(id: string): UploadResult['resource'] {
  return {
    id,
    title: id,
    resourceType: 'document',
    mimeType: 'application/octet-stream',
    sizeBytes: '10',
    sha256: null,
    processingStatus: 'pending',
    isDuplicate: false,
    duplicateOfId: null,
  };
}

describe('上传页进度与取消', () => {
  beforeEach(() => {
    render(<UploadPage />);
  });

  it('上传中显示百分比与取消按钮，而不是只有一个转圈', async () => {
    const options = stubPendingUpload();
    await pickAndUpload();

    await waitFor(() => expect(screen.getByRole('button', { name: /取消/ })).toBeInTheDocument());

    // 传一半：头部与行内都应出现 50%
    act(() => {
      options()?.onProgress?.({ loaded: 512, total: 1024 });
    });

    expect(screen.getAllByText('50%').length).toBeGreaterThanOrEqual(2);
  });

  it('取消后中断请求，文件退回待上传', async () => {
    const options = stubPendingUpload();
    const user = await pickAndUpload();

    await waitFor(() => expect(screen.getByRole('button', { name: /取消/ })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /取消/ }));

    await waitFor(() => expect(options()?.signal?.aborted).toBe(true));
    // 取消不算失败：可以重新开始，而不是标红
    await waitFor(() => expect(screen.getByRole('button', { name: /开始上传/ })).toBeInTheDocument());
    expect(toast.info).toHaveBeenCalledWith('已取消上传');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('多个文件走批量接口：按字节偏移显示各自进度，取消后整批退回待上传', async () => {
    let captured: UploadOptions | undefined;
    vi.mocked(uploadBatch).mockImplementation(
      (_files, _meta, options) =>
        new Promise((_resolve, reject) => {
          captured = options;
          options?.signal?.addEventListener('abort', () =>
            reject(new DOMException('上传已取消', 'AbortError')),
          );
        }),
    );

    const user = userEvent.setup();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, [
      new File([new Uint8Array(512)], 'a.bin'),
      new File([new Uint8Array(512)], 'b.bin'),
    ]);
    await user.click(screen.getByRole('button', { name: /开始上传/ }));

    await waitFor(() => expect(screen.getByRole('button', { name: /取消/ })).toBeInTheDocument());

    // 传完第一个文件（512B）：第一个 100%，第二个 0%，整轮 50%
    act(() => {
      captured?.onProgress?.({ loaded: 512, total: 1024 });
    });
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /取消/ }));

    await waitFor(() => expect(captured?.signal?.aborted).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: /开始上传/ })).toBeInTheDocument());
    expect(screen.queryByText(/上传中/)).not.toBeInTheDocument();
  });

  it('21 个文件分两批：第一批完成即变绿，第二批继续上传', async () => {
    let resolveSecond: ((value: BatchUploadResult) => void) | undefined;
    vi.mocked(uploadBatch)
      .mockResolvedValueOnce({
        results: Array.from({ length: 20 }, (_, i) => ({
          success: true as const,
          resource: fakeResource(`r${i}`),
        })),
      })
      .mockImplementationOnce(
        () => new Promise<BatchUploadResult>((resolve) => { resolveSecond = resolve; }),
      );

    const user = userEvent.setup();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const files = Array.from({ length: 21 }, (_, i) => new File([new Uint8Array(10)], `f${i}.bin`));
    await user.upload(input, files);
    await user.click(screen.getByRole('button', { name: /开始上传/ }));

    // 第一批已落库：不能等整轮结束才变绿
    await waitFor(() => expect(screen.getAllByText('查看资源 →').length).toBe(20));
    expect(screen.getByRole('button', { name: /取消/ })).toBeInTheDocument();

    await act(async () => {
      resolveSecond?.({ results: [{ success: true, resource: fakeResource('r20') }] });
    });
    await waitFor(() => expect(screen.getAllByText('查看资源 →').length).toBe(21));
    expect(screen.queryByRole('button', { name: /取消/ })).not.toBeInTheDocument();
  });

  it('服务端少返回结果时，缺的那条标红而不是卡在上传中', async () => {
    vi.mocked(uploadBatch).mockResolvedValueOnce({
      results: [{ success: true, resource: fakeResource('r0') }],
    });

    const user = userEvent.setup();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, [
      new File([new Uint8Array(10)], 'a.bin'),
      new File([new Uint8Array(10)], 'b.bin'),
    ]);
    await user.click(screen.getByRole('button', { name: /开始上传/ }));

    await waitFor(() => expect(screen.getByText('服务器未返回处理结果')).toBeInTheDocument());
    expect(screen.getAllByText('查看资源 →').length).toBe(1);
  });
});
