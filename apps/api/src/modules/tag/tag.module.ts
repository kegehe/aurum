import { Module } from '@nestjs/common';
import { TagRepository } from './repositories/tag.repository';

/**
 * 标签模块（阶段7完整实现 CRUD）
 */
@Module({
  providers: [TagRepository],
  exports: [TagRepository],
})
export class TagModule {}
