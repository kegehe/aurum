import { Controller, Get, Post, Patch, Delete, Param, Body } from '@nestjs/common';
import { TagService } from './tag.service';
import { CreateTagDto, UpdateTagDto } from './dto/tag.dto';

@Controller('tags')
export class TagController {
  constructor(private readonly tagService: TagService) {}

  /** 标签列表 */
  @Get()
  list() {
    return this.tagService.list();
  }

  /** 创建标签 */
  @Post()
  create(@Body() dto: CreateTagDto) {
    return this.tagService.create(dto);
  }

  /** 更新标签 */
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTagDto) {
    return this.tagService.update(id, dto);
  }

  /** 删除标签 */
  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.tagService.delete(id);
  }
}
