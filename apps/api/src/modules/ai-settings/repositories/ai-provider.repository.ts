import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * AI 供应商配置仓储
 * 封装 ai_providers 表数据访问
 */
@Injectable()
export class AiProviderRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 全部配置，当前生效的排在前面 */
  findAll() {
    return this.prisma.aiProvider.findMany({
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
    });
  }

  findById(id: string) {
    return this.prisma.aiProvider.findUnique({ where: { id } });
  }

  /** 当前生效配置（同时仅一条 isActive=true） */
  findActive() {
    return this.prisma.aiProvider.findFirst({ where: { isActive: true } });
  }

  /** 最早的启用配置，用于删除生效配置后自动提升 */
  findFirstEnabled() {
    return this.prisma.aiProvider.findFirst({
      where: { enabled: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  count() {
    return this.prisma.aiProvider.count();
  }

  /**
   * 创建配置。activate=true 时在事务内先清空其它生效标记，保证仅一条生效。
   */
  create(
    data: {
      name: string;
      provider: string;
      baseUrl?: string | null;
      apiKey: string;
      model: string;
      enabled?: boolean;
      isActive?: boolean;
    },
    activate: boolean,
  ) {
    if (!activate) {
      return this.prisma.aiProvider.create({ data });
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.aiProvider.updateMany({
        where: { isActive: true },
        data: { isActive: false },
      });
      return tx.aiProvider.create({ data: { ...data, isActive: true } });
    });
  }

  update(
    id: string,
    data: {
      name?: string;
      provider?: string;
      baseUrl?: string | null;
      apiKey?: string;
      model?: string;
      enabled?: boolean;
    },
  ) {
    return this.prisma.aiProvider.update({ where: { id }, data });
  }

  /**
   * 将指定配置设为生效：事务内清空其它生效标记后置位。
   */
  setActive(id: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.aiProvider.updateMany({
        where: { isActive: true },
        data: { isActive: false },
      });
      return tx.aiProvider.update({
        where: { id },
        data: { isActive: true },
      });
    });
  }

  delete(id: string) {
    return this.prisma.aiProvider.delete({ where: { id } });
  }

  /** 记录连通性测试结果 */
  setTestResult(id: string, status: 'ok' | 'error', error: string | null) {
    return this.prisma.aiProvider.update({
      where: { id },
      data: {
        lastTestedAt: new Date(),
        lastTestStatus: status,
        lastTestError: error,
      },
    });
  }
}
