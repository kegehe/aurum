import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { FfmpegCommand } from 'fluent-ffmpeg';

/**
 * 单次 ffmpeg 截帧的硬超时。
 *
 * fluent-ffmpeg 只在子进程真正退出时触发 end/error；遇到损坏视频、FIFO 或
 * 卡住的输入时子进程可能永不退出，Promise 就会一直挂到调度器的 30 分钟兜底回收，
 * 期间子进程还占着 CPU/文件句柄，并随重试继续堆积。这里主动计时并 kill。
 */
export const FFMPEG_COMMAND_TIMEOUT_MS = 60_000;

/** ffprobe 正常在秒级返回，30s 足够宽松 */
export const FFPROBE_TIMEOUT_MS = 30_000;

/** kill 之后等待子进程真正退出的宽限期；超时说明进程连 SIGKILL 都没收掉，不能再等 */
const KILL_GRACE_MS = 5_000;

/** ffprobe 报错时只保留 stderr 尾部，避免把超长输出整段塞进任务错误 */
const STDERR_TAIL_LENGTH = 2_000;

export interface MediaProbeStream {
  /** ffprobe 的 codec_type（video / audio / subtitle …），缺失时为 null */
  codecType: string | null;
  width: number | null;
  height: number | null;
}

export interface MediaProbeResult {
  streams: MediaProbeStream[];
  /** 容器时长（秒）；缺失或非法时为 null，0 是有效值 */
  durationSeconds: number | null;
}

/**
 * 执行 fluent-ffmpeg 命令，超过 timeoutMs 后 SIGKILL 底层进程并以可读错误 reject。
 *
 * 超时后仍会等到进程退出（或宽限期耗尽）再 settle，确保调用方清理临时文件时
 * 不会和仍在写盘的子进程抢同一个路径（Windows 上会 EBUSY）。
 */
