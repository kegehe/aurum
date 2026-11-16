/**
 * 开发期 API 进程包装。
 *
 * `pnpm dev` 会同时拉起 API 和独立 Worker。处理任务只应由 Worker 执行：
 * 缩略图、封面这类 CPU 密集任务留在 API 进程里，会和接口请求抢同一个事件循环。
 * 这里给 API 显式关掉执行开关（只入队），Worker 侧保持默认执行。
 *
 * 单独跑 `pnpm dev:api` 不受影响：那条路径直接调用 nest start --watch，
 * 单进程模式下 API 自己会执行处理任务。
 */
import { spawn } from 'node:child_process';

process.env.EXECUTION_ENABLED ??= 'false';
console.log(
  `[dev-api] 处理任务执行=${process.env.EXECUTION_ENABLED}，执行交给独立 Worker`,
);

const child = spawn('pnpm', ['--filter', '@aurum/api', 'start:dev'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
