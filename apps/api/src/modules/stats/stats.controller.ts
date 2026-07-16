import { Controller, Get } from '@nestjs/common';
import { StatsService } from './stats.service';

@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  /** 获取仪表盘统计汇总 */
  @Get('overview')
  overview() {
    return this.statsService.getDashboardStats();
  }

  /** 获取资源类型分布 */
  @Get('resource-types')
  resourceTypes() {
    return this.statsService.getResourceTypeStats();
  }
}
