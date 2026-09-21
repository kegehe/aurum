import { Module } from '@nestjs/common';
import { ResourceModule } from '../resource/resource.module';
import { SourceModule } from '../source/source.module';
import { ProcessingModule } from '../processing/processing.module';
import { StorageModule } from '../storage/storage.module';
import { FileModule } from '../file/file.module';
import { SafeUrlService } from '../../common/security/safe-url.service';
import { LinkMetadataConnector } from './connectors/link-metadata.connector';
import { LocatorHealthChecker } from './connectors/locator-health-checker';
import { CivitaiConnector } from './connectors/civitai.connector';
import { GitHubConnector } from './connectors/github.connector';
import { FeedConnector } from './connectors/feed.connector';
import { IngestionController } from './ingestion.controller';
import { IngestionScheduler } from './ingestion.scheduler';
import { IngestionService } from './ingestion.service';
import { IngestionJobRepository } from './repositories/ingestion-job.repository';

@Module({
  imports: [SourceModule, ResourceModule, ProcessingModule, StorageModule, FileModule],
  controllers: [IngestionController],
  providers: [
    IngestionService,
    IngestionScheduler,
    IngestionJobRepository,
    SafeUrlService,
    LinkMetadataConnector,
    LocatorHealthChecker,
    CivitaiConnector,
    GitHubConnector,
    FeedConnector,
  ],
})
export class IngestionModule {}
