import { Module } from '@nestjs/common';
import { CollectionRepository } from './repositories/collection.repository';
import { CollectionService } from './collection.service';
import { CollectionController } from './collection.controller';

/**
 * 集合模块（阶段 7：完整 CRUD + 资源管理）
 */
@Module({
  controllers: [CollectionController],
  providers: [CollectionRepository, CollectionService],
  exports: [CollectionRepository],
})
export class CollectionModule {}
