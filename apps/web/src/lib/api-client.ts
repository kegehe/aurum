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
    const msg = typeof response.message === 'string' ? response.message : response.message.join(', ');
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

/**
 * multipart 上传
 * 不设置 Content-Type，让浏览器自动生成 boundary
 */
export async function upload<T>(endpoint: string, formData: FormData): Promise<T> {
  const url = `${BASE_URL}${endpoint}`;
  const response = await fetch(url, { method: 'POST', body: formData });

  if (!response.ok) {
    let errorBody: ApiErrorResponse;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = {
        statusCode: response.status,
        message: response.statusText,
        error: 'UploadError',
      };
    }
    throw new ApiError(errorBody);
  }

  return response.json();
}

// ==================== 查询参数序列化 ====================

/**
 * 将对象序列化为 URL 查询字符串
 * - 数组：key=v1&key=v2
 * - 嵌套对象：key.sub=v
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
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        if (subValue !== undefined && subValue !== null) {
          sp.set(`${key}.${subKey}`, String(subValue));
        }
      }
    } else {
      sp.set(key, String(value));
    }
  }
  return sp.toString();
}
