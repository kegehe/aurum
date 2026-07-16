import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { Tag } from '@prisma/client';

/**
 * 标签仓储
 * 管理 tags 和 resource_tags 表
 */
@Injectable()
export class TagRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<Tag[]> {
    return this.prisma.tag.findMany({ orderBy: { name: 'asc' } });
  }

  findByName(name: string): Promise<Tag | null> {
    return this.prisma.tag.findUnique({ where: { name } });
  }

  findById(id: string): Promise<Tag | null> {
    return this.prisma.tag.findUnique({ where: { id } });
  }

  async create(data: { name: string; color?: string }): Promise<Tag> {
    // 名称唯一校验
    const existing = await this.findByName(data.name);
    if (existing) {
      throw new ConflictException(`Tag "${data.name}" already exists`);
    }
    return this.prisma.tag.create({
      data: { name: data.name, color: data.color },
    });
  }

  async update(id: string, data: { name?: string; color?: string }): Promise<Tag> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new NotFoundException(`Tag ${id} not found`);
    }
    // 如果改名称，检查新名称是否冲突
    if (data.name && data.name !== existing.name) {
      const conflict = await this.findByName(data.name);
      if (conflict) {
        throw new ConflictException(`Tag "${data.name}" already exists`);
      }
    }
    return this.prisma.tag.update({ where: { id }, data });
  }

  async delete(id: string): Promise<Tag> {
    // 删除标签会级联删除 resource_tags 关联（Prisma onDelete: Cascade）
    return this.prisma.tag.delete({ where: { id } });
  }

  /** 获取标签使用次数（关联的资源数） */
  async usageCount(id: string): Promise<number> {
    return this.prisma.resourceTag.count({ where: { tagId: id } });
  }

  /** 查询标签列表，附带使用次数 */
  async findAllWithUsage(): Promise<Array<Tag & { usageCount: number }>> {
    const tags = await this.prisma.tag.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { resources: true } } },
    });
    return tags.map((t) => ({
      ...t,
      usageCount: t._count.resources,
    }));
  }

  // ==================== 资源-标签关联 ====================

  /** 为资源添加标签（幂等） */
  async addToResource(resourceId: string, tagId: string): Promise<void> {
    try {
      await this.prisma.resourceTag.create({
        data: { resourceId, tagId },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (e.code === 'P2002') return; // 唯一约束冲突（重复添加），忽略
        if (e.code === 'P2003') throw new ConflictException('Resource or tag not found');
      }
      throw e;
    }
  }

  /** 从资源移除标签 */
  async removeFromResource(resourceId: string, tagId: string): Promise<void> {
    try {
      await this.prisma.resourceTag.delete({
        where: { resourceId_tagId: { resourceId, tagId } },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        return; // 关联不存在，忽略
      }
      throw e;
    }
  }

  /** 批量添加标签（幂等） */
  async batchAddToResources(resourceIds: string[], tagIds: string[]): Promise<number> {
    let count = 0;
    for (const resourceId of resourceIds) {
      for (const tagId of tagIds) {
        try {
          await this.prisma.resourceTag.create({ data: { resourceId, tagId } });
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
    }
    return count;
  }

  /** 批量移除标签 */
  async batchRemoveFromResources(resourceIds: string[], tagIds: string[]): Promise<number> {
    const result = await this.prisma.resourceTag.deleteMany({
      where: {
        resourceId: { in: resourceIds },
        tagId: { in: tagIds },
      },
    });
    return result.count;
  }

  /** 获取资源的标签列表 */
  findByResourceId(resourceId: string) {
    return this.prisma.resourceTag.findMany({
      where: { resourceId },
      include: { tag: true },
    });
  }
}
