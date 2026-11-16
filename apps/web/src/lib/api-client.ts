/**
 * API 客户端 — fetch 封装
 *
 * - 统一 base URL（NEXT_PUBLIC_API_URL）
 * - 自动 JSON 解析
 * - 错误类型化（匹配后端 HttpExceptionFilter 响应格式）
 * - 查询参数序列化（支持数组、嵌套对象）
 * - multipart 上传专用方法
 */

// ==================== 类型 ====================

/** 后端异常响应格式（HttpExceptionFilter） */
export interface ApiErrorResponse {
  statusCode: number;
  message: string | string[];
  error: string;
  timestamp?: string;
  path?: string;
}

/** 自定义 API 错误 */
export class ApiError extends Error {
  statusCode: number;
  error: string;
  details: string | string[];

  constructor(response: ApiErrorResponse) {
    const msg =
      typeof response.message === 'string' ? response.message : response.message.join(', ');
    super(msg);
    this.name = 'ApiError';
    this.statusCode = response.statusCode;
    this.error = response.error;
    this.details = response.message;
  }
}

/** 分页响应 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// ==================== 核心 ====================

export const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api';
export const DESIGN_BASE_URL = process.env.NEXT_PUBLIC_DESIGN_API_URL || '/api/design-proxy';

async function request<T>(endpoint: string, options?: RequestInit, baseUrl = BASE_URL): Promise<T> {
  const url = `${baseUrl}${endpoint}`;
  const config: RequestInit = {
    ...options,
    headers: {
      // 仅在有请求体时设置 JSON Content-Type，避免 GET/无体 POST 等简单请求触发 CORS 预检
      //（DELETE 因方法本身不在 CORS 安全列表，无论是否带头都会预检）
      ...(options?.body != null ? { 'Content-Type': 'application/json' } : {}),
      ...options?.headers,
    },
  };

  const response = await fetch(url, config);

  if (!response.ok) {
    let errorBody: ApiErrorResponse;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = {
        statusCode: response.status,
        message: response.statusText,
        error: 'NetworkError',
      };
    }
    throw new ApiError(errorBody);
  }

  if (response.status === 204) return undefined as T;
  return response.json();
}

// ==================== 便捷方法 ====================

export function get<T>(endpoint: string, params?: Record<string, unknown>): Promise<T> {
  const qs = params ? `?${buildQueryString(params)}` : '';
  return request<T>(`${endpoint}${qs}`);
}

export function post<T>(endpoint: string, body?: unknown): Promise<T> {
  return request<T>(endpoint, {
    method: 'POST',
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

export function patch<T>(endpoint: string, body?: unknown): Promise<T> {
  return request<T>(endpoint, {
    method: 'PATCH',
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

export function del<T>(endpoint: string): Promise<T> {
  return request<T>(endpoint, { method: 'DELETE' });
}

export function designGet<T>(endpoint: string, params?: Record<string, unknown>): Promise<T> {
  const qs = params ? `?${buildQueryString(params)}` : '';
  return request<T>(`${endpoint}${qs}`, undefined, DESIGN_BASE_URL);
}

export function designPost<T>(endpoint: string, body?: unknown): Promise<T> {
  return request<T>(
    endpoint,
    { method: 'POST', body: body != null ? JSON.stringify(body) : undefined },
    DESIGN_BASE_URL,
  );
}

export function designDelete<T>(endpoint: string): Promise<T> {
  return request<T>(endpoint, { method: 'DELETE' }, DESIGN_BASE_URL);
}

// ==================== multipart 上传 ====================

/** 上传进度：已发送字节数 / 总字节数 */
export interface UploadProgress {
  loaded: number;
  /** 浏览器拿不到总大小时为 0 */
  total: number;
}

export interface UploadOptions {
  /** 进度回调，用于展示百分比、速度与剩余时间 */
  onProgress?: (progress: UploadProgress) => void;
  /** 取消信号：abort 后请求中断，Promise 以 AbortError 拒绝 */
  signal?: AbortSignal;
}

