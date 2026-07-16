import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import configuration from './common/config/configuration';
import { envValidationSchema } from './common/config/env.validation';
import { PrismaModule } from './modules/prisma/prisma.module';
import { StorageModule } from './modules/storage/storage.module';
import { ResourceModule } from './modules/resource/resource.module';
import { UploadModule } from './modules/upload/upload.module';
import { FileModule } from './modules/file/file.module';
import { ProcessingModule } from './modules/processing/processing.module';
import { MetadataModule } from './modules/metadata/metadata.module';
import { PreviewModule } from './modules/preview/preview.module';
import { SearchModule } from './modules/search/search.module';
import { TagModule } from './modules/tag/tag.module';
import { CategoryModule } from './modules/category/category.module';
import { CollectionModule } from './modules/collection/collection.module';
import { TrashModule } from './modules/trash/trash.module';
import { StatsModule } from './modules/stats/stats.module';
import { ConsistencyModule } from './modules/consistency/consistency.module';
import { SourceModule } from './modules/source/source.module';
import { LicenseModule } from './modules/license/license.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: envValidationSchema,
      validationOptions: {
        abortEarly: false,
      },
      envFilePath: ['.env'],
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    StorageModule,
    FileModule,
    ProcessingModule,
    MetadataModule,
    PreviewModule,
    SearchModule,
    TagModule,
    CategoryModule,
    CollectionModule,
    TrashModule,
    StatsModule,
    ConsistencyModule,
    SourceModule,
    LicenseModule,
    IngestionModule,
    // Resource/Upload 模块的 controller/service 在后续步骤填充，
    // 注册顺序：Resource 依赖 Storage/File/Processing/Tag/Category/Collection
    ResourceModule,
    UploadModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
