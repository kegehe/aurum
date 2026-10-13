import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('嵌套对象展开为 key.sub', async () => {
    const fetchMock = mockFetch({ json: async () => ({}) });
    await get('/resources', { range: { min: 0, max: 100 } });
    expect(calledUrl(fetchMock)).toBe(
      'http://localhost:3000/api/resources?range.min=0&range.max=100',
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

describe('multipart 上传', () => {
  it('不设置 Content-Type，交给浏览器生成 boundary', async () => {
    const fetchMock = mockFetch({ json: async () => ({ id: 'r1' }) });
    const form = new FormData();
    form.append('file', new Blob(['x']), 'a.txt');

    await upload('/upload', form);

    const init = calledInit(fetchMock);
    expect(init.headers).toBeUndefined();
    expect(init.method).toBe('POST');
    expect(init.body).toBe(form);
    expect(calledUrl(fetchMock)).toBe('http://localhost:3000/api/upload');
  });

  it('失败时抛出 ApiError，错误标识为 UploadError', async () => {
    mockFetch({
      ok: false,
      status: 413,
      statusText: 'Payload Too Large',
      json: async () => {
        throw new SyntaxError('not json');
      },
    });

    await expect(upload('/upload', new FormData())).rejects.toMatchObject({
      statusCode: 413,
      error: 'UploadError',
    });
  });
});
