import { Module } from '@nestjs/common';
import { ResourceFileRepository } from './repositories/resource-file.repository';

/**
 * 资源文件模块
 * 职责：resource_files 表数据访问（原文件和派生文件记录）
 */
@Module({
  providers: [ResourceFileRepository],
  exports: [ResourceFileRepository],
})
export class FileModule {}
