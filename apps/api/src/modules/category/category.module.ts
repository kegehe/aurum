import { Module } from '@nestjs/common';
import { CategoryRepository } from './repositories/category.repository';

/**
 * 分类模块（阶段7完整实现 CRUD）
 */
@Module({
  providers: [CategoryRepository],
  exports: [CategoryRepository],
})
export class CategoryModule {}
