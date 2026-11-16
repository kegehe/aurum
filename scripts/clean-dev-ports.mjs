/**
 * 释放开发端口，并连带清理占用端口的整棵进程树。
 *
 * 为什么不能只杀监听进程：`pnpm dev` 的进程链是
 *   pnpm → nest start --watch / next dev → node(dist/main.js)
 * 只杀掉最底层监听端口的那个进程，上层的 watch 进程会变成孤儿继续存活，
 * 每次启动都会再积一层。它们会重复全量编译、抢 CPU，并在源码变更时重启出
 * 一个 EADDRINUSE 的实例，让后续启动越来越慢甚至起不来。
 *
 * 用法：node scripts/clean-dev-ports.mjs <port...>
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ports = process.argv
  .slice(2)
  .map((value) => Number(value))
  .filter((value) => Number.isInteger(value) && value > 0 && value <= 65535);

if (ports.length === 0) {
  console.error('Usage: node scripts/clean-dev-ports.mjs <port...>');
  process.exit(1);
}

const platform = os.platform();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function unique(values) {
  return [...new Set(values)].filter(Boolean);
}

function getWindowsListeningPids(port) {
  const output = run('netstat', ['-ano', '-p', 'tcp']);

  return unique(
    output
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((columns) => columns.length >= 5)
      .filter((columns) => columns[0].toUpperCase() === 'TCP')
      .filter((columns) => columns[3].toUpperCase() === 'LISTENING')
      .filter((columns) => {
        const localAddress = columns[1];
        return localAddress.endsWith(`:${port}`) || localAddress.endsWith(`.${port}`);
      })
      .map((columns) => columns[4]),
  );
}

function getUnixListeningPids(port) {
  try {
    return unique(run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).split(/\s+/));
  } catch {
    try {
      return unique(run('fuser', ['-n', 'tcp', String(port)]).split(/\s+/));
    } catch {
      return [];
    }
  }
}

function getListeningPids(port) {
  if (platform === 'win32') {
    return getWindowsListeningPids(port);
  }

  return getUnixListeningPids(port);
}

/** 进程表：pid -> { ppid, command }。用于向上找祖先进程、向下找子进程。 */
function getProcessTable() {
  const table = new Map();

  try {
    const lines =
      platform === 'win32'
        ? run('powershell', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            // PowerShell 5.1 输出到管道时按本地代码页编码（本机是 GBK），
            // 命令行里含非 ASCII 字符会被解码成乱码，导致仓库路径匹配失效。
            '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
              'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)" }',
          ]).split(/\r?\n/)
        : run('ps', ['-eo', 'pid=,ppid=,args=']).split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let pid;
      let ppid;
      let command;

      if (platform === 'win32') {
        const first = trimmed.indexOf('|');
        const second = trimmed.indexOf('|', first + 1);
        if (first < 0 || second < 0) continue;
        pid = Number(trimmed.slice(0, first));
        ppid = Number(trimmed.slice(first + 1, second));
        command = trimmed.slice(second + 1);
      } else {
        const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!match) continue;
        pid = Number(match[1]);
        ppid = Number(match[2]);
        command = match[3];
      }

      if (!Number.isInteger(pid) || pid <= 0) continue;
      table.set(String(pid), { ppid: Number.isInteger(ppid) ? ppid : 0, command });
    }
  } catch {
    // 拿不到进程表时退化为「只杀监听进程」，至少让端口可用。
    return table;
  }

  return table;
}

const repoMarker = repoRoot.toLowerCase().replace(/\\/g, '/');
const AURUM_PACKAGE_MARKER = '@aurum/';

/**
 * 本仓库开发服务的命令行特征。
 * 这些命令只会出现在「从端口监听进程往上走」的祖先链上，
 * 所以匹配到即说明它属于本次要清理的树。
 */
const DEV_SERVER_PATTERNS = [
  /@nestjs\/cli\/bin\/nest\.js"?\s+start/,
  /next\/dist\/bin\/next"?\s+dev/,
  /concurrently\/dist\/bin\/concurrently/,
  // pnpm 在 Windows 上会经 pnpm.cmd 转发，命令行里可能是 `pnpm`、`pnpm.cmd`
  // 或 `pnpm.mjs`，三种形态都要认，否则向上遍历会在 concurrently 之前断掉。
  /pnpm(\.mjs|\.cmd|\.cjs)?"?\s+(--filter\s+@aurum\/\S+\s+)?(dev|start:dev|start:prod)\b/,
  /node(\s+--enable-source-maps)?\s+\S*dist\/main(\.js)?\b/,
  /^nest\s+start\b/,
  /^next\s+dev\b/,
];