export function runFfmpegCommand(
  command: FfmpegCommand,
  label = 'FFmpeg command',
  timeoutMs = FFMPEG_COMMAND_TIMEOUT_MS,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let killGraceTimer: NodeJS.Timeout | undefined;

    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killGraceTimer);
      action();
    };
    const timeoutError = () =>
      new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s and was killed`);

    command
      .on('start', () => {
        // 极端情况下超时发生在 ffmpeg 路径探测阶段，此时还无进程可杀；
        // 子进程一旦启动就补杀，避免留下无人回收的孤儿进程。
        if (timedOut) {
          try {
            command.kill('SIGKILL');
          } catch {
            // 进程可能刚好自行退出
          }
        }
      })
      .on('end', () => settle(resolve))
      .on('error', (err: Error) => {
        // 超时后的 error 由我们自己的 kill 触发，对外报告超时原因而不是 "killed with signal"
        settle(() => (timedOut ? reject(timeoutError()) : reject(err)));
      });

    const timer = setTimeout(() => {
      timedOut = true;
      // 先挂宽限定时器再 kill：kill 若同步触发 error，settle 才能把它一并清掉
      killGraceTimer = setTimeout(() => settle(() => reject(timeoutError())), KILL_GRACE_MS);
      try {
        command.kill('SIGKILL');
      } catch {
        // 进程可能刚好自行退出，下面仍按超时处理
      }
    }, timeoutMs);

    try {
      command.run();
    } catch (err) {
      // 同步启动失败（如无输入）也要清掉定时器，别让超时器白白挂 60s
      settle(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}

/**
 * 带硬超时的 ffprobe。
 *
 * 直接 spawn 而不是用 `ffmpeg.ffprobe()`：后者没有暴露子进程句柄，超时只能 reject
 * Promise，ffprobe 进程仍会继续跑（迟到的回调对已 settle 的 Promise 是空操作）。
 */
export function probeMedia(
  filePath: string,
  timeoutMs = FFPROBE_TIMEOUT_MS,
): Promise<MediaProbeResult> {
  return new Promise<MediaProbeResult>((resolve, reject) => {
    const executable = resolveFfprobePath();
    const child = spawn(
      executable,
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath],
      { windowsHide: true },
    );

    let settled = false;
    let timedOut = false;
    let killGraceTimer: NodeJS.Timeout | undefined;
    let stdout = '';
    let stderr = '';

    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killGraceTimer);
      action();
    };
    const timeoutError = () =>
      new Error(`ffprobe timed out after ${Math.round(timeoutMs / 1000)}s and was killed`);
    const stderrTail = () =>
      stderr.trim().length > STDERR_TAIL_LENGTH
        ? `…${stderr.trim().slice(-STDERR_TAIL_LENGTH)}`
        : stderr.trim();

    const timer = setTimeout(() => {
      timedOut = true;
      // 先挂宽限定时器再 kill：kill 若同步触发 error/close，settle 才能把它一并清掉
      killGraceTimer = setTimeout(() => settle(() => reject(timeoutError())), KILL_GRACE_MS);
      // SIGKILL 在 Windows 上等价于强制 TerminateProcess，不会给进程收尾的机会
      try {
        child.kill('SIGKILL');
      } catch {
        // 进程可能刚好自行退出，下面仍按超时处理
      }
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // 强杀子进程时管道读端可能抛 ECONNRESET/EPIPE；没有监听器会变成
    // 未捕获异常直接击穿 Worker。数据丢失由 close/超时路径兜底。
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err: Error) => {
      if (timedOut) {
        settle(() => reject(timeoutError()));
        return;
      }
      // ENOENT 等启动失败：给出可操作的提示
      settle(() =>
        reject(
          new Error(
            `Failed to start ffprobe (${executable}): ${err.message}; install ffmpeg or set FFPROBE_PATH`,
          ),
        ),
      );
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        settle(() => reject(timeoutError()));
        return;
      }
      if (code === 0) {
        // 必须在 settle 之外解析：settle 会先置 settled，若在 action 里抛错，
        // 外层 catch 再调 settle 就成了空操作，Promise 会永远挂起。
        let parsed: MediaProbeResult;
        try {
          parsed = parseProbeOutput(stdout);
        } catch (err) {
          settle(() =>
            reject(
              new Error(
                `ffprobe returned invalid output: ${err instanceof Error ? err.message : String(err)}`,
              ),
            ),
          );
          return;
        }
        settle(() => resolve(parsed));
        return;
      }
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      const detail = stderrTail();
      settle(() =>
        reject(new Error(`ffprobe exited with ${reason}${detail ? `: ${detail}` : ''}`)),
      );
    });
  });
}

/** 解析 ffprobe 的 JSON 输出，并把字符串型数值归一化为 number | null */
function parseProbeOutput(raw: string): MediaProbeResult {
  const parsed = JSON.parse(raw) as {
    streams?: Array<{ codec_type?: unknown; width?: unknown; height?: unknown }>;
    format?: { duration?: unknown };
  };

  return {
    streams: (parsed.streams ?? []).map((stream) => ({
      codecType: typeof stream.codec_type === 'string' ? stream.codec_type : null,
      width: toNonNegativeNumber(stream.width),
      height: toNonNegativeNumber(stream.height),
    })),
    durationSeconds: toNonNegativeNumber(parsed.format?.duration),
  };
}

function toNonNegativeNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * 按 fluent-ffmpeg 的查找顺序定位 ffprobe：
 * FFPROBE_PATH → 与 FFMPEG_PATH 同目录 → PATH 中的 ffprobe。
 */
function resolveFfprobePath(): string {
  const configured = process.env.FFPROBE_PATH?.trim();
  if (configured && existsSync(configured)) return configured;

  const ffmpegPath = process.env.FFMPEG_PATH?.trim();
  if (ffmpegPath) {
    const sibling = path.join(
      path.dirname(ffmpegPath),
      process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
    );
    if (existsSync(sibling)) return sibling;
  }

  return 'ffprobe';
}
