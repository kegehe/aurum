import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Category } from '@prisma/client';

/**
 * 分类仓储（阶段7完整实现）
 */
@Injectable()
export class CategoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<Category[]> {
    return this.prisma.category.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  /**
   * 按名称和 parentId 查找分类
   * 使用复合唯一约束 @@unique([name, parentId])
   */
  findByName(name: string, parentId: string | null = null): Promise<Category | null> {
    return this.prisma.category.findFirst({
      where: parentId === null ? { name, parentId: null } : { name, parentId },
    });
  }

  findById(id: string): Promise<Category | null> {
    return this.prisma.category.findUnique({ where: { id } });
  }
}
