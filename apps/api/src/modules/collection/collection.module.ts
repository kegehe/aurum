import { Module } from '@nestjs/common';
import { CollectionRepository } from './repositories/collection.repository';

/**
 * 集合模块（阶段7完整实现 CRUD）
 */
@Module({
  providers: [CollectionRepository],
  exports: [CollectionRepository],
})
export class CollectionModule {}
