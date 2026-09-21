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
    });
  }

  findBySlug(slug: string) {
    return this.prisma.source.findUnique({ where: { slug } });
  }

  findDesignReferenceTermsAcceptance(sourceId: string, termsUrl: string, termsHash: string) {
    return this.prisma.designReferenceTermsAcceptance.findFirst({
      where: { sourceId, termsUrl, termsHash },
    });
  }

  /** 返回所有已配置的来源下载目录（去重、舍弃空值） */
  findDownloadDirectories() {
    return this.prisma.source.findMany({
      where: { downloadDirectory: { not: null } },
      select: { downloadDirectory: true },
      orderBy: { downloadDirectory: 'asc' },
    });
  }

  createDesignReferenceTermsAcceptance(data: {
    sourceId: string;
    termsUrl: string;
    termsVersion: string;
    termsHash: string;
    acceptedBy: string;
  }) {
    return this.prisma.designReferenceTermsAcceptance.create({ data });
  }

  /** 查询所有开启了定时自动同步的来源（autoSyncIntervalHours 非空），从未同步/最久未同步优先 */
  findAutoSyncEnabled() {
    return this.prisma.source.findMany({
      where: { autoSyncIntervalHours: { not: null } },
      orderBy: { lastSyncedAt: 'asc' },
    });
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
    rateLimitPerMinute?: number;
    downloadIntervalMs?: number;
    maxConcurrency?: number;
    requiresReview?: boolean;
    config?: string;
    autoSyncIntervalHours?: number | null;
    downloadDirectory?: string | null;
  }) {
    return this.prisma.source.create({ data });
  }

  update(
    id: string,
    data: {
      name?: string;
      slug?: string;
      baseUrl?: string | null;
      sourceType?: string;
      enabled?: boolean;
      allowedModes?: string;
      termsUrl?: string | null;
      robotsUrl?: string | null;
      rateLimitPerMinute?: number;
      downloadIntervalMs?: number;
      maxConcurrency?: number;
      requiresReview?: boolean;
      config?: string | null;
      autoSyncIntervalHours?: number | null;
      downloadDirectory?: string | null;
      lastSyncedAt?: Date | null;
      lastSyncStatus?: string | null;
      lastSyncError?: string | null;
    },
  ) {
    return this.prisma.source.update({ where: { id }, data });
  }

  /** 记录一次同步结果（成功/失败 + 错误信息），供 UI 展示 */
  updateSyncResult(
    id: string,
    data: { lastSyncedAt: Date; lastSyncStatus: string; lastSyncError?: string | null },
  ) {
    return this.prisma.source.update({
      where: { id },
      data: {
        lastSyncedAt: data.lastSyncedAt,
        lastSyncStatus: data.lastSyncStatus,
        lastSyncError: data.lastSyncError ?? null,
      },
    });
  }

  /**
   * 删除来源。
   *
   * 方案 B：来源删除后，通过外键 onDelete 规则自动处理关联数据——资源的
   * sourceId、ResourceLocator/ResourceProvenance/IngestionJob 的 sourceId 被
   * SetNull（资源及其他关联记录保留，仅失去来源溯源信息）；设计参考的
   * DesignReferenceTermsAcceptance / DesignReferenceQuota 被 Cascade 连带删除。
   *
   * 事务保证检查与删除的原子性，避免 TOCTOU 竞态。
   */
  async delete(id: string): Promise<{ deleted: boolean; reason?: string }> {
    return this.prisma.$transaction(async (tx) => {
      const source = await tx.source.findUnique({ where: { id } });
      if (!source) return { deleted: false, reason: 'not_found' };
      await tx.source.delete({ where: { id } });
      return { deleted: true };
    });
  }
}
