import { startWorker } from '@aurum/api/dist/worker';

/**
 * 独立 Worker 进程入口。
 *
 * 真正的装配在 @aurum/api 的 worker 模块（同一次 nest build 产出，含 dist/worker.d.ts）：
 * 处理流水线的模块、处理器与调度器都属于 API 包，若在 Worker 里再引一份 @nestjs/*，
 * pnpm 会给出第二个 @nestjs/core 实例，DI token 对不上直接起不来。这里只做转发。
 */
void startWorker().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[Worker] 启动失败: ${message}`);
  process.exit(1);
});
