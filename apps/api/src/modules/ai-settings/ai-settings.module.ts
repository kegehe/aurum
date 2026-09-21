import { Module } from '@nestjs/common';
import { AiSettingsController } from './ai-settings.controller';
import { AiSettingsService } from './ai-settings.service';
import { AiProviderRepository } from './repositories/ai-provider.repository';

/**
 * AI 供应商配置模块
 *
 * 职责：AI API Key / Base URL / 模型的多配置管理，运行时可切换生效配置。
 * - 导出 AiSettingsService，供 StyleModule（ClaudeVisionClient）解析生效配置
 */
@Module({
  controllers: [AiSettingsController],
  providers: [AiSettingsService, AiProviderRepository],
  exports: [AiSettingsService],
})
export class AiSettingsModule {}
