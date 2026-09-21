import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { SourceService } from './source.service';
import { CreateSourceDto } from './dto/create-source.dto';
import { UpdateSourceDto } from './dto/update-source.dto';
import { QuerySourcesDto } from './dto/query-sources.dto';

@Controller('sources')
export class SourceController {
  constructor(private readonly sourceService: SourceService) {}

  /** 查询来源配置列表 */
  @Get()
  list(@Query() query: QuerySourcesDto) {
    return this.sourceService.listSources(query);
  }

  /** 获取可选的下载目录列表（供前端“选择目录”） */
  @Get('directories')
  directories() {
    return this.sourceService.listDownloadDirectories();
  }

  /** 获取单个来源 */
  @Get(':id')
  get(@Param('id') id: string) {
    return this.sourceService.getSource(id);
  }

  /** 创建来源配置 */
  @Post()
  create(@Body() dto: CreateSourceDto) {
    return this.sourceService.createSource(dto);
  }

  /** 更新来源配置（含启用/禁用） */
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSourceDto) {
    return this.sourceService.updateSource(id, dto);
  }

  /** 删除来源（关联记录经外键 SetNull/Cascade 自动处理，资源保留） */
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.sourceService.deleteSource(id);
  }
}
