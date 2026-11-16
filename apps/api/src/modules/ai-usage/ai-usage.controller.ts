import { Controller, Get, Query } from '@nestjs/common';
import { AiUsageService } from './ai-usage.service';

/**
 * AI 用量统计控制器
 *
 * 单接口返回概览所需全部数据，避免前端首屏发多个请求。
 */
@Controller('ai-usage')
export class AiUsageController {
  constructor(private readonly aiUsageService: AiUsageService) {}

  /** 概览：汇总指标 + 按天序列 + 功能/模型分布 + 最近明细 */
  @Get('overview')
  overview(@Query('days') days?: string) {
    return this.aiUsageService.getOverview(days === undefined ? undefined : Number(days));
  }
}
