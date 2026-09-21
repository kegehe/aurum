import { Module } from '@nestjs/common';
import { StyleController } from './style.controller';
import { StyleService } from './style.service';
import { ClaudeVisionClient } from './claude-vision.client';
import { AiSettingsModule } from '../ai-settings/ai-settings.module';

@Module({
  imports: [AiSettingsModule],
  controllers: [StyleController],
  providers: [StyleService, ClaudeVisionClient],
  exports: [StyleService],
})
export class StyleModule {}
