import { Module } from '@nestjs/common';
import { ResourceController } from './resource.controller';
import { ResourceService } from './resource.service';
import { ResourceRepository } from './repositories/resource.repository';
import { FileModule } from '../file/file.module';
import { StorageModule } from '../storage/storage.module';

/**
 * 资源模块
 * 职责：资源主数据 CRUD、详情、更新、删除、恢复
 */
@Module({
  imports: [FileModule, StorageModule],
  controllers: [ResourceController],
  providers: [ResourceService, ResourceRepository],
  exports: [ResourceRepository],
})
export class ResourceModule {}
