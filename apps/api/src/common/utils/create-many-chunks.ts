/**
 * 批量写入工具
 *
 * 把「逐条 create」改成 createMany 一次性批量插入时，SQLite 单条 INSERT 的参数数量受
 * SQLITE_MAX_VARIABLE_NUMBER 限制（Prisma 内置 SQLite 为 32766）。这里提供分块执行
 * createMany 的辅助函数，避免大批量插入时报 "too many SQL variables"。
 *
 * 注意：SQLite 的 createMany 不支持 skipDuplicates，因此插入前需要自己过滤掉
 * 1) 不存在的关联记录（避免任一外键缺失导致整批失败 P2003）；
 * 2) 已存在的关联（避免主键冲突导致整批失败 P2002）。
 */

/** createMany 分块大小：单行 2-4 个参数，1000 行远低于 SQLite 变量上限，留足余量 */
export const CREATE_MANY_CHUNK_SIZE = 1000;

/**
 * 分批执行 createMany，返回累计实际插入行数。
 * @param data 待插入数据
 * @param run  每批执行的 createMany（调用方传入具体的 prisma.<model>.createMany）
 */
export async function createManyInChunks<T>(
  data: T[],
  run: (chunk: T[]) => Promise<{ count: number }>,
  chunkSize: number = CREATE_MANY_CHUNK_SIZE,
): Promise<number> {
  if (data.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < data.length; i += chunkSize) {
    const result = await run(data.slice(i, i + chunkSize));
    total += result.count;
  }
  return total;
}

/**
 * 分批执行 in 查询并聚合命中行的 id，返回 id 集合。
 * 用于插入前过滤不存在的关联记录或已存在的关联，避免 createMany 因单个冲突整批失败。
 * @param query 按一批 id 查询（实现方以 idChunk 作为 in 条件）
 * @param ids   待查 id 列表
 * @param toId  从查询结果行中取出用于去重的键
 */
export async function collectExistingIds<T>(
  query: (idChunk: string[]) => Promise<T[]>,
  ids: string[],
  toId: (row: T) => string,
): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += CREATE_MANY_CHUNK_SIZE) {
    const rows = await query(ids.slice(i, i + CREATE_MANY_CHUNK_SIZE));
    for (const row of rows) found.add(toId(row));
  }
  return found;
}

/**
 * 分批执行二维 in 查询并聚合命中行的键，返回键集合。
 * 用于过滤已存在的 (A, B) 关联：两列各自按批交叉查询，同时限制两个 in 条件的参数数量
 * （单次查询参数数 ≤ 2 × CREATE_MANY_CHUNK_SIZE），避免任一维过大导致 SQLite 变量超限。
 * @param query 按一批 a-id 和一批 b-id 查询（实现方以两个参数分别作为两列的 in 条件）
 * @param aIds  第一列待查 id 列表
 * @param bIds  第二列待查 id 列表
 * @param toKey 从查询结果行中取出用于去重的键
 */
export async function collectExistingKeys<T>(
  query: (aIdChunk: string[], bIdChunk: string[]) => Promise<T[]>,
  aIds: string[],
  bIds: string[],
  toKey: (row: T) => string,
): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < aIds.length; i += CREATE_MANY_CHUNK_SIZE) {
    const aChunk = aIds.slice(i, i + CREATE_MANY_CHUNK_SIZE);
    for (let j = 0; j < bIds.length; j += CREATE_MANY_CHUNK_SIZE) {
      const bChunk = bIds.slice(j, j + CREATE_MANY_CHUNK_SIZE);
      const rows = await query(aChunk, bChunk);
      for (const row of rows) found.add(toKey(row));
    }
  }
  return found;
}
