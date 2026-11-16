import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  del,
  designGet,
  get,
  patch,
  post,
  upload,
  type ApiErrorResponse,
} from './api-client';

/** 造一个 fetch 替身，返回指定状态与响应体。 */
function mockFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
    ...response,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function calledUrl(fetchMock: ReturnType<typeof vi.fn>) {
  return String(fetchMock.mock.calls[0][0]);
}

function calledInit(fetchMock: ReturnType<typeof vi.fn>): RequestInit {
  return fetchMock.mock.calls[0][1] as RequestInit;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ApiError', () => {
  it('message 为字符串时直接作为错误信息', () => {
    const error = new ApiError({
      statusCode: 400,
      message: '参数不合法',
      error: 'BadRequest',
    });
    expect(error.message).toBe('参数不合法');
    expect(error.name).toBe('ApiError');
    expect(error.statusCode).toBe(400);
    expect(error.details).toBe('参数不合法');
  });

  it('message 为数组时拼接为可读信息，但 details 保留原数组', () => {
    const error = new ApiError({
      statusCode: 422,
      message: ['title 不能为空', 'slug 格式错误'],
      error: 'UnprocessableEntity',
    });
    expect(error.message).toBe('title 不能为空, slug 格式错误');
    expect(error.details).toEqual(['title 不能为空', 'slug 格式错误']);
  });
});

describe('查询参数序列化', () => {
  it('跳过 undefined 与 null，不产生空参数', async () => {
    const fetchMock = mockFetch({ json: async () => ({}) });
    await get('/resources', { page: 1, keyword: undefined, cursor: null });
    expect(calledUrl(fetchMock)).toBe('http://localhost:3000/api/resources?page=1');
  });

  it('数组序列化为重复的 key', async () => {
    const fetchMock = mockFetch({ json: async () => ({}) });
    await get('/resources', { types: ['image', 'video'] });
    expect(calledUrl(fetchMock)).toBe(
      'http://localhost:3000/api/resources?types=image&types=video',
    );
  });

  it('数组内的 undefined / null 被丢弃', async () => {
    const fetchMock = mockFetch({ json: async () => ({}) });
    await get('/resources', { types: ['image', null, undefined, 'video'] });
    expect(calledUrl(fetchMock)).toBe(
      'http://localhost:3000/api/resources?types=image&types=video',
    );
  });

  // 用括号形式：后端的 qs 查询解析器会还原成嵌套对象，DTO 的 @ValidateNested 才能校验。
  // 点号形式（range.min）不会被展开，只会变成一个扁平字段被 whitelist 丢掉。
  it('嵌套对象展开为 key[sub]', async () => {
    const fetchMock = mockFetch({ json: async () => ({}) });
    await get('/resources', { range: { min: 0, max: 100 } });
    expect(calledUrl(fetchMock)).toBe(
      'http://localhost:3000/api/resources?range%5Bmin%5D=0&range%5Bmax%5D=100',
    );
  });

  it('无参数时不追加问号', async () => {
    const fetchMock = mockFetch({ json: async () => ({}) });
    await get('/resources');
    expect(calledUrl(fetchMock)).toBe('http://localhost:3000/api/resources');
  });
});

describe('请求头', () => {
  // 这条约束是刻意的：无条件设置 Content-Type 会让简单请求触发 CORS 预检。
  it('GET 不设置 Content-Type', async () => {
    const fetchMock = mockFetch({ json: async () => ({}) });
    await get('/resources');
    expect(calledInit(fetchMock).headers).toEqual({});
  });

  it('有 body 的 POST 设置 JSON Content-Type', async () => {
    const fetchMock = mockFetch({ json: async () => ({}) });
    await post('/categories', { name: '动漫' });
    const init = calledInit(fetchMock);
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(init.body).toBe(JSON.stringify({ name: '动漫' }));
  });

  it('无 body 的 POST 不设置 Content-Type', async () => {
    const fetchMock = mockFetch({ json: async () => ({}) });
    await post('/resources/1/reprocess');
    expect(calledInit(fetchMock).headers).toEqual({});
  });

  it('PATCH 与 DELETE 使用对应方法', async () => {
    const patchMock = mockFetch({ json: async () => ({}) });
    await patch('/resources/1', { title: 'x' });
    expect(calledInit(patchMock).method).toBe('PATCH');

    const delMock = mockFetch({ json: async () => ({}) });
    await del('/resources/1');
    expect(calledInit(delMock).method).toBe('DELETE');
  });
});

