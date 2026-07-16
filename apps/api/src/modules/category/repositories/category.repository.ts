import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Category } from '@prisma/client';

export type CategoryTreeItem = Category & {
  children: CategoryTreeItem[];
};

@Injectable()
export class CategoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<Category[]> {
    return this.prisma.category.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  /**
   * 获取分类树（含子分类）
   */
  async findTree(): Promise<CategoryTreeItem[]> {
    const categories = await this.prisma.category.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    const byId = new Map<string, CategoryTreeItem>();
    const roots: CategoryTreeItem[] = [];

    for (const category of categories) {
      byId.set(category.id, { ...category, children: [] });
    }

    for (const category of byId.values()) {
      if (category.parentId) {
        const parent = byId.get(category.parentId);
        if (parent) {
          parent.children.push(category);
          continue;
        }
      }
      roots.push(category);
    }

    return roots;
  }

  /**
   * 按名称和 parentId 查找分类（复合唯一约束）
   */
  findByName(name: string, parentId: string | null = null): Promise<Category | null> {
    return this.prisma.category.findFirst({
      where: parentId === null ? { name, parentId: null } : { name, parentId },
    });
  }

  findById(id: string): Promise<Category | null> {
    return this.prisma.category.findUnique({ where: { id } });
  }

  /** 获取分类下的资源数量 */
  async resourceCount(id: string): Promise<number> {
    return this.prisma.resource.count({ where: { categoryId: id, deletedAt: null } });
  }

  /** 获取所有分类的资源数量（一次 groupBy 查询，避免 N+1） */
  async resourceCountsByCategory(): Promise<Record<string, number>> {
    const results = await this.prisma.resource.groupBy({
      by: ['categoryId'],
      where: { deletedAt: null, categoryId: { not: null } },
      _count: { categoryId: true },
    });
    const counts: Record<string, number> = {};
    for (const r of results) {
      if (r.categoryId) {
        counts[r.categoryId] = r._count.categoryId;
      }
    }
    return counts;
  }

  /** 创建分类 */
  async create(data: { name: string; parentId?: string | null; sortOrder?: number }): Promise<Category> {
    // 检查名称+父级唯一性
    const parentId = data.parentId ?? null;
    const existing = await this.findByName(data.name, parentId);
    if (existing) {
      throw new ConflictException(
        `Category "${data.name}" already exists${parentId ? ' under this parent' : ''}`,
      );
    }
    // 验证父分类存在
    if (parentId) {
      const parent = await this.findById(parentId);
      if (!parent) throw new NotFoundException(`Parent category ${parentId} not found`);
    }
    return this.prisma.category.create({
      data: { name: data.name, parentId, sortOrder: data.sortOrder ?? 0 },
    });
  }

  /** 更新分类 */
  async update(id: string, data: { name?: string; parentId?: string | null; sortOrder?: number }): Promise<Category> {
    const existing = await this.findById(id);
    if (!existing) throw new NotFoundException(`Category ${id} not found`);

    const nextName = data.name ?? existing.name;
    const nextParentId = data.parentId !== undefined ? (data.parentId ?? null) : existing.parentId;

    if (nextParentId) {
      await this.assertValidParent(id, nextParentId);
    }

    // 名称或父级变化时，都需要检查同级重名。
    if (nextName !== existing.name || nextParentId !== existing.parentId) {
      const conflict = await this.findByName(nextName, nextParentId);
      if (conflict && conflict.id !== id) {
        throw new ConflictException(`Category "${nextName}" already exists`);
      }
    }

    return this.prisma.category.update({ where: { id }, data });
  }

  /**
   * 防止循环引用：父分类不能是自己或任意层级的子孙。
   */
  private async assertValidParent(id: string, parentId: string): Promise<void> {
    let currentId: string | null = parentId;

    while (currentId) {
      if (currentId === id) {
        throw new ConflictException('Category cannot use itself or its descendant as parent');
      }

      const current = await this.findById(currentId);
      if (!current) throw new NotFoundException(`Parent category ${parentId} not found`);
      currentId = current.parentId;
    }
  }

  /** 删除分类 */
  async delete(id: string): Promise<void> {
    const existing = await this.findById(id);
    if (!existing) throw new NotFoundException(`Category ${id} not found`);
    // 子分类的 parentId 会被 SetNull
    // 资源的 categoryId 也会被 SetNull
    await this.prisma.category.delete({ where: { id } });
  }

  /** 批量更新资源的分类 */
  async batchSetResourceCategory(resourceIds: string[], categoryId: string | null): Promise<number> {
    const result = await this.prisma.resource.updateMany({
      where: { id: { in: resourceIds }, deletedAt: null },
      data: { categoryId },
    });
    return result.count;
  }
}
