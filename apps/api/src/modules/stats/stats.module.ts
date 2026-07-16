import { Module } from '@nestjs/common';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';
import { StatsRepository } from './repositories/stats.repository';

/**
 * 统计模块
 * 职责：仪表盘聚合统计、资源类型分布等。
 */
@Module({
  controllers: [StatsController],
  providers: [StatsService, StatsRepository],
})
export class StatsModule {}
