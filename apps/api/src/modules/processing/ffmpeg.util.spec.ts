import { describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { runFfmpegCommand, probeMedia } from './ffmpeg.util';

/** 假的 fluent-ffmpeg Command：只保留超时逻辑用到的 on/run/kill */
function createCommand(killBehavior: 'emit-error' | 'hang' = 'emit-error') {
  const emitter = new EventEmitter();
  const command = {
    on: vi.fn((event: string, handler: (arg?: unknown) => void) => {
      emitter.on(event, handler);
      return command;
    }),
    run: vi.fn(),
    kill: vi.fn(() => {
      if (killBehavior === 'emit-error') {
        // 真实 fluent-ffmpeg 在子进程被杀后会触发 error
        emitter.emit('error', new Error('ffmpeg was killed with signal SIGKILL'));
      }
      return command;
    }),
  };
  return { command, emitter };
}

/** 假的 spawn 子进程：手动控制输出与退出事件 */
function createChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  return child;
}

/**
 * 模拟真实 spawn 的退出顺序：先派发完 stdout/stderr 数据，再触发 close。
 * 直接 emit('close') 会抢在 PassThrough 的 data 事件之前，导致探测不到输出。
 */
async function exitChild(
  child: ReturnType<typeof createChild>,
  { stdout = '', stderr = '', code = 0, signal = null as NodeJS.Signals | null } = {},
) {
  child.stdout.end(stdout);
  child.stderr.end(stderr);
  await Promise.all([once(child.stdout, 'end'), once(child.stderr, 'end')]);
  child.emit('close', code, signal);
}

