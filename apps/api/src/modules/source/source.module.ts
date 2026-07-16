import { Module } from '@nestjs/common';
import { SourceController } from './source.controller';
import { SourceService } from './source.service';
import { SourceRepository } from './repositories/source.repository';

/**
 * 来源配置模块
 *
 * 职责：外部来源（Source）的 CRUD 管理
 * - 创建、查询、更新、删除来源配置
 * - allowedModes 校验、slug 唯一性约束
 * - 禁用来源时不断开已有资源关联
 *
 * 导出 SourceRepository 供 IngestionModule 使用
 */
@Module({
  controllers: [SourceController],
  providers: [SourceService, SourceRepository],
  exports: [SourceRepository],
})
export class SourceModule {}
