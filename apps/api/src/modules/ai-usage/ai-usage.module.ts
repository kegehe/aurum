import { Module } from '@nestjs/common';
import { AiUsageController } from './ai-usage.controller';
import { AiUsageService } from './ai-usage.service';

/**
 * AI 用量统计模块
 *
 * 职责：
 * - 接收各 AI 调用点上报的用量（record）
 * - 提供统计页所需的聚合查询
 */
@Module({
  controllers: [AiUsageController],
  providers: [AiUsageService],
  exports: [AiUsageService],
})
export class AiUsageModule {}