function abortError(): Error {
  return new DOMException('上传已取消', 'AbortError');
}

/** 解析上传失败响应：后端返回 HttpExceptionFilter 的 JSON 时用其信息，否则降级为状态文本 */
function parseUploadError(xhr: XMLHttpRequest): ApiError {
  try {
    const body = JSON.parse(xhr.responseText) as ApiErrorResponse;
    if (body && typeof body.statusCode === 'number' && body.message != null) {
      return new ApiError(body);
    }
  } catch {
    // 响应体不是 JSON（如网关返回的 HTML 错误页），走下面的降级分支
  }
  return new ApiError({
    statusCode: xhr.status,
    message: xhr.statusText || '上传失败',
    error: 'UploadError',
  });
}

/**
 * multipart 上传
 *
 * 用 XHR 而不是 fetch：fetch 没有上传进度事件，GB 级文件只能看到转圈的“上传中”，
 * 用户无法判断是正常传输还是卡死；AbortController 也只能中止等待，看不到“已传多少”。
 * xhr.upload.onprogress 能拿到已发送字节数，xhr.abort() 能真正中断请求。
 *
 * 不设置 Content-Type，让浏览器自动生成带 boundary 的 multipart 头。
 */
export function upload<T>(
  endpoint: string,
  formData: FormData,
  options: UploadOptions = {},
): Promise<T> {
  const url = `${BASE_URL}${endpoint}`;
  const { onProgress, signal } = options;

  // 已经取消的请求没必要再发一次
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;

    const handleAbort = () => xhr.abort();
    const settle = (run: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', handleAbort);
      run();
    };

    xhr.open('POST', url);

    if (onProgress) {
      xhr.upload.onprogress = (event: ProgressEvent) => {
        onProgress({
          loaded: event.loaded,
          total: event.lengthComputable ? event.total : 0,
        });
      };
    }

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        settle(() => reject(parseUploadError(xhr)));
        return;
      }
      // 204 等空响应体不尝试解析 JSON
      if (!xhr.responseText) {
        settle(() => resolve(undefined as T));
        return;
      }
      try {
        const data = JSON.parse(xhr.responseText) as T;
        settle(() => resolve(data));
      } catch {
        settle(() =>
          reject(
            new ApiError({
              statusCode: xhr.status,
              message: '响应解析失败',
              error: 'UploadError',
            }),
          ),
        );
      }
    };
    xhr.onerror = () =>
      settle(() =>
        reject(new ApiError({ statusCode: 0, message: '网络异常，上传失败', error: 'UploadError' })),
      );
    xhr.onabort = () => settle(() => reject(abortError()));
    xhr.ontimeout = () =>
      settle(() =>
        reject(new ApiError({ statusCode: 0, message: '上传超时', error: 'UploadError' })),
      );

    signal?.addEventListener('abort', handleAbort);
    xhr.send(formData);
  });
}

// ==================== 查询参数序列化 ====================

/**
 * 将对象序列化为 URL 查询字符串
 * - 数组：key=v1&key=v2
 * - 嵌套对象：key[sub]=v（后端 qs 解析器会还原成嵌套对象）
 * - 跳过 undefined/null
 */
function buildQueryString(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        if (v !== undefined && v !== null) {
          sp.append(key, String(v));
        }
      }
    } else if (typeof value === 'object') {
      // 嵌套对象用 key[sub] 展开：后端 Express 的 query parser（qs）会还原成嵌套对象，
      // DTO 的 @ValidateNested + @Type 才能生效。
      // 注意不能用 key.sub：qs 不按点号展开，会留下 "key.sub" 这种扁平字段，
      // 被 ValidationPipe 的 whitelist 静默丢掉，筛选条件变成无效参数。
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        if (subValue !== undefined && subValue !== null) {
          sp.set(`${key}[${subKey}]`, String(subValue));
        }
      }
    } else {
      sp.set(key, String(value));
    }
  }
  return sp.toString();
}
