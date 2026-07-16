import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 来源配置仓储
 * 封装 sources 表数据访问
 */
@Injectable()
export class SourceRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string) {
    return this.prisma.source.findUnique({
      where: { id },
      include: { defaultLicense: { select: { id: true, spdxId: true, name: true } } },
    });
  }

  findBySlug(slug: string) {
    return this.prisma.source.findUnique({ where: { slug } });
  }

  async findMany(params: {
    enabled?: boolean;
    sourceType?: string;
    page?: number;
    pageSize?: number;
  }) {
    const { enabled, sourceType, page = 1, pageSize = 20 } = params;
    const where: Record<string, unknown> = {};
    if (enabled !== undefined) where.enabled = enabled;
    if (sourceType) where.sourceType = sourceType;

    const [items, total] = await Promise.all([
      this.prisma.source.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { defaultLicense: { select: { id: true, spdxId: true, name: true } } },
      }),
      this.prisma.source.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  create(data: {
    name: string;
    slug: string;
    baseUrl?: string;
    sourceType: string;
    enabled?: boolean;
    allowedModes?: string;
    termsUrl?: string;
    robotsUrl?: string;
    defaultLicenseId?: string;
    rateLimitPerMinute?: number;
    maxConcurrency?: number;
    requiresReview?: boolean;
    config?: string;
  }) {
    return this.prisma.source.create({ data });
  }

  update(id: string, data: {
    name?: string;
    slug?: string;
    baseUrl?: string | null;
    sourceType?: string;
    enabled?: boolean;
    allowedModes?: string;
    termsUrl?: string | null;
    robotsUrl?: string | null;
    defaultLicenseId?: string | null;
    rateLimitPerMinute?: number;
    maxConcurrency?: number;
    requiresReview?: boolean;
    config?: string | null;
    lastSyncedAt?: Date | null;
  }) {
    return this.prisma.source.update({ where: { id }, data });
  }

  /**
   * 删除来源：仅允许删除无关联资源的来源
   * 使用事务保证检查与删除的原子性，避免 TOCTOU 竞态
   * 返回 true 表示已删除，false 表示有关联资源无法删除
   */
  async delete(id: string): Promise<{ deleted: boolean; reason?: string }> {
    return this.prisma.$transaction(async (tx) => {
      const source = await tx.source.findUnique({
        where: { id },
        include: {
          resources: { take: 1, select: { id: true } },
          ingestionJobs: { take: 1, select: { id: true } },
          locators: { take: 1, select: { id: true } },
          provenance: { take: 1, select: { id: true } },
        },
      });
      if (!source) return { deleted: false, reason: 'not_found' };
      if (source.resources.length > 0) {
        return { deleted: false, reason: 'has_resources' };
      }
      if (source.ingestionJobs.length > 0) {
        return { deleted: false, reason: 'has_ingestion_jobs' };
      }
      // locators 和 provenance 使用 onDelete: SetNull，删除会丢失溯源数据
      // 如果存在关联记录，拒绝删除以保留溯源信息
      if (source.locators.length > 0) {
        return { deleted: false, reason: 'has_locators' };
      }
      if (source.provenance.length > 0) {
        return { deleted: false, reason: 'has_provenance' };
      }
      await tx.source.delete({ where: { id } });
      return { deleted: true };
    });
  }
}
