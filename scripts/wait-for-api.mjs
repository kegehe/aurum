/**
 * 等待 API 就绪后再启动依赖它的进程。
 *
 * 用于 pnpm dev：前端（Next.js）启动时会先请求 API 接口，若 API 尚未就绪
 * 页面会一直报错。此脚本轮询 API 健康检查端点，就绪后才返回 0。
 *
 * 用法：node scripts/wait-for-api.mjs [port=3000] [timeoutMs=60000]
 */
import http from 'node:http';

const port = Number(process.argv[2]) || 3000;
const timeoutMs = Number(process.argv[3]) || 60000;

const url = `http://localhost:${port}/api/health`;
const startedAt = Date.now();
const POLL_INTERVAL_MS = 500;
const REQUEST_TIMEOUT_MS = 2000;
let done = false;

function atTimeout() {
  console.error(
    `[wait-for-api] ${url} 在 ${timeoutMs}ms 内未就绪，停止等待。请检查后端日志。`,
  );
  process.exit(1);
}

// 主动停止：既能安全退出，也避免遗留 in-flight 请求的后续回调继续触发。
function finish(exitCode, message) {
  if (done) return;
  done = true;
  if (message) console.log(message);
  process.exit(exitCode);
}

function checkReady() {
  if (done) return;
  const elapsed = Date.now() - startedAt;
  if (elapsed > timeoutMs) {
    atTimeout();
    return;
  }

  const req = http.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
    res.resume();
    // 任何 <500 的状态码都说明服务已在监听：视为就绪。
    if (res.statusCode && res.statusCode < 500) {
      finish(0, `[wait-for-api] API 已就绪 (${url} -> ${res.statusCode})`);
      return;
    }
    // 5xx 视为尚未完全就绪，继续轮询。
    setTimeout(checkReady, POLL_INTERVAL_MS);
  });

  req.on('timeout', () => {
    req.destroy();
    setTimeout(checkReady, POLL_INTERVAL_MS);
  });

  req.on('error', () => {
    // 连接被拒绝：API 尚未监听，继续轮询。
    setTimeout(checkReady, POLL_INTERVAL_MS);
  });
}

// 先停顿片刻，让 concurrently 先输出 API 启动日志，避免前端等待日志抢占开头。
setTimeout(() => {
  console.log(`[wait-for-api] 等待 API 就绪: ${url}`);
  checkReady();
}, 800);
