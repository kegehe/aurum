import { execFileSync } from 'node:child_process';
import os from 'node:os';

const ports = process.argv.slice(2)
  .map((value) => Number(value))
  .filter((value) => Number.isInteger(value) && value > 0 && value <= 65535);

if (ports.length === 0) {
  console.error('Usage: node scripts/clean-dev-ports.mjs <port...>');
  process.exit(1);
}

const platform = os.platform();

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

function killPid(pid) {
  if (!pid || pid === String(process.pid)) return;

  try {
    process.kill(Number(pid), 'SIGTERM');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[ports] failed to stop process ${pid}: ${message}`);
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

for (const port of ports) {
  const pids = getListeningPids(port);

  if (pids.length === 0) {
    console.log(`[ports] ${port} is free`);
    continue;
  }

  console.log(`[ports] cleaning ${port}: ${pids.join(', ')}`);
  for (const pid of pids) {
    killPid(pid);
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
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
