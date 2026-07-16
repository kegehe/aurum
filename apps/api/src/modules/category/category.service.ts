import { Injectable, NotFoundException } from '@nestjs/common';
import { CategoryRepository, CategoryTreeItem } from './repositories/category.repository';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';

@Injectable()
export class CategoryService {
  constructor(private readonly categoryRepo: CategoryRepository) {}

  /** 分类树（含子分类和资源数量，单次查询获取所有计数） */
  async tree() {
    // 一次查询获取所有分类的资源计数
    const counts = await this.categoryRepo.resourceCountsByCategory();

    const roots = await this.categoryRepo.findTree();
    const attachCounts = (category: CategoryTreeItem): CategoryTreeItem & { resourceCount: number } => ({
      ...category,
      resourceCount: counts[category.id] ?? 0,
      children: category.children.map(attachCounts),
    });
    const items = roots.map(attachCounts);
    return { items };
  }

  /** 创建分类 */
  async create(dto: CreateCategoryDto) {
    return this.categoryRepo.create({
      name: dto.name,
      parentId: dto.parentId ?? null,
      sortOrder: dto.sortOrder,
    });
  }

  /** 更新分类 */
  async update(id: string, dto: UpdateCategoryDto) {
    const existing = await this.categoryRepo.findById(id);
    if (!existing) throw new NotFoundException(`Category ${id} not found`);
    return this.categoryRepo.update(id, {
      name: dto.name,
      parentId: dto.parentId,
      sortOrder: dto.sortOrder,
    });
  }

  /** 删除分类 */
  async delete(id: string) {
    const existing = await this.categoryRepo.findById(id);
    if (!existing) throw new NotFoundException(`Category ${id} not found`);
    await this.categoryRepo.delete(id);
    return { id, deleted: true };
  }

  /** 批量设置资源分类 */
  async batchSetResourceCategory(resourceIds: string[], categoryId: string | null) {
    const count = await this.categoryRepo.batchSetResourceCategory(resourceIds, categoryId);
    return { resourceIds, categoryId, updated: count };
  }
}
