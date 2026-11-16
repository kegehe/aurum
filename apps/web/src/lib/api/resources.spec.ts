import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmptyTrashProgress } from '../types';
import {
  batchMirrorResources,
  canStreamZipToDisk,
  downloadResourcesZip,
  emptyTrashStream,
  listResourceIds,
} from './resources';

/** 构造一个按给定分片输出 SSE 的响应，用于验证跨分片缓冲解析 */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const progressFrame = (processed: number) =>
  `event: progress\ndata: ${JSON.stringify({
    totalResources: 2,
    totalFiles: 3,
    processedResources: processed,
    processedFiles: processed,
    deletedResources: processed,
    deletedFiles: processed,
    skippedResources: 0,
  })}\n\n`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('emptyTrashStream', () => {
  it('parses progress frames split across chunks and resolves with the done payload', async () => {
    // 故意在 JSON 中间和事件分隔处切开，验证缓冲区拼接
    const frame0 = progressFrame(0);
    const frame1 = progressFrame(2);
    const done =
      'event: done\ndata: {"deletedResources":2,"deletedFiles":3,"skippedResources":0}\n\n';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          frame0.slice(0, 20),
          frame0.slice(20) + frame1.slice(0, 10),
          frame1.slice(10) + done,
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const progress: EmptyTrashProgress[] = [];
    const result = await emptyTrashStream({ onProgress: (p) => progress.push(p) });

    expect(result).toEqual({ deletedResources: 2, deletedFiles: 3, skippedResources: 0 });
    expect(progress.map((p) => p.processedResources)).toEqual([0, 2]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/resources/trash/empty/stream'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejects with the server error message pushed as an error event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(sseResponse(['event: error\ndata: {"message":"磁盘不可用"}\n\n'])),
    );

    await expect(emptyTrashStream({})).rejects.toThrow('磁盘不可用');
  });

  it('rejects when the stream ends without a done event', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([progressFrame(1)])));

    await expect(emptyTrashStream({})).rejects.toThrow('连接中断');
  });

  it('rejects with the API message when the HTTP status is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: ['服务器繁忙'] }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(emptyTrashStream({})).rejects.toThrow('服务器繁忙');
  });
});

