import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { Prisma } from '@prisma/client';
import { VideoCoverGenerator } from './video-cover-generator.processor';
import { FileRole } from '../../../common/constants/enums';
import { IStorageService } from '../../storage/interfaces/storage-service.interface';

const { ffmpegMock } = vi.hoisted(() => ({ ffmpegMock: vi.fn() }));
vi.mock('fluent-ffmpeg', () => ({ default: ffmpegMock }));

const RESOURCE_ID = 'resource-1';
const SHA256 = 'a'.repeat(64);

type FrameBehavior = (seekSeconds: number, outputPath: string) => Promise<void> | void;
/** 记录每次 run() 的参数，frames 为 null 说明没调用 .frames() */
type FrameAttempt = { seek: number; frames: number | null };

/** 用假的 fluent-ffmpeg 替换进程调用，行为由每个用例决定 */
function mockFfmpeg(behavior: FrameBehavior): { attempts: FrameAttempt[] } {
  const attempts: FrameAttempt[] = [];
  ffmpegMock.mockImplementation(() => {
    const emitter = new EventEmitter();
    let seekSeconds = 0;
    let frames: number | null = null;
    let outputPath = '';
    const command = {
      seekInput: vi.fn((seconds: number) => {
        seekSeconds = seconds;
        return command;
      }),
      frames: vi.fn((count: number) => {
        frames = count;
        return command;
      }),
      output: vi.fn((target: string) => {
        outputPath = target;
        return command;
      }),
      on: vi.fn((event: string, handler: (arg?: unknown) => void) => {
        emitter.on(event, handler);
        return command;
      }),
      run: vi.fn(() => {
        attempts.push({ seek: seekSeconds, frames });
        void (async () => {
          try {
            await behavior(seekSeconds, outputPath);
            emitter.emit('end');
          } catch (err) {
            emitter.emit('error', err instanceof Error ? err : new Error(String(err)));
          }
        })();
      }),
    };
    return command;
  });
  return { attempts };
}

function createGenerator(durationSeconds: unknown) {
  // 真实驱动用 pipeline 消费传入的流，mock 同样读完，避免留下未消费的 ReadStream
  const stored: Buffer[] = [];
  const storage = {
    getStream: vi.fn(async () => Readable.from([Buffer.from('fake-video-bytes')])),
    generateKey: vi.fn(() => `thumbnails/${SHA256}.jpg`),
    put: vi.fn(async (_key: string, stream: Readable) => {
      for await (const chunk of stream) stored.push(Buffer.from(chunk));
      return 'thumbnails';
    }),
  };
  const resourceRepo = {
    findById: vi.fn(async () => ({
      id: RESOURCE_ID,
      sha256: SHA256,
      durationSeconds,
    })),
  };
  const fileRepo = {
    findByResourceAndRole: vi.fn(async (_id: string, role: string) =>
      role === FileRole.original
        ? { id: 'file-1', storagePath: 'original/abc', fileRole: FileRole.original }
        : null,
    ),
    create: vi.fn(async (_data: Record<string, unknown>) => ({})),
  };
  const generator = new VideoCoverGenerator(
    storage as unknown as IStorageService,
    resourceRepo as never,
    fileRepo as never,
  );
  return { generator, storage, fileRepo, stored };
}

