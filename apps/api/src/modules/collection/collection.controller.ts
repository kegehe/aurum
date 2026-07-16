import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
} from '@nestjs/common';
import { CollectionService } from './collection.service';
import { CreateCollectionDto, UpdateCollectionDto, BatchAddResourcesDto } from './dto/collection.dto';

@Controller('collections')
export class CollectionController {
  constructor(private readonly collectionService: CollectionService) {}

  /** 集合列表 */
  @Get()
  list() {
    return this.collectionService.list();
  }

  /** 集合详情 */
  @Get(':id')
  detail(@Param('id') id: string) {
    return this.collectionService.detail(id);
  }

  /** 创建集合 */
  @Post()
  create(@Body() dto: CreateCollectionDto) {
    return this.collectionService.create(dto);
  }

  /** 更新集合 */
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCollectionDto) {
    return this.collectionService.update(id, dto);
  }

  /** 删除集合 */
  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.collectionService.delete(id);
  }

  /** 添加资源到集合 */
  @Post(':id/resources/:resourceId')
  addResource(@Param('id') id: string, @Param('resourceId') resourceId: string) {
    return this.collectionService.addResource(id, resourceId);
  }

  /** 从集合移除资源 */
  @Delete(':id/resources/:resourceId')
  removeResource(@Param('id') id: string, @Param('resourceId') resourceId: string) {
    return this.collectionService.removeResource(id, resourceId);
  }

  /** 批量添加资源到集合 */
  @Post(':id/resources')
  batchAddResources(@Param('id') id: string, @Body() dto: BatchAddResourcesDto) {
    return this.collectionService.batchAddResources(id, dto.resourceIds);
  }

  /** 更新集合内资源排序 */
  @Patch(':id/resources/:resourceId/sort')
  updateSortOrder(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Body('sortOrder') sortOrder: number,
  ) {
    return this.collectionService.updateSortOrder(id, resourceId, sortOrder);
  }
}
