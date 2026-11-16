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
import { SearchModule } from './modules/search/search.module';
import { CategoryModule } from './modules/category/category.module';
import { StatsModule } from './modules/stats/stats.module';
import { ConsistencyModule } from './modules/consistency/consistency.module';
import { SourceModule } from './modules/source/source.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';
import { StyleModule } from './modules/style/style.module';
import { AiSettingsModule } from './modules/ai-settings/ai-settings.module';
import { AiUsageModule } from './modules/ai-usage/ai-usage.module';
import { DesignModule } from './modules/design/design.module';

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
    SearchModule,
    CategoryModule,
    StatsModule,
    ConsistencyModule,
    SourceModule,
    IngestionModule,
    StyleModule,
    AiSettingsModule,
    AiUsageModule,
    DesignModule,
    // Resource/Upload 模块的 controller/service 在后续步骤填充，
    // 注册顺序：Resource 依赖 Storage/File/Processing/Category
    ResourceModule,
    UploadModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
