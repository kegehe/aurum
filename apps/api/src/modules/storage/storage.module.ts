import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { STORAGE_SERVICE } from './interfaces/storage-service.interface';
import { LocalStorageDriver } from './local-storage.driver';

/**
 * 存储模块
 * 通过 STORAGE_SERVICE token 注入驱动实现，未来切换 S3/MinIO 只需替换 useClass。
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: STORAGE_SERVICE,
      useClass: LocalStorageDriver,
    },
  ],
  exports: [STORAGE_SERVICE],
})
export class StorageModule {}