describe('VideoCoverGenerator', () => {
  it('短于阈值时截取视频中点，而不是固定第 1 秒', async () => {
    // 生产环境 durationSeconds 是 Prisma Decimal，用真实类型验证数值转换
    const { generator, storage, fileRepo, stored } = createGenerator(new Prisma.Decimal('0.52'));
    const { attempts } = mockFfmpeg(async (_seek, out) => {
      await fs.writeFile(out, Buffer.from('jpeg'));
    });

    await generator.process(RESOURCE_ID, 'job-1');

    // 同时锁住 frames(1)：漏掉会让 ffmpeg 把整段视频逐帧编码到同一路径
    expect(attempts).toEqual([{ seek: 0.26, frames: 1 }]);
    expect(storage.generateKey).toHaveBeenCalledWith(FileRole.thumbnail, SHA256, undefined, 'jpg');
    expect(storage.put).toHaveBeenCalledOnce();
    // 写入 storage 的正是 ffmpeg 产出的那份文件
    expect(Buffer.concat(stored).toString()).toBe('jpeg');
    expect(fileRepo.create).toHaveBeenCalledOnce();
    expect(fileRepo.create.mock.calls[0][0]).toMatchObject({
      fileRole: FileRole.thumbnail,
      storagePath: `thumbnails/${SHA256}.jpg`,
      mimeType: 'image/jpeg',
      extension: 'jpg',
      sizeBytes: BigInt(4),
    });
  });

  it('时长较长时仍截取第 1 秒', async () => {
    const { generator } = createGenerator(12.5);
    const { attempts } = mockFfmpeg(async (_seek, out) => {
      await fs.writeFile(out, Buffer.from('jpeg'));
    });

    await generator.process(RESOURCE_ID, 'job-1');

    expect(attempts).toEqual([{ seek: 1, frames: 1 }]);
  });

  it('时长为 0 时直接截首帧，不做注定失败的尝试', async () => {
    const { generator, storage } = createGenerator(0);
    const { attempts } = mockFfmpeg(async (_seek, out) => {
      await fs.writeFile(out, Buffer.from('jpeg'));
    });

    await generator.process(RESOURCE_ID, 'job-1');

    expect(attempts).toEqual([{ seek: 0, frames: 1 }]);
    expect(storage.put).toHaveBeenCalledOnce();
  });

  it('时长非法（Infinity / 负数）时按未知处理，沿用第 1 秒', async () => {
    for (const invalid of [Number.POSITIVE_INFINITY, -3]) {
      const { generator } = createGenerator(invalid);
      const { attempts } = mockFfmpeg(async (_seek, out) => {
        await fs.writeFile(out, Buffer.from('jpeg'));
      });

      await generator.process(RESOURCE_ID, 'job-1');

      expect(attempts).toEqual([{ seek: 1, frames: 1 }]);
    }
  });

  it('时长未知且第 1 秒截帧失败时回退到首帧', async () => {
    const { generator, storage, stored } = createGenerator(null);
    const { attempts } = mockFfmpeg(async (seek, out) => {
      if (seek === 1) throw new Error('Nothing was written into output file');
      await fs.writeFile(out, Buffer.from('first-frame'));
    });

    await generator.process(RESOURCE_ID, 'job-1');

    expect(attempts).toEqual([
      { seek: 1, frames: 1 },
      { seek: 0, frames: 1 },
    ]);
    expect(storage.put).toHaveBeenCalledOnce();
    // 上传的是回退那次产出的文件
    expect(Buffer.concat(stored).toString()).toBe('first-frame');
  });

  it('截帧产出空文件时同样回退到首帧', async () => {
    const { generator, storage } = createGenerator(0.8);
    const { attempts } = mockFfmpeg(async (seek, out) => {
      await fs.writeFile(out, Buffer.alloc(seek === 0 ? 4 : 0));
    });

    await generator.process(RESOURCE_ID, 'job-1');

    expect(attempts).toEqual([
      { seek: 0.4, frames: 1 },
      { seek: 0, frames: 1 },
    ]);
    expect(storage.put).toHaveBeenCalledOnce();
  });

  it('上一次尝试残留的文件不会被当成成功产出', async () => {
    const { generator, storage } = createGenerator(0.5);
    // 第一次写出非空文件后报错，第二次正常结束但什么都没写
    const { attempts } = mockFfmpeg(async (seek, out) => {
      if (seek === 0.25) {
        await fs.writeFile(out, Buffer.from('stale'));
        throw new Error('ffmpeg exited with code 1');
      }
    });

    await expect(generator.process(RESOURCE_ID, 'job-1')).rejects.toThrow(
      /seek 0s: ffmpeg produced no\/empty output/,
    );
    expect(attempts).toHaveLength(2);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('ffmpeg 卡死时 60s 后 SIGKILL 并以超时失败，不会无限等待', async () => {
    vi.useFakeTimers();
    try {
      const { generator } = createGenerator(1);
      const kill = vi.fn();
      ffmpegMock.mockImplementation(() => {
        const emitter = new EventEmitter();
        const command = {
          seekInput: vi.fn(() => command),
          frames: vi.fn(() => command),
          output: vi.fn(() => command),
          on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
            emitter.on(event, handler);
            return command;
          }),
          run: vi.fn(),
          kill,
        };
        return command;
      });

      const capture = (
        generator as unknown as {
          captureFrame: (input: string, output: string, seek: number) => Promise<void>;
        }
      ).captureFrame.bind(generator);
      const promise = capture('in.mp4', 'out.jpg', 1);
      // 先挂断言：没有超时接线时这里会永远 pending
      const assertion = expect(promise).rejects.toThrow(
        /FFmpeg frame capture timed out after 60s and was killed/,
      );

      await vi.advanceTimersByTimeAsync(60_000);
      expect(kill).toHaveBeenCalledWith('SIGKILL');

      // kill 后进程没有退出事件，宽限期结束仍要 settle
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('所有位置都截不到画面时抛出聚合错误', async () => {
    const { generator, storage, fileRepo } = createGenerator(0.5);
    const { attempts } = mockFfmpeg(() => {
      throw new Error('ffmpeg exploded');
    });

    await expect(generator.process(RESOURCE_ID, 'job-1')).rejects.toThrow(
      /Failed to capture video cover for resource-1 \(seek 0\.25s: ffmpeg exploded; seek 0s: ffmpeg exploded\)/,
    );
    expect(attempts).toHaveLength(2);
    expect(storage.put).not.toHaveBeenCalled();
    expect(fileRepo.create).not.toHaveBeenCalled();
  });
});
