import { createReadStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalStorageDriver } from './local-storage.driver';

describe('LocalStorageDriver', () => {
  let root: string;
  let driver: LocalStorageDriver;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aurum-storage-spec-'));
    driver = new LocalStorageDriver({ get: () => root } as never);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('streams a readable into storage', async () => {
    const source = Readable.from([Buffer.from('hello '), Buffer.from('world')]);

    await driver.put('copy/ok.bin', source);

    expect(readFileSync(join(root, 'copy', 'ok.bin'), 'utf-8')).toBe('hello world');
  });

  /**
   * 回归用例：写入存储时源流读失败（磁盘异常 / 杀软拦截 / 临时文件被移走）
   * 必须变成 put 的 reject。旧实现只监听 writable 的 error，源流的 error 无人处理，
   * 会以未捕获异常的形式打挂整个进程，连带中断上传、同步和预览。
   */
  it('rejects when the source stream fails instead of crashing the process', async () => {
    const source = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('simulated read failure'));
      },
    });

    await expect(driver.put('copy/read-error.bin', source)).rejects.toThrow(
      'simulated read failure',
    );
  });

  /**
   * createReadStream 的打开失败是异步事件，可能早于 put 内的第一次 await（mkdir）
   * 完成。这个窗口里 pipeline 还没挂上监听，put 必须自己先同步接住错误。
   * 用 microtask 让错误确定性地发生在 mkdir 回调之前：旧实现会因未捕获异常崩溃。
   */
  it('rejects when the source fails before the pipeline is attached', async () => {
    const source = new PassThrough();
    const pending = driver.put('copy/early-read-error.bin', source);
    queueMicrotask(() => source.destroy(new Error('simulated early read failure')));

    await expect(pending).rejects.toThrow('simulated early read failure');
  });

  it('rejects when the source file is missing', async () => {
    const source = createReadStream(join(root, 'does-not-exist.bin'));

    await expect(driver.put('copy/missing-source.bin', source)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  /**
   * mkdir 失败时 put 会销毁源流。但 fs.ReadStream 的挂起 open 失败在 destroy()
   * 之后仍可能补发 'error'（已用真实 fs 验证），因此这条路径也不能提前摘监听，
   * 否则同样会因未捕获异常打挂进程。
   */
  it('keeps the source error guarded when mkdir fails', async () => {
    // 让存储根指向普通文件，mkdir 必然以 ENOTDIR 失败
    const blocker = join(root, 'root-is-a-file');
    writeFileSync(blocker, 'x');
    const failingDriver = new LocalStorageDriver({ get: () => blocker } as never);

    // 模拟 fs.ReadStream：open 未完成就被 destroy 时，错误在 destroy 之后才发出
    const source = new Readable({
      read() {},
      destroy(_error, callback) {
        setTimeout(() => {
          this.emit('error', Object.assign(new Error('ENOENT: simulated'), { code: 'ENOENT' }));
          callback(null);
        }, 10);
      },
    });

    await expect(failingDriver.put('copy/blocked.bin', source)).rejects.toThrow();

    // 等 put 拒绝之后才发出的错误落地：没有监听就会变成未捕获异常
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