describe('响应处理', () => {
  it('204 返回 undefined 而不尝试解析 JSON', async () => {
    const json = vi.fn();
    mockFetch({ status: 204, json });
    await expect(del('/resources/1')).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });

  it('非 2xx 抛出 ApiError，并带上后端错误体', async () => {
    const body: ApiErrorResponse = {
      statusCode: 404,
      message: '资源不存在',
      error: 'NotFound',
    };
    mockFetch({ ok: false, status: 404, json: async () => body });

    await expect(get('/resources/nope')).rejects.toBeInstanceOf(ApiError);
    await expect(get('/resources/nope')).rejects.toMatchObject({
      statusCode: 404,
      error: 'NotFound',
      message: '资源不存在',
    });
  });

  it('错误体不是 JSON 时降级为状态文本，不抛解析异常', async () => {
    mockFetch({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    });

    await expect(get('/resources')).rejects.toMatchObject({
      statusCode: 502,
      error: 'NetworkError',
      message: 'Bad Gateway',
    });
  });
});

describe('design 命名空间', () => {
  it('走 design-proxy 前缀而非 API 直连', async () => {
    const fetchMock = mockFetch({ json: async () => ({}) });
    await designGet('/documents', { page: 1 });
    expect(calledUrl(fetchMock)).toBe('/api/design-proxy/documents?page=1');
  });
});

/** XHR 替身：upload() 必须用 XMLHttpRequest 才能拿到上传进度、真正中断请求 */
class FakeXhr {
  static instances: FakeXhr[] = [];

  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 200;
  statusText = 'OK';
  responseText = '';
  aborted = false;

  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  constructor() {
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(key: string, value: string) {
    this.headers[key] = value;
  }

  send(body: unknown) {
    this.body = body;
  }

  abort() {
    this.aborted = true;
    this.onabort?.();
  }

  /** 模拟传输进度事件 */
  emitProgress(loaded: number, total: number) {
    this.upload.onprogress?.({ loaded, total, lengthComputable: total > 0 } as ProgressEvent);
  }

  /** 模拟响应到达 */
  respond(status: number, responseText: string, statusText = '') {
    this.status = status;
    this.statusText = statusText;
    this.responseText = responseText;
    this.onload?.();
  }
}

describe('multipart 上传', () => {
  beforeEach(() => {
    FakeXhr.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
  });

  it('POST 到对应地址，不设置 Content-Type，交给浏览器生成 boundary', async () => {
    const form = new FormData();
    form.append('file', new Blob(['x']), 'a.txt');

    const promise = upload('/upload', form);
    const xhr = FakeXhr.instances[0];
    xhr.respond(200, JSON.stringify({ id: 'r1' }));

    await expect(promise).resolves.toEqual({ id: 'r1' });
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('http://localhost:3000/api/upload');
    expect(xhr.body).toBe(form);
    expect(xhr.headers).toEqual({});
  });

  it('把已发送字节数透传给 onProgress，供界面算百分比与速度', async () => {
    const onProgress = vi.fn();
    const promise = upload('/upload', new FormData(), { onProgress });
    const xhr = FakeXhr.instances[0];

    xhr.emitProgress(256, 1024);
    xhr.emitProgress(1024, 1024);
    xhr.respond(200, '{}');
    await promise;

    expect(onProgress).toHaveBeenNthCalledWith(1, { loaded: 256, total: 1024 });
    expect(onProgress).toHaveBeenNthCalledWith(2, { loaded: 1024, total: 1024 });
  });

  it('总大小不可知时 total 归零，避免算出 NaN 百分比', async () => {
    const onProgress = vi.fn();
    const promise = upload('/upload', new FormData(), { onProgress });
    FakeXhr.instances[0].emitProgress(512, 0);
    FakeXhr.instances[0].respond(200, '{}');
    await promise;

    expect(onProgress).toHaveBeenCalledWith({ loaded: 512, total: 0 });
  });

  it('失败时抛出 ApiError，错误标识为 UploadError', async () => {
    const promise = upload('/upload', new FormData());
    FakeXhr.instances[0].respond(413, '<html>too large</html>', 'Payload Too Large');

    await expect(promise).rejects.toMatchObject({
      statusCode: 413,
      error: 'UploadError',
      message: 'Payload Too Large',
    });
  });

  it('失败响应是后端错误体时沿用其信息', async () => {
    const body: ApiErrorResponse = {
      statusCode: 400,
      message: '文件类型不支持',
      error: 'BadRequest',
    };
    const promise = upload('/upload', new FormData());
    FakeXhr.instances[0].respond(400, JSON.stringify(body));

    await expect(promise).rejects.toMatchObject({
      statusCode: 400,
      error: 'BadRequest',
      message: '文件类型不支持',
    });
  });

  it('abort 信号触发后中断请求，并以 AbortError 拒绝', async () => {
    const controller = new AbortController();
    const promise = upload('/upload', new FormData(), { signal: controller.signal });
    const xhr = FakeXhr.instances[0];

    controller.abort();

    expect(xhr.aborted).toBe(true);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('信号已取消时不发起请求', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(upload('/upload', new FormData(), { signal: controller.signal })).rejects.toMatchObject(
      { name: 'AbortError' },
    );
    expect(FakeXhr.instances).toHaveLength(0);
  });
});
