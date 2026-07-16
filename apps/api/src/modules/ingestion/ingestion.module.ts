import { Module } from '@nestjs/common';
import { ResourceModule } from '../resource/resource.module';
import { SourceModule } from '../source/source.module';
import { SafeUrlService } from '../../common/security/safe-url.service';
import { LinkMetadataConnector } from './connectors/link-metadata.connector';
import { IngestionController } from './ingestion.controller';
import { IngestionScheduler } from './ingestion.scheduler';
import { IngestionService } from './ingestion.service';
import { IngestionJobRepository } from './repositories/ingestion-job.repository';

@Module({
  imports: [SourceModule, ResourceModule],
  controllers: [IngestionController],
  providers: [
    IngestionService,
    IngestionScheduler,
    IngestionJobRepository,
    SafeUrlService,
    LinkMetadataConnector,
  ],
})
export class IngestionModule {}
