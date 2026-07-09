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

  /** 软删除：设置 deletedAt */
  async softDelete(id: string): Promise<Resource> {
    return this.prisma.resource.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /** 恢复：清空 deletedAt */
  async restore(id: string): Promise<Resource> {
    return this.prisma.resource.update({
      where: { id },
      data: { deletedAt: null },
    });
  }
}