describe('downloadResourcesZip', () => {
  /** 按分片返回 zip 字节流的响应，headers 用来模拟服务端回传的打包数量 */
  function zipStreamResponse(headers: Record<string, string>, chunks: Uint8Array[]) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers });
  }

  function fakeWritable() {
    const chunks: Uint8Array[] = [];
    return {
      chunks,
      write: vi.fn(async (chunk: Uint8Array) => {
        chunks.push(chunk);
      }),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
  }

  function stubSaveFilePicker(writable: ReturnType<typeof fakeWritable>) {
    const createWritable = vi.fn(async () => writable);
    const picker = vi.fn(async () => ({ createWritable }));
    vi.stubGlobal('showSaveFilePicker', picker);
    return { picker, createWritable };
  }

  const encoder = new TextEncoder();

  it('writes the archive to disk chunk by chunk instead of buffering it', async () => {
    const writable = fakeWritable();
    stubSaveFilePicker(writable);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        zipStreamResponse({ 'X-Resource-Found-Count': '2', 'X-Resource-Missing-Count': '1' }, [
          encoder.encode('abc'),
          encoder.encode('defg'),
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const progress: number[] = [];
    const result = await downloadResourcesZip(['a', 'b', 'remote'], {
      filename: 'resources.zip',
      signal: controller.signal,
      onProgress: ({ loadedBytes }) => progress.push(loadedBytes),
    });

    // 服务端仍按 JSON body 收资源 ID；signal 必须带上，否则取消不会中断连接
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/resources/batch/download'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ resourceIds: ['a', 'b', 'remote'] }),
        signal: controller.signal,
      }),
    );

    expect(result).toEqual({ mode: 'saved', foundResources: 2, missingResources: 1 });
    // 分片是逐块写盘的，最后才 close
    expect(writable.chunks.map((chunk) => new TextDecoder().decode(chunk))).toEqual([
      'abc',
      'defg',
    ]);
    expect(writable.close).toHaveBeenCalled();
    expect(progress).toEqual([3, 7]);
  });

  it('reports unknown counts when the headers are not exposed', async () => {
    const writable = fakeWritable();
    stubSaveFilePicker(writable);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(zipStreamResponse({}, [])));

    // 不能回退成「requested 个全部成功」：资源被跳过时会给出相反结论
    await expect(downloadResourcesZip(['a', 'b'], { filename: 'x.zip' })).resolves.toEqual({
      mode: 'saved',
      foundResources: null,
      missingResources: null,
    });
  });

  it('derives the missing count when only one header is exposed', async () => {
    const writable = fakeWritable();
    stubSaveFilePicker(writable);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(zipStreamResponse({ 'X-Resource-Found-Count': '2' }, [])),
    );

    await expect(downloadResourcesZip(['a', 'b', 'c'], { filename: 'x.zip' })).resolves.toEqual({
      mode: 'saved',
      foundResources: 2,
      missingResources: 1,
    });
  });

  it('surfaces the server message before touching the chosen file', async () => {
    const writable = fakeWritable();
    const { createWritable } = stubSaveFilePicker(writable);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: '所选资源都没有本地原文件' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(downloadResourcesZip(['remote'], { filename: 'x.zip' })).rejects.toThrow(
      '所选资源都没有本地原文件',
    );
    // 服务端拒绝时不动用户选的文件（避免把它截断成空文件）
    expect(createWritable).not.toHaveBeenCalled();
  });

  it('returns cancelled when the user aborts before the archive starts', async () => {
    const writable = fakeWritable();
    const { createWritable } = stubSaveFilePicker(writable);
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      }),
    );

    await expect(
      downloadResourcesZip(['a'], { filename: 'x.zip', signal: controller.signal }),
    ).resolves.toEqual({ mode: 'cancelled' });
    expect(createWritable).not.toHaveBeenCalled();
  });

  it('discards the half-written archive when the user aborts mid-stream', async () => {
    const writable = fakeWritable();
    stubSaveFilePicker(writable);
    const controller = new AbortController();
    let sent = false;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(stream) {
              if (!sent) {
                sent = true;
                stream.enqueue(encoder.encode('abc'));
                controller.abort();
                return;
              }
              stream.error(new DOMException('aborted', 'AbortError'));
            },
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      downloadResourcesZip(['a'], { filename: 'x.zip', signal: controller.signal }),
    ).resolves.toEqual({ mode: 'cancelled' });

    expect(writable.chunks).toHaveLength(1);
    expect(writable.close).not.toHaveBeenCalled();
    // 已写入的内容被丢弃，避免留下损坏的 zip
    expect(writable.abort).toHaveBeenCalled();
  });

  it('returns cancelled when the save dialog is dismissed', async () => {
    vi.stubGlobal(
      'showSaveFilePicker',
      vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError')),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadResourcesZip(['a'], { filename: 'x.zip' })).resolves.toEqual({
      mode: 'cancelled',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hands the archive to the browser download list when streaming to disk is unsupported', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // jsdom 里没有 File System Access API，走原生表单下载
    expect(canStreamZipToDisk()).toBe(false);
    const submitted: HTMLFormElement[] = [];
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (
      this: HTMLFormElement,
    ) {
      submitted.push(this);
    });

    await expect(downloadResourcesZip(['a', 'b'], { filename: 'x.zip' })).resolves.toEqual({
      mode: 'browser',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    const form = submitted[0];
    expect(form.method).toBe('post');
    expect(form.action).toContain('/resources/batch/download');
    // 全部 ID 挤在一个字段里：urlencoded 一个 ID 一个参数，多了会撞上服务端参数条数上限（413）
    const inputs = Array.from(form.querySelectorAll('input'));
    expect(inputs.map((input) => [input.name, input.value])).toEqual([['resourceIds', 'a,b']]);
    // 表单提交完就从 DOM 里摘掉，iframe 留着接下载响应
    expect(document.querySelector('form')).toBeNull();
  });
});

describe('listResourceIds', () => {
  it('asks for the whole filtered scope without pagination params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ids: ['a', 'b'], total: 2 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(listResourceIds({ categoryId: 'cat-1', keyword: 'logo' })).resolves.toEqual({
      ids: ['a', 'b'],
      total: 2,
    });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('/resources/ids?');
    expect(url).toContain('categoryId=cat-1');
    expect(url).toContain('keyword=logo');
    // 全选靠服务端一次返回全部 ID，不能再带分页参数
    expect(url).not.toContain('page=');
    expect(url).not.toContain('pageSize=');
  });
});

describe('batchMirrorResources', () => {
  it('posts the selected ids to the batch mirror endpoint and returns skip details', async () => {
    const payload = {
      resourceIds: ['a', 'b'],
      queued: 1,
      skipped: 1,
      skippedResources: [
        { id: 'b', reason: 'already_local', message: 'Resource already has a local original file' },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(batchMirrorResources(['a', 'b'])).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/resources/batch/mirror'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ resourceIds: ['a', 'b'] }),
      }),
    );
  });
});
