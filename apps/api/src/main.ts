import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

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
  app.enableCors(
    process.env.NODE_ENV === 'production'
      ? { origin: process.env.CORS_ORIGIN?.split(',') ?? false }
      : undefined,
  );

  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(`Application is running on: http://localhost:${port}/api`);
}

bootstrap();
