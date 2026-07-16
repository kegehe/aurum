import { Module } from '@nestjs/common';
import { CategoryRepository } from './repositories/category.repository';
import { CategoryService } from './category.service';
import { CategoryController } from './category.controller';

/**
 * 分类/文件夹模块
 *
 * 独立的"分类管理"页面已移除，CRUD 操作在资源库页面以"文件夹"形式完成。
 * Controller/Service 仍需保留，供资源库页面的文件夹功能调用。
 */
@Module({
  controllers: [CategoryController],
  providers: [CategoryRepository, CategoryService],
  exports: [CategoryRepository],
})
export class CategoryModule {}
