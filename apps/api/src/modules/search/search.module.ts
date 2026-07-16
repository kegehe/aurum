import { Module } from '@nestjs/common';
import { SearchService } from './search.service';

/**
 * 搜索模块（阶段 8：搜索与筛选）
 *
 * 职责：
 * - 提供 SearchService，将搜索 DTO 转化为 Prisma 查询条件
 * - keyword 搜索：title / originalFilename / description / source / author / searchVector
 * - 结构化筛选：类型、分类、标签（AND/OR）、日期范围、大小范围、收藏、处理状态
 * - 排序构建
 *
 * 架构：SearchService 被 ResourceService 调用，不单独暴露 Controller。
 * 端点仍为 GET /resources，语义上是资源列表 + 搜索/筛选。
 *
 * PostgreSQL 迁移：
 * - searchVector 字段改为 tsvector + GIN 索引
 * - keyword 搜索改为 @@ to_tsquery()
 */
@Module({
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
