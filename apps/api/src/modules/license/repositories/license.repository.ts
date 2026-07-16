import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 许可证仓储
 * 封装 licenses 表数据访问
 */
@Injectable()
export class LicenseRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string) {
    return this.prisma.license.findUnique({ where: { id } });
  }

  findBySpdxId(spdxId: string) {
    return this.prisma.license.findUnique({ where: { spdxId } });
  }

  async findMany(params: {
    requiresAttribution?: boolean;
    page?: number;
    pageSize?: number;
  }) {
    const { requiresAttribution, page = 1, pageSize = 20 } = params;
    const where: Record<string, unknown> = {};
    if (requiresAttribution !== undefined) where.requiresAttribution = requiresAttribution;

    const [items, total] = await Promise.all([
      this.prisma.license.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.license.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  create(data: {
    spdxId?: string;
    name: string;
    url?: string;
    text?: string;
    allowsCommercialUse?: boolean;
    allowsRedistribution?: boolean;
    allowsDerivatives?: boolean;
    requiresAttribution?: boolean;
    shareAlike?: boolean;
  }) {
    return this.prisma.license.create({ data });
  }

  update(id: string, data: {
    spdxId?: string | null;
    name?: string;
    url?: string | null;
    text?: string | null;
    allowsCommercialUse?: boolean | null;
    allowsRedistribution?: boolean | null;
    allowsDerivatives?: boolean | null;
    requiresAttribution?: boolean;
    shareAlike?: boolean;
  }) {
    return this.prisma.license.update({ where: { id }, data });
  }

  /**
   * 删除许可证：仅允许删除无关联资源和来源的许可证
   * 使用事务保证检查与删除的原子性
   */
  async delete(id: string): Promise<{ deleted: boolean; reason?: string }> {
    return this.prisma.$transaction(async (tx) => {
      const license = await tx.license.findUnique({
        where: { id },
        include: {
          resources: { take: 1, select: { id: true } },
          defaultForSources: { take: 1, select: { id: true } },
        },
      });
      if (!license) return { deleted: false, reason: 'not_found' };
      if (license.resources.length > 0) {
        return { deleted: false, reason: 'has_resources' };
      }
      if (license.defaultForSources.length > 0) {
        return { deleted: false, reason: 'has_sources' };
      }
      await tx.license.delete({ where: { id } });
      return { deleted: true };
    });
  }
}
