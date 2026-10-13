import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const FORWARDED_METHODS = new Set(['GET', 'POST', 'DELETE']);
/** 只有这些方法带请求体，其余方法不该发送空 body */
const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);
const DASHBOARD_GATEWAY_HEADER = 'x-aurum-design-dashboard-key';

async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  if (!FORWARDED_METHODS.has(request.method)) {
    return NextResponse.json({ message: 'Method not allowed' }, { status: 405 });
  }
  const internalKey = process.env.DESIGN_INTERNAL_API_KEY;
  const dashboardKey = process.env.DESIGN_DASHBOARD_PROXY_KEY;
  if (process.env.NODE_ENV === 'production' && !internalKey) {
    return NextResponse.json({ message: 'Design proxy is not configured' }, { status: 503 });
  }
  if (
    process.env.NODE_ENV === 'production' &&
    (!dashboardKey || request.headers.get(DASHBOARD_GATEWAY_HEADER) !== dashboardKey)
  ) {
    return NextResponse.json({ message: 'Dashboard gateway authentication is required' }, { status: 401 });
  }
  const upstreamBase = process.env.API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api';
  if (!/^https?:\/\//i.test(upstreamBase)) {
    return NextResponse.json({ message: 'API_INTERNAL_URL must be an absolute server URL' }, { status: 503 });
  }
  const { path } = await context.params;
  if (path[0] !== 'design') {
    return NextResponse.json({ message: 'Not found' }, { status: 404 });
  }
  const upstream = new URL(`${upstreamBase.replace(/\/$/, '')}/${path.map(encodeURIComponent).join('/')}`);
  upstream.search = new URL(request.url).search;
  const headers = new Headers();
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  if (internalKey) headers.set('x-aurum-design-internal-key', internalKey);
  const response = await fetch(upstream, {
    method: request.method,
    headers,
    body: METHODS_WITH_BODY.has(request.method) ? await request.arrayBuffer() : undefined,
    cache: 'no-store',
  });
  const responseHeaders = new Headers();
  for (const name of ['content-type', 'cache-control']) {
    const value = response.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

export const GET = proxy;
export const POST = proxy;
export const DELETE = proxy;
