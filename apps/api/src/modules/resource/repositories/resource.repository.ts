import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, Resource } from '@prisma/client';

type ResourceSortFieldValue = 'createdAt' | 'updatedAt' | 'sizeBytes' | 'title';

/**
 * SQLite 的绑定变量数量有上限（旧构建约 999），批量 ID 查询统一分块。
 * 与 ResourceFileRepository.findStoragePathReferences 保持同一量级。
 */
const ID_CHUNK_SIZE = 500;

function chunkIds(ids: string[]): string[][] {
  const unique = [...new Set(ids)];
  if (unique.length <= ID_CHUNK_SIZE) return unique.length === 0 ? [] : [unique];
  const chunks: string[][] = [];
  for (let offset = 0; offset < unique.length; offset += ID_CHUNK_SIZE) {
    chunks.push(unique.slice(offset, offset + ID_CHUNK_SIZE));
  }
  return chunks;
}

/**
 * 资源仓储
 * 封装 resources 表数据访问，Controller/Service 不直接操作 Prisma
 */
@Injectable()
export class ResourceRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 根据 hash 查询已存在资源（用于去重）
   * 排除已删除资源，取最早创建的一个作为"原始"资源
   */
  findBySha256(sha256: string, tx?: Prisma.TransactionClient): Promise<Resource | null> {
    const client = tx ?? this.prisma;
    return client.resource.findFirst({
      where: { sha256, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  findById(id: string): Promise<Resource | null> {
    return this.prisma.resource.findUnique({ where: { id } });
  }

  findByIdentityUrl(identityUrl: string) {
    return this.prisma.resourceLocator.findFirst({
      where: {
        identityUrl,
      },
      select: { resourceId: true, resource: { select: { deletedAt: true } } },
    });
  }

  /**
   * 查询详情：含文件、重复源资源
   */
  findByIdWithRelations(id: string) {
    return this.prisma.resource.findUnique({
      where: { id },
      include: {
        files: { orderBy: { createdAt: 'asc' } },
        duplicateOf: { select: { id: true, title: true } },
        sourceRecord: { select: { id: true, name: true, slug: true } },
        locators: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] },
        provenance: { orderBy: { capturedAt: 'desc' }, take: 1 },
      },
    });
  }

  /**
   * 回收站文件占用明细（原始行，不做聚合）。
   *
   * 存储 key 按内容哈希生成，重复资源会指向同一份磁盘文件；是否真正可回收
   * 还要看该文件是否仍被回收站之外的资源引用。因此这里只返回原始数据，
   * 去重与引用过滤由 ResourceService 结合 ResourceFileRepository 完成。
   */
  async getTrashFileUsage(): Promise<{
    resourceCount: number;
    files: Array<{ resourceId: string; storagePath: string; sizeBytes: bigint }>;
  }> {
    const [resourceCount, files] = await Promise.all([
      this.prisma.resource.count({ where: { deletedAt: { not: null } } }),
      this.prisma.resourceFile.findMany({
        where: { resource: { deletedAt: { not: null } } },
        select: { resourceId: true, storagePath: true, sizeBytes: true },
      }),
    ]);

    return { resourceCount, files };
  }

  findDeletedWithFiles() {
    return this.prisma.resource.findMany({
      where: { deletedAt: { not: null } },
      include: {
        files: { select: { storagePath: true } },
      },
      orderBy: { deletedAt: 'asc' },
    });
  }

  async findActiveOriginalFiles(ids: string[]) {
    // 逐块串行：全选几万条时会分成上百块，并发查 SQLite 只会互相抢锁
    const resources = [];
    for (const chunk of chunkIds(ids)) {
      resources.push(
        ...(await this.prisma.resource.findMany({
          where: { id: { in: chunk }, deletedAt: null },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            title: true,
            originalFilename: true,
            files: {
              where: { fileRole: 'original', variant: '' },
              take: 1,
              select: {
                storagePath: true,
                mimeType: true,
                extension: true,
                sizeBytes: true,
              },
            },
          },
        })),
      );
    }
    return resources;
  }

  /**
   * 分页查询资源列表
   * 默认排除已软删除资源（includeDeleted=true 时包含，deletedOnly=true 时仅返回已删除）
   */
  findMany(params: {
    where?: Prisma.ResourceWhereInput;
    orderBy?: Prisma.ResourceOrderByWithRelationInput | Prisma.ResourceOrderByWithRelationInput[];
    page?: number;
    pageSize?: number;
  }) {
    const { where, orderBy, page = 1, pageSize = 20 } = params;
    const skip = (page - 1) * pageSize;
    const take = pageSize;

    return this.prisma.resource.findMany({
      where,
      orderBy,
      skip,
      take,
      include: {
        locators: {
          where: { locatorType: { in: ['preview', 'download'] } },
          orderBy: [{ locatorType: 'asc' }, { isPrimary: 'desc' }],
          select: {
            locatorType: true,
            url: true,
            lastError: true,
            downloadAttempts: true,
            nextDownloadAttemptAt: true,
          },
        },
      },
    });
  }

  /**
   * 只查筛选范围内的资源 ID（"全选当前目录"用）。
   * 不进 skip/take、不取关联字段：一次查询就能拿到完整选择集，
   * 避免前端按 pageSize 上限逐页拉取几十次。
   */
  findIds(where?: Prisma.ResourceWhereInput): Promise<{ id: string }[]> {
    return this.prisma.resource.findMany({ where, select: { id: true } });
  }

  count(where?: Prisma.ResourceWhereInput): Promise<number> {
    return this.prisma.resource.count({ where });
  }

  /**
   * 相邻资源导航的游标条件。
   *
   * 列表的全序是 (排序字段, id asc)：同字段值时按 id 升序打破平局，与原实现一致。
   * next/previous 只差比较方向；排序方向再决定 SQL 里用 gt 还是 lt。
   */
  private buildNeighborWhere(params: {
    field: ResourceSortFieldValue;
    key: Date | bigint | string;
    id: string;
    direction: 'previous' | 'next';
    order: 'asc' | 'desc';
  }): Prisma.ResourceWhereInput {
    const { field, key, id, direction, order } = params;
    const asc = order === 'asc';
    const fieldCmp = direction === 'next' ? (asc ? 'gt' : 'lt') : asc ? 'lt' : 'gt';
    const idCmp = direction === 'next' ? 'gt' : 'lt';

    return {
      OR: [{ [field]: { [fieldCmp]: key } }, { AND: [{ [field]: key }, { id: { [idCmp]: id } }] }],
    } as Prisma.ResourceWhereInput;
  }

  /** 统计当前资源之前（全序意义下）有多少条，用于 "3 / 50" 里的位置 */
  countBefore(params: {
    where?: Prisma.ResourceWhereInput;
    field: ResourceSortFieldValue;
    key: Date | bigint | string;
    id: string;
    order: 'asc' | 'desc';
  }): Promise<number> {
    return this.prisma.resource.count({
      where: {
        AND: [params.where ?? {}, this.buildNeighborWhere({ ...params, direction: 'previous' })],
      },
    });
  }

  /**
   * 取当前资源前/后的一条（只查 id）。
   *
   * 之前这里是"取回筛选范围内全部 id + 排序字段，再在 JS 里排序找相邻"：
   * 7411 条时约 100–160ms，且随资源量线性增长。改成索引条件 + LIMIT 1 后，
   * 成本不再取决于结果集大小。
   */
  findNeighbor(params: {
    where?: Prisma.ResourceWhereInput;
    field: ResourceSortFieldValue;
    key: Date | bigint | string;
    id: string;
    direction: 'previous' | 'next';
    order: 'asc' | 'desc';
  }): Promise<{ id: string } | null> {
    // next：在全序里取"大于游标的第一条"，正序排。
    // previous：要取"小于游标的最后一条"，必须按全序的逆序排，否则拿到的是前缀里的第一条
    //（也就是整张列表的第一条）。全序的平局规则是 id asc，所以逆序是 id desc。
    const orderBy: Prisma.ResourceOrderByWithRelationInput[] =
      params.direction === 'next'
        ? [{ [params.field]: params.order }, { id: 'asc' }]
        : [{ [params.field]: params.order === 'asc' ? 'desc' : 'asc' }, { id: 'desc' }];

    return this.prisma.resource.findFirst({
      where: { AND: [params.where ?? {}, this.buildNeighborWhere(params)] },
      orderBy,
      select: { id: true },
    });
  }

  async create(data: Prisma.ResourceCreateInput, tx?: Prisma.TransactionClient): Promise<Resource> {
    const client = tx ?? this.prisma;
    return client.resource.create({ data });
  }

  async update(id: string, data: Prisma.ResourceUpdateInput): Promise<Resource> {
    return this.prisma.resource.update({ where: { id }, data });
  }

  async batchSetCategory(ids: string[], categoryId: string | null): Promise<number> {
    let updated = 0;
    for (const chunk of chunkIds(ids)) {
      const result = await this.prisma.resource.updateMany({
        where: { id: { in: chunk }, deletedAt: null },
        data: { categoryId },
      });
      updated += result.count;
    }
    return updated;
  }

  async batchSetFavorite(ids: string[], isFavorite: boolean): Promise<number> {
    let updated = 0;
    for (const chunk of chunkIds(ids)) {
      const result = await this.prisma.resource.updateMany({
        where: { id: { in: chunk }, deletedAt: null },
        data: { isFavorite },
      });
      updated += result.count;
    }
    return updated;
  }

  async batchSoftDelete(ids: string[]): Promise<number> {
    let updated = 0;
    for (const chunk of chunkIds(ids)) {
      const result = await this.prisma.resource.updateMany({
        where: { id: { in: chunk }, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      updated += result.count;
    }
    return updated;
  }

  /** 软删除：设置 deletedAt */
  async softDelete(id: string): Promise<Resource> {
    return this.prisma.resource.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /** 只更新资源的处理状态 */
  async updateProcessingStatus(id: string, status: string): Promise<Resource> {
    return this.prisma.resource.update({
      where: { id },
      data: { processingStatus: status },
    });
  }

  /** 恢复：清空 deletedAt */
  async restore(id: string): Promise<Resource> {
    return this.prisma.resource.update({
      where: { id },
      data: { deletedAt: null },
    });
  }

  /**
   * 批量恢复（仅限回收站内资源）
   * 返回实际恢复数量与未恢复成功的资源 ID（不在回收站中 / 已不存在）
   *
   * 并发恢复或彻底删除会让 updateMany 的 count 与预读结果不一致，因此以
   * 「预读时在回收站、结束后已不在回收站」为准重新计算，避免 restored +
   * failed 小于请求数量。
   */
  async batchRestore(ids: string[]): Promise<{ restored: number; failedIds: string[] }> {
    const requestedIds = [...new Set(ids)];
    const chunks = chunkIds(requestedIds);
    const existing = [];
    for (const chunk of chunks) {
      existing.push(
        ...(await this.prisma.resource.findMany({
          where: { id: { in: chunk } },
          select: { id: true, deletedAt: true },
        })),
      );
    }
    const wasInTrash = new Set(
      existing.filter((resource) => resource.deletedAt !== null).map((resource) => resource.id),
    );

    // 没有可恢复的资源时直接返回，避免发一次无意义的 updateMany
    if (wasInTrash.size === 0) {
      return { restored: 0, failedIds: requestedIds };
    }

    for (const chunk of chunkIds([...wasInTrash])) {
      await this.prisma.resource.updateMany({
        where: { id: { in: chunk }, deletedAt: { not: null } },
        data: { deletedAt: null },
      });
    }

    // 以最终状态为准：并发恢复也算成功，并发彻底删除则算失败
    const active = [];
    for (const chunk of chunks) {
      active.push(
        ...(await this.prisma.resource.findMany({
          where: { id: { in: chunk }, deletedAt: null },
          select: { id: true },
        })),
      );
    }
    const activeIds = new Set(active.map((resource) => resource.id));
    const restoredIds = requestedIds.filter((id) => wasInTrash.has(id) && activeIds.has(id));
    const restoredSet = new Set(restoredIds);

    return {
      restored: restoredIds.length,
      failedIds: requestedIds.filter((id) => !restoredSet.has(id)),
    };
  }

  /**
   * 彻底删除已在回收站中的资源记录
   * 幂等：如果记录已被并发请求删除（count=0），静默返回而不抛异常。
   */
  async deleteDeleted(id: string): Promise<number> {
    const result = await this.prisma.resource.deleteMany({
      where: { id, deletedAt: { not: null } },
    });
    return result.count;
  }
}
