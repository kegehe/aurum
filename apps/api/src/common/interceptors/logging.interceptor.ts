import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, catchError, tap } from 'rxjs';
import { Request, Response } from 'express';

/**
 * 全局日志拦截器：记录每个请求的方法、路径、状态码和耗时
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const { method, url } = req;
    const startedAt = Date.now();

    return next.handle().pipe(
      tap(() => {
        // 使用 finish 事件确保状态码已被设置
        res.on('finish', () => {
          const duration = Date.now() - startedAt;
          this.logger.log(`${method} ${url} ${res.statusCode} ${duration}ms`);
        });
      }),
      catchError((err) => {
        const duration = Date.now() - startedAt;
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`${method} ${url} ERROR ${duration}ms - ${errMsg}`);
        throw err;
      }),
    );
  }
}
