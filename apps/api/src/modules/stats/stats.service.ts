import { Injectable } from '@nestjs/common';
import { ResourceType } from '../../common/constants/enums';
import { StatsRepository } from './repositories/stats.repository';

export interface ResourceTypeStatsItem {
  type: ResourceType;
  count: number;
  percentage: number;
}

export interface DashboardStats {
  resourceTotal: number;
  totalStorageBytes: string;
  processingStats: {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    canceled: number;
  };
  resourceTypes: ResourceTypeStatsItem[];
  recentFailedJobs: Array<{
    id: string;
    resourceId: string;
    jobType: string;
    status: string;
    errorMessage: string | null;
    retryCount: number;
    startedAt: Date | null;
    finishedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    resource: {
      id: string;
      title: string;
      originalFilename: string;
    };
  }>;
}

@Injectable()
export class StatsService {
  constructor(private readonly statsRepo: StatsRepository) {}

  /**
   * 资源类型分布。
   * 补齐所有已知类型，方便前端稳定渲染空状态和顺序。
   */
  async getResourceTypeStats(): Promise<ResourceTypeStatsItem[]> {
    const rows = await this.statsRepo.countResourcesByType();
    const counts = new Map(rows.map((row) => [row.resourceType, row.count]));
    const total = rows.reduce((sum, row) => sum + row.count, 0);

    return Object.values(ResourceType)
      .map((type) => {
        const count = counts.get(type) ?? 0;
        return {
          type,
          count,
          percentage: total === 0 ? 0 : Math.round((count / total) * 1000) / 10,
        };
      })
      .sort((a, b) => b.count - a.count);
  }

  async getDashboardStats(): Promise<DashboardStats> {
    const [resourceTotal, totalStorageBytes, processingStats, resourceTypes, recentFailedJobs] =
      await Promise.all([
        this.statsRepo.countResources(),
        this.statsRepo.totalStorageBytes(),
        this.statsRepo.processingStats(),
        this.getResourceTypeStats(),
        this.statsRepo.recentFailedJobs(),
      ]);

    return {
      resourceTotal,
      totalStorageBytes: totalStorageBytes.toString(),
      processingStats: {
        pending: processingStats.pending ?? 0,
        processing: processingStats.processing ?? 0,
        completed: processingStats.completed ?? 0,
        failed: processingStats.failed ?? 0,
        canceled: processingStats.canceled ?? 0,
      },
      resourceTypes,
      recentFailedJobs,
    };
  }
}
