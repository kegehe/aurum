import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StorageModule } from '../storage/storage.module';
import { ConsistencyController } from './consistency.controller';
import { ConsistencyService } from './consistency.service';
import { ConsistencyRepository } from './repositories/consistency.repository';

/**
 * 一致性检查模块（阶段12实现）
 * 职责：数据库与文件存储一致性检查、孤儿文件清理、临时文件清理
 */
@Module({
  imports: [ConfigModule, StorageModule],
  controllers: [ConsistencyController],
  providers: [ConsistencyService, ConsistencyRepository],
})
export class ConsistencyModule {}
