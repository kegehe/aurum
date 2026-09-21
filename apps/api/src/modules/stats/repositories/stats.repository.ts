import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface ResourceTypeCount {
  resourceType: string;
  count: number;
}

/**
 * 统计仓储
 * 封装 dashboard 需要的聚合查询。
 */
@Injectable()
export class StatsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 按资源类型统计未删除资源数量 */
  async countResourcesByType(): Promise<ResourceTypeCount[]> {
    const rows = await this.prisma.resource.groupBy({
      by: ['resourceType'],
      where: { deletedAt: null },
      _count: { resourceType: true },
    });

    return rows.map((row) => ({
      resourceType: row.resourceType,
      count: row._count.resourceType,
    }));
  }

  countResources(): Promise<number> {
    return this.prisma.resource.count({ where: { deletedAt: null } });
  }

  async totalStorageBytes(): Promise<bigint> {
    const result = await this.prisma.resource.aggregate({
      where: { deletedAt: null },
      _sum: { sizeBytes: true },
    });
    return result._sum.sizeBytes ?? BigInt(0);
  }

  async processingStats(): Promise<Record<string, number>> {
    const jobs = await this.prisma.processingJob.groupBy({
      by: ['status'],
      where: { resource: { deletedAt: null } },
      _count: { status: true },
    });
    const result: Record<string, number> = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      canceled: 0,
    };
    for (const job of jobs) {
      result[job.status] = job._count.status;
    }
    return result;
  }

  recentFailedJobs(limit: number = 5) {
    return this.prisma.processingJob.findMany({
      where: { status: 'failed', resource: { deletedAt: null } },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        resourceId: true,
        jobType: true,
        status: true,
        errorMessage: true,
        retryCount: true,
        startedAt: true,
        finishedAt: true,
        createdAt: true,
        updatedAt: true,
        resource: {
          select: {
            id: true,
            title: true,
            originalFilename: true,
          },
        },
      },
    });
  }
}
