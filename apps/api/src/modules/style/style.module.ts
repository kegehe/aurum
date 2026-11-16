import { Module } from '@nestjs/common';
import { StyleController } from './style.controller';
import { StyleService } from './style.service';
import { ClaudeVisionClient } from './claude-vision.client';
import { AiSettingsModule } from '../ai-settings/ai-settings.module';
import { AiUsageModule } from '../ai-usage/ai-usage.module';

@Module({
  imports: [AiSettingsModule, AiUsageModule],
  controllers: [StyleController],
  providers: [StyleService, ClaudeVisionClient],
  exports: [StyleService],
})
export class StyleModule {}
