import { Module } from '@nestjs/common';
import { DesignController } from './design.controller';
import { DesignService } from './design.service';
import { DesignDocumentService } from './design-document.service';
import { DesignPublishService } from './design-publish.service';
import { DesignTaskProcessor } from './design-task.processor';
import { AiSettingsModule } from '../ai-settings/ai-settings.module';
import { AiUsageModule } from '../ai-usage/ai-usage.module';
import { DesignAgentService } from './design-agent.service';
import { StorageModule } from '../storage/storage.module';
import { ControlledRendererService } from './controlled-renderer.service';
import { SourceModule } from '../source/source.module';
import { SafeUrlService } from '../../common/security/safe-url.service';
import { DesignReferenceService } from './design-reference.service';
import { DesignInternalGuard } from './design-internal.guard';
import { DesignAssetService } from './design-asset.service';
import { DesignAssetSnapshotService } from './design-asset-snapshot.service';
import { DesignStudioService } from './design-studio.service';
import { DesignMediaService } from './design-media.service';
import { PreviewSnapshotJobService } from './preview/preview-snapshot-job.service';
import { PreviewSnapshotWorker } from './preview/preview-snapshot.worker';
import { ResourceModule } from '../resource/resource.module';
import { PreviewCompileService } from './preview/preview-compiler.service';
import { PreviewSnapshotService } from './preview/preview-snapshot.service';
import { PreviewRendererClient } from './preview/preview-renderer.client';

@Module({
  imports: [AiSettingsModule, AiUsageModule, StorageModule, SourceModule, ResourceModule],
  controllers: [DesignController],
  providers: [
    DesignService,
    DesignDocumentService,
    DesignPublishService,
    DesignTaskProcessor,
    DesignAgentService,
    ControlledRendererService,
    SafeUrlService,
    DesignReferenceService,
    DesignInternalGuard,
    PreviewCompileService,
    PreviewSnapshotService,
    PreviewRendererClient,
    DesignAssetService,
    DesignAssetSnapshotService,
    DesignStudioService,
    DesignMediaService,
    PreviewSnapshotJobService,
    PreviewSnapshotWorker,
  ],
  exports: [DesignService],
})
export class DesignModule {}
