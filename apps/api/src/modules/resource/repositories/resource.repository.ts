import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, Resource } from '@prisma/client';

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

  findDeletedWithFiles() {
    return this.prisma.resource.findMany({
      where: { deletedAt: { not: null } },
      include: {
        files: { select: { storagePath: true } },
      },
      orderBy: { deletedAt: 'asc' },
    });
  }

  findActiveOriginalFiles(ids: string[]) {
    return this.prisma.resource.findMany({
      where: { id: { in: ids }, deletedAt: null },
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
    });
  }

  /**
   * 分页查询资源列表
   * 默认排除已软删除资源（includeDeleted=true 时包含，deletedOnly=true 时仅返回已删除）
   */
  findMany(params: {
    where?: Prisma.ResourceWhereInput;
    orderBy?: Prisma.ResourceOrderByWithRelationInput;
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
          select: { locatorType: true, url: true },
        },
      },
    });
  }

  count(where?: Prisma.ResourceWhereInput): Promise<number> {
    return this.prisma.resource.count({ where });
  }

  /**
   * 读取筛选范围内的排序键清单（仅 id + 指定的排序字段）。
   * 供相邻资源导航使用：service 侧据此在 (排序字段, id) 全序中定位当前资源的前后邻居。
   * 相比 keyset 游标，本方法天然处理 NULL 排序值与并列值，代码更简单、结果与列表顺序一致。
   */
  async findSortKeys(params: {
    where?: Prisma.ResourceWhereInput;
    field: 'createdAt' | 'updatedAt' | 'sizeBytes' | 'title';
  }): Promise<Array<{ id: string; sortKey: Date | bigint | string | null }>> {
    const { where, field } = params;
    const rows = await this.prisma.resource.findMany({
      where,
      orderBy: { id: 'asc' },
      select: { id: true, [field]: true } as Prisma.ResourceSelect,
    });
    // 动态字段 key 会返回联合类型，此处统一以行记录读取并窄化到具体标量类型
    return rows.map((row) => {
      const record = row as unknown as Record<string, unknown>;
      return {
        id: record.id as string,
        sortKey: record[field] as Date | bigint | string | null,
      };
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
    const result = await this.prisma.resource.updateMany({
      where: { id: { in: ids }, deletedAt: null },
      data: { categoryId },
    });
    return result.count;
  }

  async batchSetFavorite(ids: string[], isFavorite: boolean): Promise<number> {
    const result = await this.prisma.resource.updateMany({
      where: { id: { in: ids }, deletedAt: null },
      data: { isFavorite },
    });
    return result.count;
  }

  async batchSoftDelete(ids: string[]): Promise<number> {
    const result = await this.prisma.resource.updateMany({
      where: { id: { in: ids }, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return result.count;
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
   */
  async batchRestore(ids: string[]): Promise<{ restored: number; failedIds: string[] }> {
    const existing = await this.prisma.resource.findMany({
      where: { id: { in: ids } },
      select: { id: true, deletedAt: true },
    });
    const restorableIds = existing
      .filter((resource) => resource.deletedAt !== null)
      .map((resource) => resource.id);
    const restorableSet = new Set(restorableIds);

    // 没有可恢复的资源时直接返回，避免发一次无意义的 updateMany
    if (restorableIds.length === 0) {
      return { restored: 0, failedIds: ids };
    }

    const result = await this.prisma.resource.updateMany({
      where: { id: { in: restorableIds }, deletedAt: { not: null } },
      data: { deletedAt: null },
    });

    return {
      restored: result.count,
      failedIds: ids.filter((id) => !restorableSet.has(id)),
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
