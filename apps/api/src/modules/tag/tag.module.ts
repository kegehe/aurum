import { Module } from '@nestjs/common';
import { TagRepository } from './repositories/tag.repository';
import { TagService } from './tag.service';
import { TagController } from './tag.controller';

/**
 * 标签模块（阶段 7：完整 CRUD + 资源关联）
 */
@Module({
  controllers: [TagController],
  providers: [TagRepository, TagService],
  exports: [TagRepository],
})
export class TagModule {}
