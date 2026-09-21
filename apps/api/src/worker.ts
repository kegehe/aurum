import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

/**
 * 独立处理任务 Worker 的入口（与 API 同一套依赖，避免两份 @nestjs/core 造成 DI 失效）。
 *
 * 只装配 DI 容器（Prisma / 存储 / 各处理器注册 / 轮询调度器），不监听 HTTP 端口：
 * 缩略图、转码、文本提取这类 CPU/IO 密集任务因此不再和接口请求抢同一个事件循环。
 *
 * 分工由环境变量决定（默认全开 = 单进程跑全部）：
 * - API 进程设 EXECUTION_ENABLED=false → 只入队，不认领处理任务
 * - Worker 进程默认关掉摄入调度（下面兜底），摄入同步的单飞与并发假设只在单进程内成立
 *
 * 必须以 apps/api 为工作目录运行：.env 与 STORAGE_ROOT 都按该目录解析。
 */
export async function startWorker(): Promise<void> {
  // 必须在加载 AppModule 之前定好：ConfigModule 的 Joi 默认值会回写 process.env，
  // 一旦模块被 require，这里再改就来不及了。
  process.env.INGESTION_ENABLED ??= 'false';
  const logger = new Logger('Worker');
  logger.log(
    `启动 Worker（处理任务执行=${process.env.EXECUTION_ENABLED ?? 'true'}，摄入调度=${process.env.INGESTION_ENABLED}）`,
  );

  // 懒加载：让上面的环境变量先落地，再触发模块求值（ConfigModule 的校验默认值
  // 会在模块求值时回写 process.env，届时再设就来不及了）
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: false,
  });
  app.enableShutdownHooks();
  const close = () =>
    void app
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

// 直接 `node dist/worker.js` 时自启动；被 require 时只导出 startWorker
if (require.main === module) {
  void startWorker().catch((error) => {
    new Logger('Worker').error(
      `Worker 启动失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    process.exit(1);
  });
}
