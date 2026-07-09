import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { ResourceModule } from '../resource/resource.module';
import { FileModule } from '../file/file.module';
import { ProcessingModule } from '../processing/processing.module';
import { StorageModule } from '../storage/storage.module';

/**
 * 上传模块
 * 依赖 Storage（文件存储）、Resource/File/Processing（仓储）
 */
@Module({
  imports: [StorageModule, ResourceModule, FileModule, ProcessingModule],
  controllers: [UploadController],
  providers: [UploadService],
})
export class UploadModule {}
