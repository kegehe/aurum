import { Module } from '@nestjs/common';
import { LicenseController } from './license.controller';
import { LicenseService } from './license.service';
import { LicenseRepository } from './repositories/license.repository';

/**
 * 许可证模块
 *
 * 职责：许可证（License）的 CRUD 管理
 * - 创建、查询、更新、删除许可证
 * - spdxId 唯一性约束
 * - 删除保护：有资源或来源引用时拒绝删除
 *
 * 导出 LicenseRepository 供 SourceModule 和 IngestionModule 使用
 */
@Module({
  controllers: [LicenseController],
  providers: [LicenseService, LicenseRepository],
  exports: [LicenseRepository],
})
export class LicenseModule {}
