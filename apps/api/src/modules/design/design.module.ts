import { Module } from '@nestjs/common';
import { DesignController } from './design.controller';
import { DesignService } from './design.service';
import { DesignTaskProcessor } from './design-task.processor';
import { AiSettingsModule } from '../ai-settings/ai-settings.module';
import { DesignAgentService } from './design-agent.service';
import { StorageModule } from '../storage/storage.module';
import { ControlledRendererService } from './controlled-renderer.service';
import { SourceModule } from '../source/source.module';
import { SafeUrlService } from '../../common/security/safe-url.service';
import { DesignReferenceService } from './design-reference.service';
import { DesignInternalGuard } from './design-internal.guard';

@Module({
  imports: [AiSettingsModule, StorageModule, SourceModule],
  controllers: [DesignController],
  providers: [
    DesignService,
    DesignTaskProcessor,
    DesignAgentService,
    ControlledRendererService,
    SafeUrlService,
    DesignReferenceService,
    DesignInternalGuard,
  ],
  exports: [DesignService],
})
export class DesignModule {}
