import { Controller, Get, Post, Patch, Delete, Param, Body } from '@nestjs/common';
import { CategoryService } from './category.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';

/**
 * 分类/文件夹 API
 *
 * 独立的"分类管理"页面已移除，但资源库页面的文件夹功能仍依赖此控制器。
 * 前端资源库以"文件夹"形式使用分类，调用这些端点进行 CRUD。
 */
@Controller('categories')
export class CategoryController {
  constructor(private readonly categoryService: CategoryService) {}

  /** 分类树 */
  @Get()
  tree() {
    return this.categoryService.tree();
  }

  /** 创建分类 */
  @Post()
  create(@Body() dto: CreateCategoryDto) {
    return this.categoryService.create(dto);
  }

  /** 更新分类 */
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoryService.update(id, dto);
  }

  /** 删除分类 */
  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.categoryService.delete(id);
  }
}
