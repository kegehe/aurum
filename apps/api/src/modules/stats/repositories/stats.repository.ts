import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface ResourceTypeCount {
  resourceType: string;
  count: number;
}

export interface StorageUsage {
  /** 所有已登记资源文件按 storagePath 去重后的总占用（含回收站中尚未清理的文件） */
  totalBytes: bigint;
  /** 仅被回收站资源引用、清空回收站后可释放的字节数 */
  trashBytes: bigint;
}

interface StorageUsageRow {
  totalBytes: string | null;
  trashBytes: string | null;
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

  /**
   * 存储占用。
   *
   * 以 resource_files 为准而不是对 Resource.sizeBytes 求和：
   * - 只有真正落盘的文件才有 ResourceFile 记录，元数据类资源的 sizeBytes
   *   可能是远端大小或 0；
   * - 缩略图、提取文本等派生文件同样占用磁盘；
   * - 存储 key 按内容哈希生成，同一份磁盘文件常被多条资源引用（重复上传、
   *   回收站中删除后又上传同一文件），必须按 storagePath 去重。
   *
   * trashBytes 与回收站「可释放空间」口径一致（见 ResourceService.getTrashStats）：
   * 只有所有引用方都处于回收站的文件才算可回收。
   *
   * 用一条 SQL 同时算出两个值：
   * - 两个值必须来自同一快照，拆成两次查询会在并发上传/删除时把新文件
   *   误判成回收站占用；
   * - 数组式 $transaction 在 SQLite 上以 BEGIN IMMEDIATE 开启写事务，
   *   会让仪表盘读取阻塞上传与 Worker 写入；
   * - 聚合在数据库内完成，只回传一行，避免把两万多个分组读进内存。
   */
  async storageUsage(): Promise<StorageUsage> {
    const rows = await this.prisma.$queryRaw<StorageUsageRow[]>`
      SELECT
        CAST(SUM(grouped.size_bytes) AS TEXT) AS "totalBytes",
        CAST(
          SUM(CASE WHEN grouped.has_active = 0 THEN grouped.size_bytes ELSE 0 END) AS TEXT
        ) AS "trashBytes"
      FROM (
        SELECT
          MAX(rf."sizeBytes") AS size_bytes,
          MAX(CASE WHEN r."deletedAt" IS NULL THEN 1 ELSE 0 END) AS has_active
        FROM "resource_files" AS rf
        INNER JOIN "resources" AS r ON r."id" = rf."resourceId"
        GROUP BY rf."storagePath"
      ) AS grouped
    `;

    // 空库时 SUM 返回 NULL；CAST AS TEXT 让 SQLite/PostgreSQL 都返回字符串，
    // 避免大整数经驱动转成 number 丢精度。
    const row = rows[0];
    return {
      totalBytes: BigInt(row?.totalBytes ?? '0'),
      trashBytes: BigInt(row?.trashBytes ?? '0'),
    };
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
