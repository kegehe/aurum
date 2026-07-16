import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Collection, Prisma } from '@prisma/client';

@Injectable()
export class CollectionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 集合列表（不含已软删除） */
  findAll(): Promise<Collection[]> {
    return this.prisma.collection.findMany({
      where: { deletedAt: null },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /** 集合列表（含封面和未删除资源关联） */
  async findAllWithCover() {
    return this.prisma.collection.findMany({
      where: { deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      include: {
        coverResource: {
          select: { id: true, title: true, resourceType: true, deletedAt: true },
        },
        resources: {
          where: { resource: { deletedAt: null } },
          select: {
            resourceId: true,
          },
        },
      },
    });
  }

  findById(id: string): Promise<Collection | null> {
    return this.prisma.collection.findFirst({
      where: { id, deletedAt: null },
    });
  }

  /** 集合详情（含资源列表，不返回已删除集合） */
  async findByIdWithResources(id: string) {
    return this.prisma.collection.findFirst({
      where: { id, deletedAt: null },
      include: {
        coverResource: { select: { id: true, title: true, resourceType: true, deletedAt: true } },
        resources: {
          where: { resource: { deletedAt: null } },
          orderBy: { sortOrder: 'asc' },
          include: {
            resource: {
              select: {
                id: true,
                title: true,
                description: true,
                originalFilename: true,
                resourceType: true,
                mimeType: true,
                extension: true,
                sizeBytes: true,
                sha256: true,
                categoryId: true,
                source: true,
                author: true,
                licenseNote: true,
                isFavorite: true,
                processingStatus: true,
                duplicateOfId: true,
                width: true,
                height: true,
                durationSeconds: true,
                searchVector: true,
                createdAt: true,
                updatedAt: true,
                deletedAt: true,
              },
            },
          },
        },
      },
    });
  }

  /** 创建集合 */
  async create(data: { name: string; description?: string; coverResourceId?: string }): Promise<Collection> {
    return this.prisma.collection.create({
      data: {
        name: data.name,
        description: data.description,
        coverResourceId: data.coverResourceId,
      },
    });
  }

  /** 更新集合 */
  async update(id: string, data: { name?: string; description?: string; coverResourceId?: string | null }): Promise<Collection> {
    const existing = await this.findById(id);
    if (!existing) throw new NotFoundException(`Collection ${id} not found`);
    return this.prisma.collection.update({ where: { id }, data });
  }

  /** 软删除集合 */
  async softDelete(id: string): Promise<Collection> {
    const existing = await this.findById(id);
    if (!existing) throw new NotFoundException(`Collection ${id} not found`);
    return this.prisma.collection.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  // ==================== 集合-资源关联 ====================

  /** 添加资源到集合 */
  async addResource(collectionId: string, resourceId: string, sortOrder?: number): Promise<void> {
    try {
      await this.prisma.collectionResource.create({
        data: {
          collectionId,
          resourceId,
          sortOrder: sortOrder ?? 0,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return;
      }
      throw e;
    }
  }

  /** 从集合移除资源 */
  async removeResource(collectionId: string, resourceId: string): Promise<void> {
    try {
      await this.prisma.collectionResource.delete({
        where: {
          collectionId_resourceId: { collectionId, resourceId },
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        return;
      }
      throw e;
    }
  }

  /** 批量添加资源到集合 */
  async batchAddResources(collectionId: string, resourceIds: string[]): Promise<number> {
    let count = 0;
    for (const resourceId of resourceIds) {
      try {
        await this.prisma.collectionResource.create({
          data: { collectionId, resourceId, sortOrder: 0 },
        });
        count++;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError) {
          if (e.code === 'P2002' || e.code === 'P2003') {
            continue;
          }
        }
        throw e;
      }
    }
    return count;
  }

  /** 更新集合内资源的排序 */
  async updateResourceSortOrder(collectionId: string, resourceId: string, sortOrder: number): Promise<void> {
    await this.prisma.collectionResource.update({
      where: {
        collectionId_resourceId: { collectionId, resourceId },
      },
      data: { sortOrder },
    });
  }
}
