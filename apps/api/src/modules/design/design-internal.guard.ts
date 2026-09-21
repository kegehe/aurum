import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

/**
 * Design editing APIs are service-to-service endpoints in production. The
 * dashboard must be behind an authenticated gateway that injects this header;
 * the browser never receives the key. Published REST/MCP routes use their own
 * read key and are deliberately excluded here.
 */
@Injectable()
export class DesignInternalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{
        originalUrl?: string;
        headers: Record<string, string | string[] | undefined>;
      }>();
    const path = (request.originalUrl || '').split('?')[0];
    if (/\/api\/design\/(?:published(?:\/|$)|mcp$|ai-tools$)/.test(path)) return true;

    const expected = process.env.DESIGN_INTERNAL_API_KEY;
    if (!expected && process.env.NODE_ENV !== 'production') return true;
    const supplied = request.headers['x-aurum-design-internal-key'];
    const key = Array.isArray(supplied) ? supplied[0] : supplied;
    if (!expected || !key || !safeEqual(key, expected)) {
      throw new UnauthorizedException('A valid internal design service key is required');
    }
    return true;
  }
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
