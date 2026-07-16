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
   * 查询详情：含文件、标签、重复源资源
   */
  findByIdWithRelations(id: string) {
    return this.prisma.resource.findUnique({
      where: { id },
      include: {
        files: { orderBy: { createdAt: 'asc' } },
        tags: { include: { tag: true } },
        duplicateOf: { select: { id: true, title: true } },
        sourceRecord: { select: { id: true, name: true, slug: true } },
        license: { select: { id: true, spdxId: true, name: true, url: true } },
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
   * 默认排除已软删除资源（includeDeleted=true 时包含，用于回收站）
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
    });
  }

  count(where?: Prisma.ResourceWhereInput): Promise<number> {
    return this.prisma.resource.count({ where });
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
