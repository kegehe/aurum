/**
 * 开发启动入口。
 *
 * 顺序很重要：先停掉上一次 dev 进程树，再构建，最后并发启动四个服务。
 * 旧实现把 clean:ports 放在 predev 之后，构建期间旧 API/Worker/Next 仍在
 * 抢 CPU 和 SQLite，构建会明显变慢。
 *
 * 正常重启走 PID 文件：上一次的包装进程还在，就能用 taskkill /T 一次性
 * 结束整棵树，避免每次都为 WMI 全进程表查询等待数十秒。只有 PID 文件
 * 缺失/过期时，才回退到 clean-dev-ports.mjs 的端口扫描。
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(repoRoot, 'node_modules', '.cache');
const pidFile = path.join(cacheDir, 'aurum-dev.json');
const require = createRequire(import.meta.url);
const startedAt = Date.now();

function elapsed() {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function processStartedAt(pid) {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
        ],
        { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      return Date.parse(output);
    }

    const output = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return Date.parse(output);
  } catch {
    return null;
  }
}

function isRecordedProcess(record) {
  const expected = Date.parse(record.startedAt ?? '');
  const actual = processStartedAt(record.pid);
  return (
    Number.isFinite(expected) && Number.isFinite(actual) && Math.abs(actual - expected) <= 60_000
  );
}

function killTree(pid) {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    } catch {
      // 进程可能已经退出。
    }
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // 进程可能已经退出。
  }
}

function waitUntilDead(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive(pid)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

function writePidFile() {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    pidFile,
    // 用包装进程的启动时刻，而不是写文件时刻：清理若走了 100s 的 WMI，
    // 下次启动的时间校验才不会把仍然存活的包装进程误判成 PID 复用。
    JSON.stringify({ pid: process.pid, startedAt: new Date(startedAt).toISOString() }, null, 2),
    'utf8',
  );
}

function removeOwnPidFile() {
  try {
    const record = JSON.parse(readFileSync(pidFile, 'utf8'));
    if (record.pid === process.pid) rmSync(pidFile, { force: true });
  } catch {
    // 文件不存在、损坏，或已经被下一轮启动接管。
  }
}

function clearBrokenWebCache() {
  const nextDir = path.join(repoRoot, 'apps', 'web', '.next');
  const devStaticDir = path.join(nextDir, 'static', 'development');
  if (!existsSync(nextDir) || existsSync(devStaticDir)) return;
  rmSync(nextDir, { recursive: true, force: true });
  console.log('[dev] 清理了不完整的 Web 缓存（apps/web/.next）');
}

function runPnpm(script) {
  const pnpmExecPath = process.env.npm_execpath;
  const started = Date.now();
  const result = pnpmExecPath
    ? spawnSync(process.execPath, [pnpmExecPath, script], {
        cwd: repoRoot,
        stdio: 'inherit',
      })
    : spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [script], {
        cwd: repoRoot,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });

  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? `exit code ${result.status}`;
    throw new Error(`${script} 失败（${reason}），停止启动。`);
  }
  console.log(`[dev] ${script} 完成（${((Date.now() - started) / 1000).toFixed(1)}s）`);
}

function cleanupPreviousRun() {
  let record = null;
  try {
    record = JSON.parse(readFileSync(pidFile, 'utf8'));
  } catch {
    // 没有记录或内容损坏，走端口兜底。
  }

  if (record?.pid && Number.isInteger(record.pid) && record.pid > 0 && record.pid !== process.pid) {
    if (isAlive(record.pid)) {
      if (isRecordedProcess(record)) {
        console.log(`[dev] 停止上一次 dev 进程树（pid ${record.pid}）...`);
        killTree(record.pid);
        waitUntilDead(record.pid, 5_000);
      } else {
        console.warn(`[dev] 记录的 pid ${record.pid} 已不是原来的 dev 进程，改用端口清理。`);
      }
    }
  }
  rmSync(pidFile, { force: true });
  // 先记下自己，再进入可能很慢的端口清理/构建；这样并发启动的第二个入口
  // 能立即识别并接管这一轮，而不是两个入口同时清端口、同时构建。
  writePidFile();

  console.log('[dev] 检查端口占用...');
  runPnpm('clean:ports');
  // 强制结束 Next 可能留下半写的清单缓存；它会让新进程持续 500。
  // 完整的缓存（含 static/development）保留，避免每次重启都丢编译结果。
  clearBrokenWebCache();
}

function main() {
  console.log(`[dev] aurum 开发启动（pid ${process.pid}）`);
  cleanupPreviousRun();

  console.log('[dev] 构建 dev 依赖...');
  // build:api 内部已先构建 @aurum/design-preview，这里不要再单独跑一遍，
  // 否则每次启动都要把共享预览包编译两次（慢机器上启动时间直接翻倍）。
  for (const script of ['build:api', 'build:worker', 'build:renderer']) {
    runPnpm(script);
  }

  const concurrentlyPkgPath = require.resolve('concurrently/package.json');
  const concurrentlyPkg = JSON.parse(readFileSync(concurrentlyPkgPath, 'utf8'));
  const binEntry =
    typeof concurrentlyPkg.bin === 'string'
      ? concurrentlyPkg.bin
      : concurrentlyPkg.bin?.concurrently;
  if (!binEntry) throw new Error('找不到 concurrently 的可执行入口');
  const concurrentlyBin = path.resolve(path.dirname(concurrentlyPkgPath), binEntry);
  const child = spawn(
    process.execPath,
    [
      concurrentlyBin,
      '-n',
      'api,web,worker,renderer',
      '-c',
      'blue,green,magenta,yellow',
      'node scripts/dev-api.mjs',
      'pnpm --filter @aurum/web dev',
      'pnpm --filter @aurum/worker start:dev',
      'pnpm --filter @aurum/design-renderer start',
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );

  console.log(`[dev] 启动服务（总耗时 ${elapsed()}）`);

  let exiting = false;
  const shutdown = (code) => {
    if (exiting) return;
    exiting = true;
    if (isAlive(child.pid)) killTree(child.pid);
    removeOwnPidFile();
    process.exit(code);
  };

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  child.on('error', (error) => {
    console.error(`[dev] 启动服务失败：${error.message}`);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    if (exiting) return;
    exiting = true;
    removeOwnPidFile();
    process.exit(code ?? (signal ? 1 : 0));
  });
}

try {
  main();
} catch (error) {
  removeOwnPidFile();
  console.error(`[dev] 启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