describe('runFfmpegCommand', () => {
  it('正常结束时 resolve', async () => {
    vi.useFakeTimers();
    try {
      const { command, emitter } = createCommand();

      const promise = runFfmpegCommand(command as never, 'FFmpeg frame capture', 1000);
      expect(command.run).toHaveBeenCalledOnce();
      emitter.emit('end');

      await expect(promise).resolves.toBeUndefined();
      expect(command.kill).not.toHaveBeenCalled();
      // 成功后不能留下超时/宽限定时器
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('run() 同步抛错时 reject 并清理定时器', async () => {
    vi.useFakeTimers();
    try {
      const emitter = new EventEmitter();
      const command = {
        on: vi.fn((event: string, handler: (arg?: unknown) => void) => {
          emitter.on(event, handler);
          return command;
        }),
        run: vi.fn(() => {
          throw new Error('synchronous start failure');
        }),
        kill: vi.fn(),
      };

      await expect(
        runFfmpegCommand(command as never, 'FFmpeg frame capture', 60_000),
      ).rejects.toThrow('synchronous start failure');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('子进程报错时透传原始错误', async () => {
    const { command, emitter } = createCommand();

    const promise = runFfmpegCommand(command as never, 'FFmpeg frame capture', 1000);
    emitter.emit('error', new Error('ffmpeg exited with code 1'));

    await expect(promise).rejects.toThrow('ffmpeg exited with code 1');
    expect(command.kill).not.toHaveBeenCalled();
  });

  it('超时后 SIGKILL 子进程，并以超时原因 reject（而不是 killed 信号）', async () => {
    vi.useFakeTimers();
    try {
      const { command } = createCommand('emit-error');
      const promise = runFfmpegCommand(command as never, 'FFmpeg frame capture', 60_000);
      // 先挂上 reject 断言，避免定时器推进期间产生 unhandled rejection
      const assertion = expect(promise).rejects.toThrow(
        'FFmpeg frame capture timed out after 60s and was killed',
      );

      await vi.advanceTimersByTimeAsync(59_999);
      expect(command.kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(command.kill).toHaveBeenCalledWith('SIGKILL');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('kill 后子进程没有退出事件时，宽限期结束仍会 reject', async () => {
    vi.useFakeTimers();
    try {
      const { command } = createCommand('hang');
      const promise = runFfmpegCommand(command as never, 'FFmpeg frame capture', 1000);
      const assertion = expect(promise).rejects.toThrow('timed out after 1s and was killed');

      await vi.advanceTimersByTimeAsync(1000);
      expect(command.kill).toHaveBeenCalledWith('SIGKILL');

      // 宽限期内 Promise 仍在等待进程退出
      await vi.advanceTimersByTimeAsync(4_999);
      // 宽限期耗尽后必须 settle，不能再次无限挂起
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('超时发生在子进程启动前时，子进程一旦 start 就补杀', async () => {
    vi.useFakeTimers();
    try {
      const { command, emitter } = createCommand('hang');
      const promise = runFfmpegCommand(command as never, 'FFmpeg frame capture', 1000);
      const assertion = expect(promise).rejects.toThrow('timed out after 1s and was killed');

      await vi.advanceTimersByTimeAsync(1000);
      expect(command.kill).toHaveBeenCalledTimes(1);

      // 模拟路径探测慢于超时：kill 时还没有进程，start 之后才真正 spawn
      emitter.emit('start');
      expect(command.kill).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('probeMedia', () => {
  it('解析 ffprobe 的 JSON 输出并归一化数值', async () => {
    const child = createChild();
    spawnMock.mockReturnValue(child);

    const promise = probeMedia('video.mp4', 1000);
    await exitChild(child, {
      stdout: JSON.stringify({
        streams: [{ codec_type: 'video', width: 1920, height: 1080 }, { codec_type: 'audio' }],
        format: { duration: '12.500000' },
      }),
    });

    await expect(promise).resolves.toEqual({
      streams: [
        { codecType: 'video', width: 1920, height: 1080 },
        { codecType: 'audio', width: null, height: null },
      ],
      durationSeconds: 12.5,
    });
    // 必须用 JSON 输出，文本输出对异常文件的字段差异更脆弱
    expect(spawnMock.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        '-print_format',
        'json',
        '-show_streams',
        '-show_format',
        'video.mp4',
      ]),
    );
  });

  it('duration 缺失或非法时返回 null，0 作为有效值保留', async () => {
    for (const [duration, expected] of [
      [undefined, null],
      ['N/A', null],
      ['0.000000', 0],
    ] as const) {
      const child = createChild();
      spawnMock.mockReturnValue(child);

      const promise = probeMedia('audio.mp3', 1000);
      await exitChild(child, {
        stdout: JSON.stringify({ streams: [], format: duration === undefined ? {} : { duration } }),
      });

      await expect(promise).resolves.toMatchObject({ durationSeconds: expected });
    }
  });

  it('stdout/stderr 管道报错不会击穿进程，仍按 close 结果 settle', async () => {
    const child = createChild();
    spawnMock.mockReturnValue(child);

    const promise = probeMedia('video.mp4', 1000);
    // 强杀子进程时 Windows 管道可能报 ECONNRESET；没有 error 监听器会抛未捕获异常
    child.stdout.emit('error', new Error('read ECONNRESET'));
    child.stderr.emit('error', new Error('read ECONNRESET'));
    await exitChild(child, { stdout: JSON.stringify({ streams: [], format: { duration: '1' } }) });

    await expect(promise).resolves.toMatchObject({ durationSeconds: 1 });
  });

  it('退出码 0 但输出无法解析时 reject，而不是永远挂起', async () => {
    const child = createChild();
    spawnMock.mockReturnValue(child);

    const promise = probeMedia('weird.mp4', 1000);
    // 先挂断言：修复前这里会因 Promise 永不 settle 而超时
    const assertion = expect(promise).rejects.toThrow(/ffprobe returned invalid output/);
    await exitChild(child, { stdout: 'not-json' });

    await assertion;
  });

  it('非零退出时带上 stderr 作为失败原因', async () => {
    const child = createChild();
    spawnMock.mockReturnValue(child);

    const promise = probeMedia('broken.mp4', 1000);
    await exitChild(child, { stderr: 'moov atom not found', code: 1 });

    await expect(promise).rejects.toThrow(/ffprobe exited with code 1: moov atom not found/);
  });

  it('启动失败时提示安装 ffmpeg 或设置 FFPROBE_PATH', async () => {
    const child = createChild();
    spawnMock.mockReturnValue(child);

    const promise = probeMedia('video.mp4', 1000);
    child.emit('error', new Error('spawn ffprobe ENOENT'));
    // spawn 失败后 Node 仍可能再发 close，不能二次 settle 或抛错
    child.emit('close', -2, null);

    await expect(promise).rejects.toThrow(/Failed to start ffprobe .*FFPROBE_PATH/);
  });

  it('超时后 kill 子进程并以超时原因 reject', async () => {
    vi.useFakeTimers();
    try {
      const child = createChild();
      spawnMock.mockReturnValue(child);

      const promise = probeMedia('stuck.mp4', 30_000);
      const assertion = expect(promise).rejects.toThrow(
        'ffprobe timed out after 30s and was killed',
      );
      await vi.advanceTimersByTimeAsync(30_000);

      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      // 正常情况下 kill 后 close 会到达；即便没有，宽限期结束也必须 settle
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('超时后进程退出时报告超时，而不是被杀信号', async () => {
    vi.useFakeTimers();
    try {
      const child = createChild();
      spawnMock.mockReturnValue(child);

      const promise = probeMedia('stuck.mp4', 30_000);
      const assertion = expect(promise).rejects.toThrow(
        'ffprobe timed out after 30s and was killed',
      );
      await vi.advanceTimersByTimeAsync(30_000);
      child.emit('close', null, 'SIGKILL');

      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
