import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  SearchResourceDto,
  ResourceSortField,
  SortOrder,
  TagFilterMode,
  DateRangeDto,
} from './dto/search-resource.dto';

/**
 * 搜索服务
 *
 * 职责：将 SearchResourceDto 转化为 Prisma ResourceWhereInput / OrderByInput
 *
 * SQLite 阶段：
 * - keyword 搜索使用 Prisma contains（底层 LIKE '%keyword%'）
 * - searchVector 字段存纯文本，同样用 contains 匹配
 * - 不走索引，但对个人资源管理工具（<10K 资源）可接受
 *
 * PostgreSQL 阶段：
 * - searchVector 改为 tsvector + GIN 索引
 * - keyword 搜索改为 @@ to_tsquery()
 * - 支持 ts_rank() 相关度排序
 */
@Injectable()
export class SearchService {
  /**
   * 构建 Prisma ResourceWhereInput
   *
   * 所有筛选条件组合为 AND 关系（keyword 内部为 OR）。
   * 向后兼容：单值 tagId/categoryId/resourceType 仍可使用。
   */
  buildWhereClause(dto: SearchResourceDto): Prisma.ResourceWhereInput {
    const conditions: Prisma.ResourceWhereInput[] = [];

    // 软删除过滤（默认排除已删除）
    if (!dto.includeDeleted) {
      conditions.push({ deletedAt: null });
    }

    // 关键词搜索（OR 跨多字段）
    if (dto.keyword) {
      conditions.push({
        OR: [
          { title: { contains: dto.keyword } },
          { originalFilename: { contains: dto.keyword } },
          { description: { contains: dto.keyword } },
          { source: { contains: dto.keyword } },
          { author: { contains: dto.keyword } },
          { searchVector: { contains: dto.keyword } },
        ],
      });
    }

    // 结构化字段搜索
    if (dto.source) {
      conditions.push({ source: { contains: dto.source } });
    }
    if (dto.author) {
      conditions.push({ author: { contains: dto.author } });
    }

    // 资源类型筛选
    if (dto.resourceType) {
      conditions.push({ resourceType: dto.resourceType });
    } else if (dto.resourceTypes?.length) {
      conditions.push({ resourceType: { in: dto.resourceTypes } });
    }

    // 分类筛选
    if (dto.categoryId) {
      conditions.push({ categoryId: dto.categoryId });
    } else if (dto.categoryIds?.length) {
      conditions.push({ categoryId: { in: dto.categoryIds } });
    } else if (dto.uncategorized) {
      conditions.push({ categoryId: null });
    }

    // 标签筛选（支持 AND/OR 多标签）
    const effectiveTagIds = dto.tagIds?.length
      ? dto.tagIds
      : dto.tagId
        ? [dto.tagId]
        : undefined;
    if (effectiveTagIds?.length) {
      const tagMode = dto.tagMode ?? TagFilterMode.and;
      if (tagMode === TagFilterMode.and) {
        // AND：资源必须同时拥有所有指定标签
        conditions.push(
          ...effectiveTagIds.map((tagId) => ({
            tags: { some: { tagId } },
          })),
        );
      } else {
        // OR：资源拥有任一指定标签即可
        conditions.push({
          tags: { some: { tagId: { in: effectiveTagIds } } },
        });
      }
    }

    // 日期范围筛选
    if (dto.createdAtRange) {
      const range = this.buildDateRange(dto.createdAtRange);
      if (range) conditions.push({ createdAt: range });
    }
    if (dto.updatedAtRange) {
      const range = this.buildDateRange(dto.updatedAtRange);
      if (range) conditions.push({ updatedAt: range });
    }

    // 文件大小范围筛选
    if (dto.sizeRange) {
      const sizeFilter: Prisma.BigIntFilter<'Resource'> = {};
      if (dto.sizeRange.min !== undefined) sizeFilter.gte = BigInt(dto.sizeRange.min);
      if (dto.sizeRange.max !== undefined) sizeFilter.lte = BigInt(dto.sizeRange.max);
      if (sizeFilter.gte !== undefined || sizeFilter.lte !== undefined) {
        conditions.push({ sizeBytes: sizeFilter });
      }
    }

    // 获取模式筛选
    if (dto.acquisitionMode) {
      conditions.push({ acquisitionMode: dto.acquisitionMode });
    }

    // 布尔/枚举筛选
    if (dto.isFavorite !== undefined) {
      conditions.push({ isFavorite: dto.isFavorite });
    }
    if (dto.processingStatus) {
      conditions.push({ processingStatus: dto.processingStatus });
    }

    // 合并所有条件
    if (conditions.length === 0) return {};
    if (conditions.length === 1) return conditions[0];
    return { AND: conditions };
  }

  /**
   * 构建排序条件
   */
  buildOrderBy(
    sortBy?: ResourceSortField,
    sortOrder?: SortOrder,
  ): Prisma.ResourceOrderByWithRelationInput {
    const field = sortBy ?? ResourceSortField.createdAt;
    const order = sortOrder ?? SortOrder.desc;
    return { [field]: order };
  }

  /**
   * 构建日期范围 Prisma filter
   */
  private buildDateRange(
    range: DateRangeDto,
  ): Prisma.DateTimeFilter | undefined {
    const filter: Prisma.DateTimeFilter = {};
    if (range.start) filter.gte = new Date(range.start);
    if (range.end) filter.lte = new Date(range.end);
    return Object.keys(filter).length ? filter : undefined;
  }
}
