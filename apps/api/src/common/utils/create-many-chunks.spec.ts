import { describe, expect, it, vi } from 'vitest';
import {
  CREATE_MANY_CHUNK_SIZE,
  collectExistingIds,
  collectExistingKeys,
  createManyInChunks,
} from './create-many-chunks';

describe('createManyInChunks', () => {
  it('returns 0 for empty data without invoking run', async () => {
    const run = vi.fn();
    await expect(createManyInChunks([], run)).resolves.toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('splits data larger than the chunk size and sums the counts', async () => {
    const data = Array.from({ length: CREATE_MANY_CHUNK_SIZE * 2 + 500 }, (_, i) => i);
    const run = vi.fn().mockResolvedValue({ count: 1 });

    const total = await createManyInChunks(data, run);

    expect(total).toBe(3);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[0][0]).toHaveLength(CREATE_MANY_CHUNK_SIZE);
    expect(run.mock.calls[1][0]).toHaveLength(CREATE_MANY_CHUNK_SIZE);
    expect(run.mock.calls[2][0]).toHaveLength(500);
  });
});

describe('collectExistingIds', () => {
  it('collects ids across multiple chunks and deduplicates', async () => {
    const ids = Array.from({ length: CREATE_MANY_CHUNK_SIZE + 5 }, (_, i) => `id-${i}`);
    const query = vi.fn(async (chunk: string[]) => chunk.map((id) => ({ id })));

    const found = await collectExistingIds(query, ids, (r) => r.id);

    expect(found.size).toBe(CREATE_MANY_CHUNK_SIZE + 5);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toHaveLength(CREATE_MANY_CHUNK_SIZE);
    expect(query.mock.calls[1][0]).toHaveLength(5);
  });
});

describe('collectExistingKeys', () => {
  it('queries the cross-product of chunks and collects unique keys', async () => {
    const aIds = Array.from({ length: CREATE_MANY_CHUNK_SIZE + 5 }, (_, i) => `a-${i}`);
    const bIds = Array.from({ length: 3 }, (_, i) => `b-${i}`);
    const query = vi.fn(async (aChunk: string[], bChunk: string[]) =>
      aChunk.flatMap((a) => bChunk.map((b) => ({ a, b }))),
    );

    const keys = await collectExistingKeys(query, aIds, bIds, (r) => `${r.a}:${r.b}`);

    expect(keys.size).toBe((CREATE_MANY_CHUNK_SIZE + 5) * 3);
    expect(query).toHaveBeenCalledTimes(2); // 2 a-chunks × 1 b-chunk
    expect(query.mock.calls[0][1]).toEqual(['b-0', 'b-1', 'b-2']);
  });
});
