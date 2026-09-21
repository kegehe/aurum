import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { readTextCapped, streamStorageToTemp } from './temp-file.util';
import { IStorageService } from '../storage/interfaces/storage-service.interface';

function createStorage(
  getStream: IStorageService['getStream'],
): Pick<IStorageService, 'getStream'> {
  return { getStream };
}

describe('streamStorageToTemp', () => {
  it('streams a storage key into a temp file and returns its path', async () => {
    const content = Buffer.from('hello world');
    const storage = createStorage(async () => Readable.from([content]));
    const tmpPath = await streamStorageToTemp(
      storage as IStorageService,
      'original/abc',
      'test-in',
    );

    try {
      const written = await fs.readFile(tmpPath);
      expect(written.equals(content)).toBe(true);
      expect(path.dirname(tmpPath)).toBe(os.tmpdir());
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  });

  it('cleans up the partial temp file and propagates the source error', async () => {
    const storage = createStorage(async () => {
      const stream = new Readable({
        read() {
          this.destroy(new Error('boom'));
        },
      });
      return stream;
    });

    await expect(
      streamStorageToTemp(storage as IStorageService, 'original/abc', 'test-in'),
    ).rejects.toThrow('boom');

    // 失败后不应残留临时文件
    const leftovers = (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith('test-in-'));
    expect(leftovers).toEqual([]);
  });
});

describe('readTextCapped', () => {
  it('decodes UTF-8 content within the byte cap', async () => {
    const text = await readTextCapped(Readable.from(['héllo wörld']), 1024);
    expect(text).toBe('héllo wörld');
  });

  it('stops reading once the cap is reached', async () => {
    const chunks = ['a'.repeat(1000), 'b'.repeat(1000)];
    const text = await readTextCapped(Readable.from(chunks), 1000);
    expect(text).toBe('a'.repeat(1000));
  });

  it('reads multi-byte UTF-8 across chunk boundaries', async () => {
    // '你' 的 UTF-8 编码为 0xE4 0xBD 0xA0，第一个 chunk 只含前两个字节
    const text = await readTextCapped(
      Readable.from([Buffer.from([0xe4, 0xbd]), Buffer.from([0xa0])]),
      1024,
    );
    expect(text).toBe('你');
  });
});
