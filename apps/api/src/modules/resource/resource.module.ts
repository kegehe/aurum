import { Module, forwardRef } from '@nestjs/common';
import { ResourceController } from './resource.controller';
import { ResourceService } from './resource.service';
import { ResourceRepository } from './repositories/resource.repository';
import { FileModule } from '../file/file.module';
import { StorageModule } from '../storage/storage.module';
import { ProcessingModule } from '../processing/processing.module';
import { SearchModule } from '../search/search.module';
import { CategoryModule } from '../category/category.module';

/**
 * 资源模块
 * 职责：资源主数据 CRUD、详情、更新、删除、恢复、重新处理
 */
@Module({
  imports: [
    FileModule,
    StorageModule,
    forwardRef(() => ProcessingModule),
    SearchModule,
    CategoryModule,
  ],
  controllers: [ResourceController],
  providers: [ResourceService, ResourceRepository],
  exports: [ResourceRepository],
})
export class ResourceModule {}