/**
 * 解开 Windows 上 cmd.exe 的启动壳。
 *
 * npm/pnpm 在 Windows 上会经 cmd.exe 转发一层，壳本身的命令行里没有仓库路径
 * （例如 `cmd /d /s /c "nest start --watch"`）。不解开的话，向上遍历会在这一层
 * 断掉，watch 进程依然会被留下。
 */
function unwrapCmdShim(command) {
  const match = command.match(/cmd(?:\.exe)?"?\s+\/d\s+\/s\s+\/c\s+(.*)$/);
  if (match) {
    return match[1].replace(/^"|"$/g, '').trim();
  }

  const shortMatch = command.match(/cmd(?:\.exe)?"?\s+\/c\s+(.*)$/);
  return shortMatch ? shortMatch[1].replace(/^"|"$/g, '').trim() : command;
}

function isRepoDevServer(command) {
  if (!command) return false;

  const normalized = command.toLowerCase().replace(/\\/g, '/');
  const inRepo = normalized.includes(repoMarker) || normalized.includes(AURUM_PACKAGE_MARKER);

  // 未解壳的命令行：要求同时命中仓库路径，避免误杀无关进程。
  if (inRepo && DEV_SERVER_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  // 解壳后的载荷：它必然是下面那个开发进程的启动命令，按特征匹配即可。
  const unwrapped = unwrapCmdShim(normalized);
  return unwrapped !== normalized && DEV_SERVER_PATTERNS.some((pattern) => pattern.test(unwrapped));
}

/** 从监听端口的进程出发，向上收集本仓库 dev 服务的祖先进程，再向下收集其全部子进程。 */
function collectProcessTree(rootPids, table) {
  const collected = new Set(rootPids.map(String));

  for (const rootPid of rootPids) {
    let current = table.get(String(rootPid));

    while (current && current.ppid > 0) {
      const parent = table.get(String(current.ppid));
      if (!parent) break;
      if (!isRepoDevServer(parent.command)) break;
      collected.add(String(current.ppid));
      current = parent;
    }
  }

  const childrenOf = new Map();
  for (const [pid, info] of table) {
    const siblings = childrenOf.get(String(info.ppid)) ?? [];
    siblings.push(pid);
    childrenOf.set(String(info.ppid), siblings);
  }

  const queue = [...collected];
  while (queue.length > 0) {
    const pid = queue.shift();
    for (const child of childrenOf.get(pid) ?? []) {
      if (collected.has(child)) continue;
      collected.add(child);
      queue.push(child);
    }
  }

  return [...collected];
}

/** 本脚本自身的祖先链：任何情况下都不动它们。 */
function getOwnAncestors(table) {
  const ancestors = new Set();
  let current = table.get(String(process.pid));

  while (current && current.ppid > 0) {
    ancestors.add(String(current.ppid));
    current = table.get(String(current.ppid));
  }

  return ancestors;
}

function sendSignal(pid, signal) {
  try {
    process.kill(Number(pid), signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[ports] failed to stop process ${pid}: ${message}`);
  }
}

function forceKill(pid) {
  if (platform === 'win32') {
    try {
      run('taskkill', ['/F', '/T', '/PID', String(pid)]);
    } catch {
      // 进程可能已经退出。
    }
    return;
  }

  sendSignal(pid, 'SIGKILL');
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    // 只有 ESRCH（进程不存在）才算已退出。EPERM 说明进程还在，只是没权限发信号，
    // 这种情况要归为「存活」，否则会误判成清理完成而跳过强杀。
    return error?.code !== 'ESRCH';
  }
}

let table = null;
let ownAncestors = null;

for (const port of ports) {
  const listeners = getListeningPids(port);

  if (listeners.length === 0) {
    console.log(`[ports] ${port} is free`);
    continue;
  }

  // 只有确实有端口被占用时才枚举全进程表。WMI 在部分 Windows 机器上
  // 单次可达数十秒甚至数分钟，空闲启动不该为它买单。
  if (!table) {
    table = getProcessTable();
    ownAncestors = getOwnAncestors(table);
  }

  const tree = collectProcessTree(listeners, table).filter(
    (pid) => pid !== String(process.pid) && !ownAncestors.has(pid),
  );

  console.log(`[ports] cleaning ${port}: ${tree.join(', ')}`);

  for (const pid of tree) {
    sendSignal(pid, 'SIGTERM');
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (tree.every((pid) => !isAlive(pid))) break;
    sleep(100);
  }

  for (const pid of tree) {
    if (isAlive(pid)) {
      forceKill(pid);
    }
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (getListeningPids(port).length === 0) break;
    sleep(100);
  }

  const remaining = getListeningPids(port);
  if (remaining.length > 0) {
    console.error(`[ports] ${port} is still occupied by ${remaining.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`[ports] ${port} cleaned`);
  }
}
