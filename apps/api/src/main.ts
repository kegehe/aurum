import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  // 关闭内置 body parser，改用显式注册：批量操作（全选一个目录后移动/收藏/删除）
  // 会把上万个资源 ID 放进 JSON body，默认 100kb 上限会直接 413。
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('urlencoded', { limit: '2mb', extended: true });

  // 收到 SIGTERM/SIGINT 时走完整的销毁流程：调度器借此把在跑任务放回队列，
  // 否则进程重启后这些任务要等满 staleTimeout 才被回收。
  app.enableShutdownHooks();

  // 全局前缀
  app.setGlobalPrefix('api');

  // 全局校验管道
  // 注意：不启用 forbidNonWhitelisted，multipart 上传时 multer 解析的 body 经过
  // ValidationPipe 转换会异常。whitelist 已足以剥离未知字段。
  // multipart 上传接口的 body 通过 @Req().body 读取，不经过 @Body() 装饰器。
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // 全局异常过滤器
  app.useGlobalFilters(new HttpExceptionFilter());

  // 全局日志拦截器
  app.useGlobalInterceptors(new LoggingInterceptor());

  // CORS（开发环境全开放，生产环境按需配置）
  // 批量下载通过响应头回传成功/跳过数量，跨域时必须显式暴露，否则浏览器读不到。
  app.enableCors({
    ...(process.env.NODE_ENV === 'production'
      ? { origin: process.env.CORS_ORIGIN?.split(',') ?? false }
      : {}),
    exposedHeaders: ['X-Resource-Found-Count', 'X-Resource-Missing-Count'],
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(`Application is running on: http://localhost:${port}/api`);
}

bootstrap();
